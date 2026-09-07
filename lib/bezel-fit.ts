import type { BeadVisual } from "./bead-visual";
import type { DesignBead, Material } from "./types";

// Which bezel settings a cabochon can be set into (GRA-29). Pure functions
// over visuals so the board, replace mode, pricing and the palette badge
// all agree.

/** How much larger than the stone a recess may be (per axis, in mm) and
 * still hold it — bezel walls get pushed in to close a small gap, but a
 * 25 mm stone rattles in a 30 mm setting. */
export const FIT_SLACK_MM = 1.5;

/** Long and short face dimensions. A cab's `length_mm` runs along the hole
 * axis and a bezel's along its recess, but a stone can be set either way
 * round, so fit compares long-to-long and short-to-short. */
export const faceAxes = (v: BeadVisual): [number, number] => [
  Math.max(v.length_mm, v.width_mm),
  Math.min(v.length_mm, v.width_mm),
];

const outlineOf = (v: BeadVisual) => v.outline ?? "oval";

/** A material known to carry a bezel visual. */
type Bezel = Material & { visual: BeadVisual };

/** Whether `bezel`'s recess holds `cab`: same face outline (null counts as
 * oval), and the recess at least as large as the stone on both axes but by
 * no more than `FIT_SLACK_MM`. */
export function fits(cab: BeadVisual, bezel: BeadVisual): boolean {
  if (cab.shape !== "cabochon" || bezel.shape !== "bezel") return false;
  if (outlineOf(cab) !== outlineOf(bezel)) return false;
  const [cabLong, cabShort] = faceAxes(cab);
  const [recessLong, recessShort] = faceAxes(bezel);
  const within = (stone: number, recess: number) =>
    recess >= stone && recess - stone <= FIT_SLACK_MM;
  return within(cabLong, recessLong) && within(cabShort, recessShort);
}

/** The bezel's recess oriented like the stone: if the two were recorded
 * with their long axes on different fields, swap so long lines up with
 * long. Rendering a set stone lays the stone inside this box. */
export function alignedRecessMm(
  bezel: BeadVisual,
  stone: BeadVisual
): { length_mm: number; width_mm: number } {
  const stoneLengthwise = stone.length_mm >= stone.width_mm;
  const bezelLengthwise = bezel.length_mm >= bezel.width_mm;
  return stoneLengthwise === bezelLengthwise
    ? { length_mm: bezel.length_mm, width_mm: bezel.width_mm }
    : { length_mm: bezel.width_mm, width_mm: bezel.length_mm };
}

/** Bezel-setting materials in `materials` that fit `cab`, in name order. */
export function fittingBezels(cab: Material, materials: Material[]): Material[] {
  return settingCandidates(cab, materials).fitting;
}

/** Everything the Set into… picker needs: the bezels that fit, plus — for
 * explaining an empty list — the bezels sharing the stone's outline and
 * whichever of those comes nearest to its size. */
export function settingCandidates(
  cab: Material,
  materials: Material[]
): { fitting: Material[]; sameOutline: Material[]; closest: Bezel | null } {
  const stone = cab.visual;
  if (!stone || stone.shape !== "cabochon") {
    return { fitting: [], sameOutline: [], closest: null };
  }
  const bezels = materials
    .filter((m): m is Bezel => m.visual?.shape === "bezel")
    .sort((a, b) => a.name.localeCompare(b.name));
  const sameOutline = bezels.filter((m) => outlineOf(m.visual) === outlineOf(stone));
  const fitting = sameOutline.filter((m) => fits(stone, m.visual));
  const [cabLong, cabShort] = faceAxes(stone);
  // Nearest by the worse of the two axis gaps, so a bezel that's right on
  // one axis but far off on the other doesn't win.
  const gap = (m: Bezel) => {
    const [l, s] = faceAxes(m.visual);
    return Math.max(Math.abs(l - cabLong), Math.abs(s - cabShort));
  };
  const closest = sameOutline.reduce<Bezel | null>(
    (best, m) => (best === null || gap(m) < gap(best) ? m : best),
    null
  );
  return { fitting, sameOutline, closest };
}

/** The bezel a placed cabochon actually sits in: `setting_id` resolved to a
 * material, but only while the bead's material is still a cabochon and the
 * setting still exists as a bezel. A stale id (material deleted, reshaped)
 * resolves to nothing, so rendering, stock counts, the working set and
 * pricing all drop it the same way. */
export function resolveSetting(
  bead: DesignBead,
  materialById: Map<string, Material>
): Material | undefined {
  if (!bead.setting_id) return undefined;
  if (materialById.get(bead.material_id)?.visual?.shape !== "cabochon") return undefined;
  const setting = materialById.get(bead.setting_id);
  return setting?.visual?.shape === "bezel" ? setting : undefined;
}
