import { z } from "zod";

// Render-ready visual spec for a bead, generated once by Claude (from the
// receipt's product photos when available, otherwise from the material name)
// and stored in materials.visual. BeadSwatch renders it; the two API routes
// share this schema so specs are identical regardless of provenance.

export const COLOR_FAMILIES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
  "black",
  "white",
  "gray",
  "gold",
  "silver",
  "clear",
  "multicolor",
] as const;

export type ColorFamily = (typeof COLOR_FAMILIES)[number];

export const BEAD_SHAPES = [
  "round",
  "rondelle",
  "bicone",
  "tube",
  "cube",
  "octagon",
  "oval",
  "teardrop",
  "chip",
  "heishi",
  "seed",
  "nugget",
  "flower",
] as const;

// Non-bead components that can sit on a strand. Rendered with dedicated
// SVG treatments in BeadSwatch (link chains, wire outlines) rather than the
// filled-silhouette pipeline beads use.
export const COMPONENT_SHAPES = [
  "chain",
  "jump-ring",
  "lobster-clasp",
  "toggle-clasp",
  "connector",
  "cabochon",
] as const;

export const VISUAL_SHAPES = [...BEAD_SHAPES, ...COMPONENT_SHAPES] as const;

export const BeadVisualSchema = z.object({
  shape: z
    .enum(VISUAL_SHAPES)
    .describe(
      "Closest basic shape. Beads: use 'chip' or 'nugget' for irregular stones, 'octagon' for cornerless/faceted cubes, 'flower' for carved flower beads. Components: 'chain' for link chain, 'jump-ring' for plain rings, 'lobster-clasp' for lobster/spring clasps, 'toggle-clasp' for toggle ring-and-bar clasps, 'connector' for multi-loop bars and links, 'cabochon' for flat-backed focal stones."
    ),
  length_mm: z
    .number()
    .describe(
      "Size in mm along the stringing-hole axis — how far one element advances a strand. For an 8x4mm rondelle this is 4; for an 8mm round bead it is 8. For 'chain' always use 25.4: one placed element represents a 1-inch segment."
    ),
  width_mm: z
    .number()
    .describe(
      "Size in mm perpendicular to the hole axis (the visible diameter/height when strung). For an 8x4mm rondelle this is 8."
    ),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .describe('Dominant color as a 6-digit hex string, e.g. "#7a9bac"'),
  color_family: z
    .enum(COLOR_FAMILIES)
    .nullable()
    .describe(
      "General color family for search/filtering. Use gold/silver for metallics, multicolor for rainbow assortments."
    ),
  color_secondary: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .describe(
      "Secondary 6-digit hex color for marbling, speckles, or banding; null for a uniform bead"
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

function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0.5];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/** Size buckets for filtering, keyed on the element's visible width. The
 * split above 8mm keeps focal pieces (cabochons, chain segments) out of the
 * bucket ordinary large beads live in. */
export const SIZE_BUCKETS = [
  { key: "xs", label: "< 4mm", min: 0, max: 4 },
  { key: "s", label: "4–6mm", min: 4, max: 6 },
  { key: "m", label: "6–8mm", min: 6, max: 8 },
  { key: "l", label: "8–15mm", min: 8, max: 15 },
  { key: "xl", label: "15mm +", min: 15, max: Infinity },
] as const;

export function sizeBucketOf(visual: BeadVisual | null | undefined): string | null {
  if (!visual) return null;
  const size = Math.max(visual.width_mm, visual.length_mm);
  const bucket = SIZE_BUCKETS.find((b) => size >= b.min && size < b.max);
  return bucket?.key ?? null;
}

/**
 * Color family for filtering. Newer visuals carry it from generation; older
 * ones (stored before the field existed) fall back to deriving it from the
 * hex color and finish.
 */
export function colorFamilyOf(visual: BeadVisual | null | undefined): ColorFamily | null {
  if (!visual) return null;
  if (visual.color_family) return visual.color_family;
  const [h, s, l] = hexToHsl(visual.color);
  if (visual.finish === "metallic") {
    if (h >= 25 && h <= 60 && s > 0.2) return "gold";
    if (s < 0.2) return "silver";
  }
  if (l < 0.12) return "black";
  if (l > 0.92 && s < 0.15) return "white";
  if (s < 0.12) return "gray";
  if (h < 15 || h >= 345) return l < 0.3 ? "brown" : "red";
  if (h < 45) return l < 0.45 ? "brown" : "orange";
  if (h < 68) return "yellow";
  if (h < 165) return "green";
  if (h < 255) return "blue";
  if (h < 300) return "purple";
  return "pink";
}
