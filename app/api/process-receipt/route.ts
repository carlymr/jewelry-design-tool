import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BeadVisualSchema } from "@/lib/bead-visual";

export const maxDuration = 120;

const RECEIPTS_BUCKET = "receipts";

// The route talks to the Storage REST API directly instead of supabase-js:
// it only needs download + delete, and supabase-js requires a native
// WebSocket at construction time, which breaks server-side on Node < 22.
function storageConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return {
    objectUrl: `${url}/storage/v1/object/${RECEIPTS_BUCKET}`,
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  };
}

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

const ExtractedItemSchema = z.object({
  name: z
    .string()
    .describe(
      'Standardized name following "[Material/Color] [Item Type] [Size] [Shape/Detail]", e.g. "Gold Spacer Beads 4mm Round"'
    ),
  category: z
    .enum(["Beads", "Cabochons", "Findings", "Wire", "Stringing", "Tools", "Other"])
    .describe("Material category"),
  quantity_purchased: z
    .string()
    .describe('Quantity as purchased for this variant, e.g. "200 beads" or "1 spool"'),
  total_price: z
    .number()
    .describe(
      "Price allocated to this variant after discounts (a split line item divides its price across variants)"
    ),
  estimated_units: z
    .number()
    .describe("Estimated individual usable units for this variant (bead count, inches, etc.)"),
  unit_type: z.string().describe("Unit of measure: piece, inch, gram, etc."),
  unit_cost: z.number().describe("Price per unit: total_price / estimated_units"),
  visual: BeadVisualSchema.nullable().describe(
    "Visual spec for beads, spacers, and other components that would be strung on a strand. Use the product photos on the receipt when present — especially for color and finish. Null for non-strand items (wire, cord, tools, most findings)."
  ),
});

const ReceiptExtractionSchema = z.object({
  items: z.array(ExtractedItemSchema),
  notes: z
    .string()
    .nullable()
    .describe("Anything ambiguous or worth flagging about the extraction, or null"),
});

const EXTRACTION_PROMPT = `Extract jewelry-making materials from this receipt or invoice.

NAMING CONVENTION — every item name must follow this pattern:
[Material/Color] [Item Type] [Size] [Shape/Detail]
Examples: "Gold Spacer Beads 4mm Round", "Sterling Silver Wire 20ga", "Ocean Jasper Beads 8mm Round", "Silver Lobster Clasp 12mm".
- Never include pack counts or quantities in the name (no "1200Pcs", "50-Pack") — quantity is a separate field.
- Strip marketing language ("Premium", "for Jewelry Making DIY", brand slogans). Keep only what identifies the material.

SPLITTING ASSORTMENTS — this is important:
- If a line item contains multiple distinct variants (different sizes, colors, materials, or finishes), split it into one extracted item per variant. Example: "1200Pcs Smooth Round Spacer Beads (4mm, 6mm, 8mm, Silver & Gold)" is 6 distinct items — silver and gold in each of the three sizes.
- Divide the total quantity evenly across variants unless the listing states a per-variant count (1200 beads across 6 variants = 200 each).
- Allocate the line item's price across variants in proportion to their unit counts, and compute unit_cost per variant.

PRICING:
- Apply any shop discounts, sales, or percentage-off deals shown on the receipt. If an item shows $30.00 with a 70% shop discount, the price paid was $9.00.

VISUALS:
- For each bead/spacer/strand-component item, fill in the visual spec. Product photos on the receipt are the best source for color, finish, and pattern — use them when present; otherwise infer from the material name (e.g. ocean jasper is typically mottled sea-green).
- When splitting an assortment, give each variant its own visual (the "Silver" variants get silver coloring, the 4mm variants get 4mm dimensions, and so on).
- length_mm is the dimension along the stringing hole (a 8x4mm rondelle advances the strand 4mm); width_mm is the visible diameter.

ESTIMATING UNITS:
- For bead strands, estimate bead count from strand length and bead size (a 15" strand of 8mm beads is about 48 beads; a 16" strand of 6mm beads is about 67 beads).
- For wire or cord spools, estimate total length in inches.

Ignore non-material lines like shipping, taxes, and store credit. Only include materials that would be used to make jewelry. If the document doesn't appear to be a receipt or contains no jewelry materials, return an empty items array and explain in notes.`;

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let body: { path?: string; mediaType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { path, mediaType } = body;
  if (!path || !mediaType) {
    return NextResponse.json(
      { error: "Request must include a storage `path` and `mediaType`." },
      { status: 400 }
    );
  }
  if (path.includes("..") || path.includes("/")) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  const isPdf = mediaType === "application/pdf";
  const isImage = ACCEPTED_IMAGE_TYPES.includes(mediaType as AcceptedImageType);
  if (!isPdf && !isImage) {
    return NextResponse.json(
      { error: `Unsupported file type: ${mediaType}. Upload an image or PDF.` },
      { status: 400 }
    );
  }

  const storage = storageConfig();
  if (!storage) {
    return NextResponse.json(
      { error: "Supabase is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const download = await fetch(`${storage.objectUrl}/${path}`, {
      headers: storage.headers,
    });
    if (!download.ok) {
      return NextResponse.json(
        { error: `Could not read the uploaded file (${download.status}).` },
        { status: 400 }
      );
    }

    const data = Buffer.from(await download.arrayBuffer()).toString("base64");

    const fileBlock: Anthropic.ContentBlockParam = isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as AcceptedImageType,
            data,
          },
        };

    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [fileBlock, { type: "text", text: EXTRACTION_PROMPT }],
        },
      ],
      output_config: { format: zodOutputFormat(ReceiptExtractionSchema) },
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The model declined to process this document." },
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
    // Receipts are transient — clean up regardless of outcome.
    await fetch(`${storage.objectUrl}/${path}`, {
      method: "DELETE",
      headers: storage.headers,
    }).catch(() => {});
  }
}
