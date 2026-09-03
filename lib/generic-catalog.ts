import { BeadVisualSchema, type BeadVisual, type ColorFamily } from "./bead-visual";
import type { Material } from "./types";

// Built-in catalog of generic findings (GRA-17): the jump rings, crimps,
// spacer balls and clasps that come in mixed kits and aren't worth an
// inventory row each. An entry becomes a real `materials` row the first time
// a user places it (keyed by `materials.generic_key`, one per user), so
// designs, pricing and the palette never learn a second id space. Entries
// ship with a complete visual so they render without an AI call, and carry
// no stock — quantity stays 0 and the UI ignores it for them.
//
// v1 is findings only. Adding an entry is safe (rows are created lazily);
// renaming a `key` orphans any rows seeded under the old one, so treat keys
// as permanent.

export const GENERIC_KINDS = [
  "Jump rings",
  "Lobster clasps",
  "Toggle clasps",
  "Crimp beads",
  "Crimp covers",
  "Crimp tubes",
  "Spacer balls",
  "Wire guardians",
] as const;
export type GenericKind = (typeof GENERIC_KINDS)[number];

export interface GenericEntry {
  /** Stable identity stored in `materials.generic_key`. Never rename. */
  key: string;
  kind: GenericKind;
  /** Follows the naming standard: [Material] [Type] [Size] [Shape] [Cut]. */
  name: string;
  category: "Findings";
  unit_type: "piece";
  /** Rough per-piece cost in dollars (kit price ÷ count), editable per row. */
  unit_cost: number;
  visual: BeadVisual;
}

/** Whether a material row was seeded from this catalog. */
export const isGeneric = (m: Pick<Material, "generic_key"> | null | undefined) =>
  !!m?.generic_key;

// Metal finishes, in the order they're listed. The color is the mid-tone the
// metallic gradient in BeadSwatch swings around; the family drives the
// palette's color filter.
type Finish = { key: string; label: string; color: string; family: ColorFamily };
const SILVER: Finish = { key: "silver", label: "Silver", color: "#c4c7cc", family: "silver" };
const GOLD: Finish = { key: "gold", label: "Gold", color: "#d4a93a", family: "gold" };
const GUNMETAL: Finish = { key: "gunmetal", label: "Gunmetal", color: "#4b4f57", family: "gray" };
const BRONZE: Finish = {
  key: "antique-bronze",
  label: "Antique Bronze",
  color: "#8b6a3e",
  family: "brown",
};
const COPPER: Finish = { key: "copper", label: "Copper", color: "#b87333", family: "orange" };
const ALL_FINISHES = [SILVER, GOLD, GUNMETAL, BRONZE, COPPER];
const PLATED = [SILVER, GOLD];

/** A solid metal visual: every generic is a metallic, unpatterned finding. */
const metal = (
  shape: BeadVisual["shape"],
  finish: Finish,
  length_mm: number,
  width_mm: number
): BeadVisual => ({
  shape,
  length_mm,
  width_mm,
  color: finish.color,
  color_family: finish.family,
  color_secondary: null,
  finish: "metallic",
  pattern: "solid",
  faceted: false,
  drill: null,
  outline: null,
});

const entry = (
  kind: GenericKind,
  type: string,
  finish: Finish,
  size_mm: number,
  unit_cost: number,
  visual: BeadVisual
): GenericEntry => ({
  key: `${type.toLowerCase().replace(/\s+/g, "-")}-${finish.key}-${size_mm}mm`,
  kind,
  name: `${finish.label} ${type} ${size_mm}mm`,
  category: "Findings",
  unit_type: "piece",
  unit_cost,
  visual,
});

const JUMP_RING_MM = [4, 5, 6, 8, 10];
const SPACER_BALL_MM = [4, 6, 8];

export const GENERIC_CATALOG: GenericEntry[] = [
  // Jump rings: open rings, sized by outer diameter; drawn as a ring seen
  // face-on, which is how one reads on a strand.
  ...ALL_FINISHES.flatMap((f) =>
    JUMP_RING_MM.map((mm) =>
      entry("Jump rings", "Jump Ring", f, mm, 0.01 + mm * 0.003, metal("jump-ring", f, mm, mm))
    )
  ),
  // Lobster clasps: the everyday 12x6mm size (matches the receipt and
  // name-only visual prompts' "typical 12x6mm").
  ...ALL_FINISHES.map((f) =>
    entry("Lobster clasps", "Lobster Clasp", f, 12, 0.15, metal("lobster-clasp", f, 12, 6))
  ),
  // Toggle clasps: named by the ring's diameter; the placed element spans
  // the ring plus its bar laid end to end.
  ...ALL_FINISHES.map((f) =>
    entry("Toggle clasps", "Toggle Clasp", f, 15, 0.35, metal("toggle-clasp", f, 24, 15))
  ),
  // Crimps: tiny, so `round`/`tube` at true size is all the detail they get.
  ...PLATED.map((f) => entry("Crimp beads", "Crimp Bead", f, 2, 0.01, metal("round", f, 2, 2))),
  ...PLATED.map((f) => entry("Crimp covers", "Crimp Cover", f, 3, 0.03, metal("round", f, 3, 3))),
  ...PLATED.map((f) => entry("Crimp tubes", "Crimp Tube", f, 2, 0.02, metal("tube", f, 2, 2))),
  // Spacer balls: plain round metal beads.
  ...PLATED.flatMap((f) =>
    SPACER_BALL_MM.map((mm) =>
      entry("Spacer balls", "Spacer Ball", f, mm, 0.02 + mm * 0.006, metal("round", f, mm, mm))
    )
  ),
  // Wire guardians: a horseshoe channel the wire doubles back through. No
  // horseshoe shape exists, so the doubled loop of `figure-eight` at its
  // real ~5x4mm stands in (a `connector` reads as a spacer bar instead).
  ...PLATED.map((f) =>
    entry("Wire guardians", "Wire Guardian", f, 4, 0.04, metal("figure-eight", f, 5, 4))
  ),
];

const GENERIC_BY_KEY: ReadonlyMap<string, GenericEntry> = new Map(
  GENERIC_CATALOG.map((e) => [e.key, e])
);

/** The catalog grouped for display, in GENERIC_KINDS order. */
export const GENERIC_BY_KIND: ReadonlyArray<{ kind: GenericKind; entries: GenericEntry[] }> =
  GENERIC_KINDS.map((kind) => ({
    kind,
    entries: GENERIC_CATALOG.filter((e) => e.kind === kind),
  }));

// Validate at module load so a malformed entry (bad hex, unknown shape, a
// duplicated key) fails the build's prerender instead of the board at
// runtime. Static data, a few dozen entries — negligible cost.
if (GENERIC_BY_KEY.size !== GENERIC_CATALOG.length) {
  throw new Error("generic-catalog: duplicate keys");
}
for (const e of GENERIC_CATALOG) {
  const result = BeadVisualSchema.safeParse(e.visual);
  if (!result.success) {
    throw new Error(`generic-catalog: invalid visual for ${e.key}: ${result.error.message}`);
  }
}
