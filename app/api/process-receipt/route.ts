import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BeadVisualSchema } from "@/lib/bead-visual";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { isAuthorized } from "@/lib/api-token";
import { CATEGORIES } from "@/lib/types";

// Long receipts can take a few minutes with adaptive thinking; keep this above
// the SDK-side timeout so Vercel doesn't kill the function mid-generation and
// skip the `finally` cleanup below.
export const maxDuration = 300;

const RECEIPTS_BUCKET = "receipts";

// Matches exactly what the client generates: crypto.randomUUID() + extension.
const STORAGE_PATH_RE = /^[0-9a-f-]{36}\.(pdf|jpe?g|png|gif|webp)$/i;

// The route talks to the Storage REST API directly instead of supabase-js:
// it only needs download + delete, and supabase-js requires a native
// WebSocket at construction time, which breaks server-side on Node < 22
// (this project targets Node 24 — see .nvmrc — but keep the route free of
// supabase-js anyway).
// Storage calls run with the caller's session token: the receipts bucket is
// authenticated-only since the 0006 lockdown, and the route holds no service
// key. isAuthorized() has already validated the header by the time this runs.
function storageConfig(authHeader: string | null) {
  const config = getSupabaseConfig();
  if (!config || !authHeader) return null;
  return {
    objectUrl: `${config.url}/storage/v1/object/${RECEIPTS_BUCKET}`,
    headers: { Authorization: authHeader, apikey: config.key },
  };
}

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

const ExtractedItemSchema = z.object({
  name: z
    .string()
    .describe(
      'Standardized name in the fixed slot order "[Material] [Type] [Size] [Shape] [Cut]", e.g. "Kyanite Beads 3mm Round Faceted" — no descriptive colors unless part of the stone\'s name, cut words last'
    ),
  category: z
    .string()
    .describe(
      "Material category — one of: Beads, Cabochons, Findings, Wire, Stringing, Tools, Other. Chain, settings, bails, clasps, and charms are Findings."
    ),
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
  source: z
    .object({
      listing_title: z
        .string()
        .describe("The line item's title as printed on the receipt (no cleanup; first 120 characters are enough)"),
      variation: z
        .string()
        .nullable()
        .describe(
          'Variation / personalization / selection text exactly as printed, e.g. "Iron Tiger Eye Gemstone: IR3896 30X24X5MM43CT" or "Length: 6MM 7.5\" · Qty Package: 1" (first 120 characters); null when the line has none'
        ),
      line_price: z
        .number()
        .describe("Price paid for the whole line after discounts (equals total_price for an unsplit line)"),
      page: z
        .number()
        .nullable()
        .describe("1-based page of the receipt the line appears on; null if unknown"),
    })
    .describe("Provenance: what the receipt actually said, so the item can be traced back later"),
  visual: BeadVisualSchema.nullable().describe(
    "Visual spec for anything that can sit on a strand: beads, spacers, chains, clasps, jump rings, connectors, and cabochons. Use the product photos on the receipt when present — especially for color and finish. Null only for items that never appear on a strand (wire, cord, thread, tools)."
  ),
});

// The model occasionally invents a category ("Chain", "Bezel"); one bad
// value must not sink a 30-line receipt, so category is free text in the
// schema and normalized here instead of enum-validated. Exact (case-
// insensitive) matches map to CATEGORIES; these synonyms cover the rest.
const CATEGORY_SYNONYMS: Record<string, string> = {
  bead: "Beads",
  cabochon: "Cabochons",
  finding: "Findings",
  chain: "Findings",
  clasp: "Findings",
  setting: "Findings",
  bezel: "Findings",
  blank: "Findings",
  mounting: "Findings",
  bail: "Findings",
  charm: "Findings",
  cord: "Stringing",
  thread: "Stringing",
  tool: "Tools",
};
function normalizeCategory(raw: string): string {
  const key = raw.trim().toLowerCase();
  const exact = CATEGORIES.find((c) => c.toLowerCase() === key);
  if (exact) return exact;
  return CATEGORY_SYNONYMS[key] ?? CATEGORY_SYNONYMS[key.replace(/s$/, "")] ?? "Other";
}

const OrderSchema = z.object({
  platform: z
    .string()
    .describe('Marketplace or store: "Etsy", "Amazon", "Fire Mountain Gems", or the store name'),
  seller: z
    .string()
    .describe("Shop / seller name on a marketplace order (e.g. the Etsy shop); empty string for a direct store"),
  order_number: z.string().describe("Order or invoice number exactly as printed"),
  order_date: z
    .string()
    .nullable()
    .describe("Order date as YYYY-MM-DD, or null if not shown"),
  total: z.number().nullable().describe("Order total actually charged, or null"),
});

const ReceiptExtractionSchema = z.object({
  order: OrderSchema.nullable().describe(
    "The order this receipt documents; null only if the document has no order header at all"
  ),
  items: z.array(ExtractedItemSchema),
  notes: z
    .string()
    .nullable()
    .describe("Anything ambiguous or worth flagging about the extraction, or null"),
});

const EXTRACTION_PROMPT = `Extract jewelry-making materials from this receipt or invoice.

NAMING CONVENTION — every item name follows these slots, in this order, nothing else:
[Material] [Type] [Size] [Shape] [Cut]
Examples: "Kyanite Beads 3mm Round Faceted", "Galaxy Tiger Eye Beads 8mm Round", "Toho Seed Beads 11/0 Pale Honey Luster", "Iron Tiger Eye Cabochon 30x24mm Oval", "Antique Silver Bezel Setting 27mm Round", "Hematite Beads 4x2mm Arrow", "Sterling Silver Chain 2mm Cable", "Gold Spacer Beads 4mm Round".
- Material: the stone or metal. Keep a variety, finish, or treatment word only when it is part of the stone's trade name or separates two distinct varieties (Black Agate, Ocean Jasper, Galaxy Tiger Eye, Champagne Gold Hematite, Light Green Garnet vs Moss Green Garnet, Synthetic Hematite, Monarch Opal Doublet). Drop plain descriptive colors — "Blue Kyanite" is "Kyanite", "Dark Red Garnet" is "Garnet"; the stored visual carries color. For metal findings the plating IS the material (Antique Silver, Gold, Gunmetal, Rhodium, Sterling Silver).
- Type: Beads, Seed Beads, Spacer Beads, Cabochon, Bezel Setting, Pinch Bail, Chain, Clasp, Charms, Jump Rings, Connector, Links, Cord, Wire, Thread.
- Size: millimeters; "LxW" for non-round; ranges like "3-4mm"; seed beads by aught ("11/0"); cabochons by face ("30x24mm"); chain by link size.
- Shape: Round, Rondelle, Cube, Tube, Chip, Nugget, Arrow, Teardrop, Oval, Hexagon, Bicone, Flower… Omit only where the type implies it (Seed Beads, Chain, Cord).
- Cut, last: Faceted, Star Cut, Matte, AB — omitted when smooth. "Faceted" always comes after the shape ("Round Faceted", never "Faceted Round").
- Seed beads: "Toho Seed Beads 11/0" + the color name as the maker prints it ("Pale Honey Luster"); no color codes — those belong in the provenance fields.
- Never include pack counts or quantities in the name (no "1200Pcs", "50-Pack") — quantity is a separate field.
- Strip marketing language ("Premium", "Genuine", "Grade AAA", "for Jewelry Making DIY", brand slogans). Keep only what identifies the material.

SPLITTING ASSORTMENTS — this is important:
- If a line item contains multiple distinct variants (different sizes, colors, materials, or finishes), split it into one extracted item per variant. Example: "1200Pcs Smooth Round Spacer Beads (4mm, 6mm, 8mm, Silver & Gold)" is 6 distinct items — silver and gold in each of the three sizes.
- This includes mixed strands: a strand whose beads are separable into distinct colors or stones is an assortment even if the listing sells it as one item. "Yellow Red Blue Tiger's Eye Beads" is 3 items (yellow, red, and blue tiger's eye); "Aquamarine Rose Quartz Amethyst Beads" is 3 items (one per stone). This applies even when the beads are the same base material or dyed — a mixed-color strand of dyed cat's eye or tiger's eye still splits into one item per color. The product photo is the deciding evidence: if a jeweler could sort the beads into piles by color, split them; the test is per-bead, not per-strand.
- Do NOT split stones that are multicolored within each individual bead — mookaite, ocean jasper, cherry blossom agate, rhodochrosite banding, rainbow moonstone flash, and the like. Every bead shows the same mix, so it is one material; keep it as a single item (this is the only case where "Multicolor" belongs in a name).
- Divide the total quantity evenly across variants unless the listing states a per-variant count (1200 beads across 6 variants = 200 each).
- Allocate the line item's price across variants in proportion to their unit counts, and compute unit_cost per variant.

PICK-YOUR-STONE CABOCHONS — one-of-a-kind stones sold through generic listings:
- Stone shops sell individual cabochons through listings where the buyer picks a specific stone from a photo; the title is then generic (often plural, "Mix Shapes", or keyword-stuffed) and the actual stone is identified only by the variation/personalization line. Selection formats seen in the wild: "IR3896 30X24X5MM43CT" (lot code + L×W×H mm + carat weight), "ITEM CODE: SF-2996 24X11X4 mm", "Number: 11. 25x25x5 mm", "Price & details: 4. 38x23x6 MM, 38 CT", "Choose Your Favorite Number: 1421. 21X12X6 MM", or a calibrated-size choice like "Sizes: 9 mm".
- When such a selection is present, the item is ONE specific stone: quantity_purchased is "1 stone", estimated_units 1, unit_cost = the discounted line price. Take the dimensions from the variation, never the title: "Iron Tiger Eye Cabochon 30x24mm" (drop the height/thickness and the carat weight from the name; a shape word like Oval/Teardrop/Freeform may follow if the receipt photo shows it clearly — omit it rather than guess).
- Identical titles on multiple lines are DIFFERENT one-of-a-kind stones (their selection codes differ) — extract each separately, never merge.
- If the variation names a different stone than the title, trust the variation; seller dropdowns are mislabeled more often than buyer selections.
- A matched "pair" listing is 2 physical stones on one line: quantity 2, estimated_units 2, unit_cost = half the line price.
- Never put lot/selection codes (IR3896, SF-1126, i-2985…) in the name — they identify the listing, not the material.
- Calibrated-stone listings (exact size chosen from a dropdown, Etsy quantity may exceed 1) use the chosen size in the name and the real Etsy quantity.

PENDANT BLANKS, BEZEL SETTINGS, AND BAILS:
- Bezel blanks / cabochon bases / pendant settings / mountings are Findings. Name them by finish + type + the RECESS size (the stone they fit), not the outer size: "Antique Silver Plated Brass Mountings 44x37 mm (27 mm blank)" → "Antique Silver Bezel Setting 27mm Round"; "Setting For 30mm Cab, 46x31mm overall" → "Platinum Bezel Setting 30mm Round". Keep the recess shape (Round, Oval, Teardrop, Hexagon…) when stated.
- Bails (pinch bails, pendant bails, leaf/flower/branch bails) are Findings named finish + "Pinch Bail" + size/style: "Rhodium Sterling Silver Pinch Bail Small Branch".
- The Etsy quantity is almost always 1 for these; the real count is in the variation ("Select Pieces: 5 pcs", "Number of Settings: 5", "quantity: 10 pieces") or a leading number in the title ("10 Hexagonal Charms"). Use it for estimated_units.
- A setting sold WITH a glass cabochon is still one item (the setting); mention the included stone in notes.

PROVENANCE — fill in for every item, and the order header:
- order: platform, shop/seller, order number, date (YYYY-MM-DD), and the total charged. Multi-shop marketplace checkouts print one shop per receipt: use that shop's order number and its own total, not the combined purchase.
- source.listing_title and source.variation are verbatim copies of what the receipt shows — do not normalize them; they're how a stone gets traced back to its listing later. source.line_price is the discounted price for the whole line (an assortment split into variants carries the same line_price on each variant, with total_price being the variant's share). source.page is the receipt page the line is printed on.

NON-SUPPLY LINES:
- Finished jewelry (a completed necklace, bracelet, or pendant-on-chain sold ready to wear) is not a material: category "Other", and flag it in notes.
- Tools (pliers, organizers, glue) get category "Tools" and a null visual.

PRICING:
- Apply any shop discounts, sales, or percentage-off deals shown on the receipt. If an item shows $30.00 with a 70% shop discount, the price paid was $9.00.

VISUALS:
- For each item that can sit on a strand — beads, spacers, chains, clasps, jump rings, connectors, cabochons — fill in the visual spec. Product photos on the receipt are the best source for color, finish, and pattern — use them when present; otherwise infer from the material name (e.g. ocean jasper is typically mottled sea-green).
- When splitting an assortment, give each variant its own visual (the "Silver" variants get silver coloring, the 4mm variants get 4mm dimensions, and so on).
- length_mm is the dimension along the stringing hole (a 8x4mm rondelle advances the strand 4mm); width_mm is the visible diameter.
- Non-bead components use the component shapes: 'chain' (length_mm always 25.4 — one element is a 1-inch segment), 'jump-ring', 'lobster-clasp', 'toggle-clasp', 'connector' (bar with end loops), 'figure-eight' (infinity links), 'triangle' (triangle charms), 'cabochon', 'bezel' (settings/blanks), 'bail' (pinch bails). Metal findings are almost always metallic finish.
- Bezel settings: shape 'bezel', length_mm/width_mm = the recess dimensions. Bails: shape 'bail', length_mm = the bail's width along the strand, width_mm its height (a "small" pinch bail is roughly 5x8mm, "big" about 8x14mm). Both metallic, colored by the plating.
- Cabochons: shape 'cabochon', length_mm = the stone's longer face dimension, width_mm = the shorter (thickness is not rendered). Color and pattern from the receipt photo of the specific stone whenever one is shown.
- Cabochon drill: 'top' for "top drilled"/"top-drilled"; 'center' for "center drilled" or "drilled through"; 'front-back' when the listing or photo shows a hole through the face; 'none' for plain undrilled cabs (the default for stone-shop cabs). A personalization like "drill style A/C/D" means drilled in a shop-specific way — use null and mention it in notes rather than guessing.

ESTIMATING UNITS:
- For bead strands, estimate bead count from strand length and bead size (a 15" strand of 8mm beads is about 48 beads; a 16" strand of 6mm beads is about 67 beads).
- For wire or cord spools, estimate total length in inches.

Ignore lines with no physical goods — shipping, taxes, store credit, coupons. Do NOT drop tools or finished-jewelry lines; categorize those per NON-SUPPLY LINES above. If the document doesn't appear to be a receipt or contains no jewelry materials, return an empty items array and explain in notes.`;

export async function POST(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
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
  if (!STORAGE_PATH_RE.test(path)) {
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

  const storage = storageConfig(request.headers.get("authorization"));
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
    // Streamed so the SDK's 10-minute non-streaming cap doesn't bound
    // max_tokens: adaptive thinking plus a 40-line receipt's verbatim
    // provenance overflowed a non-streaming budget and truncated the JSON.
    // The stream helper applies the zod output format itself and exposes the
    // result as parsed_output; a truncated or invalid response rejects
    // finalMessage() with an AnthropicError (handled in the catch below).
    const response = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: [fileBlock, { type: "text", text: EXTRACTION_PROMPT }],
          },
        ],
        output_config: { format: zodOutputFormat(ReceiptExtractionSchema) },
      })
      .finalMessage();

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

    return NextResponse.json({
      ...parsed,
      items: parsed.items.map((item) => ({
        ...item,
        category: normalizeCategory(item.category),
      })),
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Rate limited by the Anthropic API. Try again in a minute." },
        { status: 429 }
      );
    }
    if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
      // Structured-output parse failure (truncated or schema-invalid JSON).
      return NextResponse.json(
        { error: "Could not parse a structured result from the model — try again." },
        { status: 502 }
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
