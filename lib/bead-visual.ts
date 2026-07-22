import { z } from "zod";

// Render-ready visual spec for a bead, generated once by Claude (from the
// receipt's product photos when available, otherwise from the material name)
// and stored in materials.visual. BeadSwatch renders it; the two API routes
// share this schema so specs are identical regardless of provenance.

export const BEAD_SHAPES = [
  "round",
  "rondelle",
  "bicone",
  "tube",
  "cube",
  "oval",
  "teardrop",
  "chip",
  "heishi",
  "seed",
  "nugget",
] as const;

export const BeadVisualSchema = z.object({
  shape: z
    .enum(BEAD_SHAPES)
    .describe("Closest basic bead shape. Use 'chip' or 'nugget' for irregular stones."),
  length_mm: z
    .number()
    .describe(
      "Size in mm along the stringing-hole axis — how far one bead advances a strand. For an 8x4mm rondelle this is 4; for an 8mm round bead it is 8."
    ),
  width_mm: z
    .number()
    .describe(
      "Size in mm perpendicular to the hole axis (the visible diameter/height when strung). For an 8x4mm rondelle this is 8."
    ),
  color: z.string().describe('Dominant color as a hex string, e.g. "#7a9bac"'),
  color_secondary: z
    .string()
    .nullable()
    .describe(
      "Secondary hex color for marbling, speckles, or banding; null for a uniform bead"
    ),
  finish: z
    .enum(["matte", "glossy", "metallic", "pearl", "transparent"])
    .describe("Surface finish. Gemstones are usually glossy; metals metallic."),
  pattern: z
    .enum(["solid", "marbled", "speckled", "banded"])
    .describe(
      "Color distribution. Jaspers/agates are often marbled or banded; most glass and metal is solid."
    ),
  faceted: z.boolean().describe("True if the bead surface is faceted rather than smooth"),
});

export type BeadVisual = z.infer<typeof BeadVisualSchema>;
export type BeadShape = (typeof BEAD_SHAPES)[number];
