import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { isAuthorized } from "@/lib/api-token";

export const maxDuration = 60;

// Generates an Etsy listing draft from an actual design's composition (exact
// materials and counts from the strand), not a free-text description. The
// client keeps the result editable and writes it to designs.listing itself.

const RequestSchema = z.object({
  design_name: z.string().min(1),
  materials: z
    .array(z.object({ name: z.string().min(1), quantity: z.number().positive() }))
    .min(1)
    .max(100),
  price: z.number().nonnegative(),
  labor_hours: z.number().nonnegative().optional(),
  length_in: z.number().positive().optional(),
  style_guidelines: z.string().max(2000).optional(),
});

const ListingSchema = z.object({
  title: z
    .string()
    .describe("SEO-optimized Etsy listing title, 140 characters or fewer"),
  description: z.string()
    .describe(
      "Full product description: the piece, its materials, dimensions, and care instructions. Plain text with blank lines between paragraphs — no markdown."
    ),
  tags: z
    .array(z.string().describe("Etsy SEO tag, 20 characters or fewer, lowercase"))
    .length(13)
    .describe("Exactly 13 tags"),
});

const DEFAULT_STYLE =
  "Use warm, artisanal language that highlights handcrafted quality and uniqueness. Focus on the beauty and energy of natural stones.";

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
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
      { error: "Body must include design_name, materials [{ name, quantity }], and price." },
      { status: 400 }
    );
  }

  const materialsList = body.materials
    .map((m) => `- ${m.name} × ${m.quantity}`)
    .join("\n");

  const prompt = `Create an Etsy listing for a handmade jewelry piece.

DESIGN NAME: ${body.design_name}
MATERIALS USED (exact composition of the piece):
${materialsList}
${body.length_in ? `FINISHED LENGTH: ${body.length_in.toFixed(1)} inches\n` : ""}${
    body.labor_hours ? `HANDWORK TIME: ${body.labor_hours} hours\n` : ""
  }PRICE: $${body.price.toFixed(2)}

STYLE GUIDELINES: ${body.style_guidelines?.trim() || DEFAULT_STYLE}

Write an SEO-optimized title, a detailed description (materials, dimensions, care instructions), and exactly 13 Etsy SEO tags. Mention only materials that are actually in the composition above.`;

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: { format: zodOutputFormat(ListingSchema) },
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json(
        { error: "The model declined to process this request." },
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

    return NextResponse.json({ listing: parsed });
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
