import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BeadVisualSchema } from "@/lib/bead-visual";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { authorizedUser, isOwnUpload } from "@/lib/api-token";
import { enforceRateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

// Derives a photo-accurate visual spec for one material from a close-up
// photo the user uploaded (GRA-9). Same transient-storage flow as receipt
// processing: the client uploads to the receipts bucket, this route gets
// only the path and deletes the file in a finally block. The client writes
// the returned visual to the DB itself.

const BUCKET = "receipts";
// Path ownership and shape are checked with isOwnUpload() in POST.
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"] as const;
const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

const RequestSchema = z.object({
  path: z.string().min(1).max(200),
  mediaType: z.enum(ACCEPTED_IMAGE_TYPES),
  material_name: z.string().min(1).max(300),
});

const ResponseSchema = z.object({
  visual: BeadVisualSchema,
});

const promptFor = (name: string) => `This photo shows the jewelry material named "${name}" up close. Produce the visual spec for drawing one element of it on a virtual beading board.

- The photo is the primary evidence: read the true colors, secondary color, finish (matte/glossy/metallic/pearl/transparent), pattern (solid/marbled/speckled/banded), faceting, and shape directly from it. Prefer what you see over what the name implies.
- Dimensions: use sizes stated in the name when present; otherwise estimate from the photo's context (fingers, rulers, strand curvature) or typical sizes for the item type. length_mm runs along the stringing hole; width_mm is the visible diameter. For 'chain', length_mm is always 25.4 (one 1-inch segment).
- Non-bead components use the component shapes: 'chain', 'jump-ring', 'lobster-clasp', 'toggle-clasp', 'connector' (bar with end loops), 'figure-eight' (infinity links), 'triangle' (triangle charms), 'cabochon' (flat-backed focal stones; length_mm is the long axis), 'bezel' (bezel settings / pendant blanks — length_mm/width_mm are the recess the stone fits), 'bail' (pinch bails — length_mm is the width along the strand).
- For cabochons and bezel settings, set 'outline' to the face (or recess) shape you see: 'oval' (also round), 'rectangle' (also square/cushion), 'triangle', 'pentagon', 'hexagon', 'teardrop', 'marquise', 'stalactite' (lumpy slice with concentric rings), 'trapiche' (six radial spokes), or 'freeform'. Null for every other shape.`;

// Storage calls run with the caller's session token: the receipts bucket is
// authenticated-only since the 0006 lockdown and owner-scoped since 0011, and
// the route holds no service key. authorizedUser() has already validated the
// header (and isOwnUpload() the path against its id) by the time this runs.
function storageConfig(authHeader: string | null) {
  const config = getSupabaseConfig();
  if (!config || !authHeader) return null;
  return {
    objectUrl: `${config.url}/storage/v1/object/${BUCKET}`,
    headers: { Authorization: authHeader, apikey: config.key },
  };
}

export async function POST(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const limited = await enforceRateLimit(request, "analyze-photo");
  if (limited) return limited;
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Body must include a storage path, an image mediaType, and material_name." },
      { status: 400 }
    );
  }
  if (!isOwnUpload(body.path, user.id, IMAGE_EXTENSIONS)) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  const storage = storageConfig(request.headers.get("authorization"));
  if (!storage) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const download = await fetch(`${storage.objectUrl}/${body.path}`, {
      headers: storage.headers,
    });
    if (!download.ok) {
      return NextResponse.json(
        { error: `Could not read the uploaded photo (${download.status}).` },
        { status: 400 }
      );
    }
    const data = Buffer.from(await download.arrayBuffer()).toString("base64");

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: body.mediaType as AcceptedImageType,
                data,
              },
            },
            { type: "text", text: promptFor(body.material_name) },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(ResponseSchema) },
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The model declined to process this photo." },
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

    return NextResponse.json(parsed);
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
    // Photos are transient — clean up regardless of outcome.
    await fetch(`${storage.objectUrl}/${body.path}`, {
      method: "DELETE",
      headers: storage.headers,
    }).catch(() => {});
  }
}
