import type { BeadVisual } from "./bead-visual";
import type { Material } from "./types";

// Which bezel settings a cabochon can be set into (GRA-29). Pure functions
// over visuals so the board, replace mode and the palette badge all agree.

/** How much larger than the stone a recess may be (per axis, in mm) and
 * still hold it — bezel walls get pushed in to close a small gap, but a
 * 25 mm stone rattles in a 30 mm setting. */
export const FIT_SLACK_MM = 1.5;

/** Long and short face dimensions. A cab's `length_mm` runs along the hole
 * axis and a bezel's along its recess, but a stone can be set either way
 * round, so fit compares long-to-long and short-to-short. */
const axes = (v: BeadVisual): [number, number] => [
  Math.max(v.length_mm, v.width_mm),
  Math.min(v.length_mm, v.width_mm),
];

/** Whether `bezel`'s recess holds `cab`: same face outline (null counts as
 * oval), and the recess at least as large as the stone on both axes but by
 * no more than `FIT_SLACK_MM`. */
export function fits(cab: BeadVisual, bezel: BeadVisual): boolean {
  if (cab.shape !== "cabochon" || bezel.shape !== "bezel") return false;
  if ((cab.outline ?? "oval") !== (bezel.outline ?? "oval")) return false;
  const [cabLong, cabShort] = axes(cab);
  const [recessLong, recessShort] = axes(bezel);
  const within = (stone: number, recess: number) =>
    recess >= stone && recess - stone <= FIT_SLACK_MM;
  return within(cabLong, recessLong) && within(cabShort, recessShort);
}

/** Bezel-setting materials in `materials` that fit `cab`, in name order. */
export function fittingBezels(cab: Material, materials: Material[]): Material[] {
  const stone = cab.visual;
  if (!stone) return [];
  return materials
    .filter((m) => m.visual?.shape === "bezel" && fits(stone, m.visual))
    .sort((a, b) => a.name.localeCompare(b.name));
}
