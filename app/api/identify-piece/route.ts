import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { authorizedUser, isOwnUpload } from "@/lib/api-token";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { enforceRateLimit } from "@/lib/rate-limit";
import { NAMING_CONVENTION } from "@/lib/naming";
import {
  IdentifyRequestSchema,
  IdentifyResponseSchema,
  sanitizeIdentification,
  type IdentifyRequest,
} from "@/lib/identify";

export const maxDuration = 300;

// Identifies the materials in a photographed finished piece (GRA-12): the
// distinct materials, and the order they sit on the strand. Photos use the
// same transient receipts-bucket flow as analyze-photo; the route deletes them
// in a finally block, and the client keeps its own copy for the design.

const BUCKET = "receipts";
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"] as const;

// Storage calls run with the caller's session token, as in analyze-photo: the
// route holds no service key, and the bucket policies scope access to the
// caller's own folder.
function storageConfig(authHeader: string | null) {
  const config = getSupabaseConfig();
  if (!config || !authHeader) return null;
  return {
    objectUrl: `${config.url}/storage/v1/object/${BUCKET}`,
    headers: { Authorization: authHeader, apikey: config.key },
  };
}

function promptFor(request: IdentifyRequest): string {
  const description = request.description?.trim()
    ? `The owner describes the piece as: "${request.description.trim()}". Treat this as a hint; the photos are the authority when they disagree.`
    : "The owner gave no description. Work from the photos alone.";

  return `You are identifying the materials in a finished handmade beaded necklace so it can be recreated on a virtual beading board.

PHOTOS: the first photo is normally the full strand, flat, often with a ruler for scale. Later photos are close-ups and may show any part of the strand. ${description}

WHAT TO REPORT
- "materials": one entry per distinct material: each bead type, each stone or pendant, each spacer, and any hardware strung between the beads (bails, ring connectors, metal spacers). Do not list the clasp or the chain at the ends. A pendant or focal stone is kind "stone"; other beads are "bead"; hardware is "hardware".
- Give each material a short unique "ref" such as "m1".
- A material is one stone or bead type. If the strand mixes stones or colors (for example tiger's eye and red jasper beads of one size), report each stone as its own material. Never write one name that combines them, and never use "Mixed", "Assorted", a slash, or "or".
- If you cannot tell two similar stones apart, name the one you are more confident of, give it confidence "low", and leave the other out of the name.
- "strand": the ref of every element in order from one end of the strand to the other, repeating a ref each time that material appears. Count carefully, including repeats and mirrored halves. Use only refs from "materials".
- "strand_length_in": the end-to-end length in inches, from the ruler or the description when given, else null.

NAMING (the same standard the receipt import uses)
${NAMING_CONVENTION}
FOR EACH MATERIAL, CHOOSE ONE OF THREE OUTCOMES
1. Same as an owned inventory item (same stone family, shape and size): set matched_material_id to that item's id. Match only when you are confident. Look-alikes such as tiger iron vs tiger's eye, or jasper vs agate, are different materials.
2. A generic finding in the catalog (jump rings, crimp beads, spacer balls, lobster or toggle clasps): set generic_key to its key.
3. Otherwise a new material: matched_material_id and generic_key null.
- Whatever the outcome, set visual to the physical spec of one element (see below). The owner may decide a match is really a different material, and then the spec is used.
- If a new material is clearly from one of the unsplit lots below, set lot_id to that lot's id; otherwise null. Lots hold bulk stones, so only set it when the listing clearly fits.
- Never invent ids or keys. Use only the ids and keys listed.

VISUAL SPEC
- Sizes: use the ruler, the pendant or a stated size. length_mm runs along the stringing hole; width_mm is the visible diameter across it.
- A chain element is always one 1-inch segment: length_mm is 25.4.
- Cabochons and bezels: set outline to the face shape (oval, rectangle, triangle, pentagon, hexagon, teardrop, marquise, stalactite, trapiche or freeform). Null for other shapes.
- Components: use the component shapes ('chain', 'jump-ring', 'lobster-clasp', 'toggle-clasp', 'connector', 'figure-eight', 'triangle', 'cabochon', 'bezel', 'bail').
- Read color, finish, pattern and faceting from the photos, and prefer what you see over what the name implies.

INVENTORY (owned, placeable; match against these)
${JSON.stringify(request.inventory)}

UNSPLIT LOTS (bulk purchases not yet broken into materials)
${JSON.stringify(request.lots)}

GENERIC CATALOG (hardware keys)
${JSON.stringify(request.generics)}`;
}

export async function POST(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: IdentifyRequest;
  try {
    body = IdentifyRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Body must include 1–4 uploaded photos and the inventory, lots and generics lists." },
      { status: 400 }
    );
  }

  // The photos are already uploaded by now, so every path from here on must
  // remove them, including the early returns below.
  const storage = storageConfig(request.headers.get("authorization"));
  try {
    const limited = await enforceRateLimit(request, "identify-piece");
    if (limited) return limited;
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not configured on the server." },
        { status: 500 }
      );
    }
    if (!body.photos.every((p) => isOwnUpload(p.path, user.id, IMAGE_EXTENSIONS))) {
      return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
    }
    if (!storage) {
      return NextResponse.json(
        { error: "Supabase is not configured on the server." },
        { status: 500 }
      );
    }

    const images = [];
    for (const photo of body.photos) {
      const download = await fetch(`${storage.objectUrl}/${photo.path}`, {
        headers: storage.headers,
      });
      if (!download.ok) {
        return NextResponse.json(
          { error: `Could not read an uploaded photo (${download.status}).` },
          { status: 400 }
        );
      }
      const data = Buffer.from(await download.arrayBuffer()).toString("base64");
      images.push({
        type: "image" as const,
        source: { type: "base64" as const, media_type: photo.mediaType, data },
      });
    }

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [...images, { type: "text", text: promptFor(body) }],
        },
      ],
      output_config: { effort: "high", format: zodOutputFormat(IdentifyResponseSchema) },
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The model declined to process these photos." },
        { status: 422 }
      );
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return NextResponse.json(
        { error: "Could not parse a structured result from the model." },
        { status: 502 }
      );
    }

    const result = sanitizeIdentification(parsed, {
      inventoryIds: new Set(body.inventory.map((m) => m.id)),
      lotIds: new Set(body.lots.map((l) => l.id)),
      genericKeys: new Set(body.generics.map((g) => g.key)),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Rate limited by the Anthropic API. Try again in a minute." },
        { status: 429 }
      );
    }
    if (error instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Anthropic API error (${error.status}): ${error.message}` },
        { status: 502 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    // Photos are transient: remove every one, whatever the outcome.
    if (storage) {
      await Promise.all(
        body.photos.map((photo) =>
          fetch(`${storage.objectUrl}/${photo.path}`, {
            method: "DELETE",
            headers: storage.headers,
          }).catch(() => {})
        )
      );
    }
  }
}
