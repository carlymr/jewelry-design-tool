import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BeadVisualSchema } from "@/lib/bead-visual";

export const maxDuration = 120;

// Fallback visual generation from material names alone, for materials that
// didn't come through the receipt path (CSV imports, hand-entered items,
// legacy inventory). Receipt-imported materials get photo-informed visuals
// from the extraction route instead. The client writes the results to the DB
// (same pattern as the rest of the inventory CRUD).

const MAX_BATCH = 60;

const RequestSchema = z.object({
  materials: z
    .array(z.object({ id: z.string(), name: z.string().min(1) }))
    .min(1)
    .max(MAX_BATCH),
});

const ResponseSchema = z.object({
  visuals: z.array(
    z.object({
      id: z.string().describe("The material id this visual belongs to, copied exactly"),
      visual: BeadVisualSchema,
    })
  ),
});

const PROMPT = `For each jewelry material below, produce a visual spec describing how to draw one bead of it on a virtual beading board.

- Infer color, finish, and pattern from the material name (e.g. ocean jasper is typically mottled sea-green and glossy; hematite is dark metallic gray).
- length_mm is the dimension along the stringing hole — how far one bead advances a strand. For an "8x4mm rondelle" that is 4; for an "8mm round" it is 8. If no size is given, use a sensible default for the item type.
- width_mm is the visible diameter perpendicular to the hole.
- Copy each material's id exactly and return one visual per material.

Materials:
`;

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  let materials: { id: string; name: string }[];
  try {
    materials = RequestSchema.parse(await request.json()).materials;
  } catch {
    return NextResponse.json(
      { error: `Body must be { materials: [{ id, name }] } with 1–${MAX_BATCH} entries.` },
      { status: 400 }
    );
  }

  const listing = materials.map((m) => `- id: ${m.id} | name: ${m.name}`).join("\n");

  try {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: PROMPT + listing }],
      output_config: { format: zodOutputFormat(ResponseSchema) },
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

    // Only return visuals for ids we were actually asked about.
    const known = new Set(materials.map((m) => m.id));
    return NextResponse.json({
      visuals: parsed.visuals.filter((v) => known.has(v.id)),
    });
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
