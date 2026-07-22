import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const maxDuration = 60;

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

const ExtractedItemSchema = z.object({
  name: z.string().describe("Clean, descriptive item name"),
  category: z
    .enum(["Beads", "Cabochons", "Findings", "Wire", "Stringing", "Tools", "Other"])
    .describe("Material category"),
  quantity_purchased: z
    .string()
    .describe('Quantity as purchased, e.g. "2 strands" or "1 spool"'),
  total_price: z
    .number()
    .describe("Total price paid for this line item, after any discounts"),
  estimated_units: z
    .number()
    .describe("Estimated individual usable units (bead count, inches of wire, etc.)"),
  unit_type: z.string().describe("Unit of measure: piece, inch, gram, etc."),
  unit_cost: z.number().describe("Price per unit: total_price / estimated_units"),
});

const ReceiptExtractionSchema = z.object({
  items: z.array(ExtractedItemSchema),
  notes: z
    .string()
    .nullable()
    .describe("Anything ambiguous or worth flagging about the extraction, or null"),
});

const EXTRACTION_PROMPT = `Extract jewelry-making materials from this receipt or invoice.

For each line item:
- Apply any shop discounts, sales, or percentage-off deals shown on the receipt to the item price. For example, if an item shows $30.00 but there's a 70% shop discount, the actual price paid was $9.00.
- For bead strands, estimate the bead count from strand length and bead size (e.g. a 15" strand of 8mm beads is about 48 beads; a 16" strand of 6mm beads is about 67 beads).
- For wire or cord spools, estimate the total length in inches.
- Compute unit_cost as total_price divided by estimated_units.

Ignore non-material lines like shipping, taxes, and store credit. Only include materials that would be used to make jewelry. If the document doesn't appear to be a receipt or contains no jewelry materials, return an empty items array and explain in notes.`;

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let body: { data?: string; mediaType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { data, mediaType } = body;
  if (!data || !mediaType) {
    return NextResponse.json(
      { error: "Request must include base64 `data` and `mediaType`." },
      { status: 400 }
    );
  }

  const isPdf = mediaType === "application/pdf";
  const isImage = ACCEPTED_IMAGE_TYPES.includes(mediaType as AcceptedImageType);
  if (!isPdf && !isImage) {
    return NextResponse.json(
      { error: `Unsupported file type: ${mediaType}. Upload an image or PDF.` },
      { status: 400 }
    );
  }

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

  try {
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
  }
}
