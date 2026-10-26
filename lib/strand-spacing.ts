import { pendantAttachment, type BeadVisual } from "./bead-visual";

// How far each element advances the strand, shared by the design board and
// the photo import's preview so both place elements the same way.

// Beads without a generated visual still need to advance the strand somehow.
export const FALLBACK_BEAD_MM = 6;

// A cabochon is worn as a pendant: it hangs below the string from a bail and
// advances the strand by only the bail's width, not the stone's size. The
// exception is a center-drilled stone, which strings inline like a bead.
export const CABOCHON_ADVANCE_MM = 6;
export const CABOCHON_BAIL_MM = 4;

// Cabochons (unless center-drilled) and bezel settings hang below the string.
export const isPendant = (v: BeadVisual | null | undefined) => {
  const a = pendantAttachment(v);
  return a !== null && a !== "inline";
};
// Wire-hung pendants have no ring; the rest hang from a bail (real, or a
// placeholder standing in for the setting an undrilled stone still needs).
export const hasBail = (v: BeadVisual) => pendantAttachment(v) !== "wire";

export const beadLengthMm = (m: { visual?: BeadVisual | null } | undefined) =>
  isPendant(m?.visual)
    ? CABOCHON_ADVANCE_MM
    : m?.visual?.length_mm ?? FALLBACK_BEAD_MM;
export const beadWidthMm = (m: { visual?: BeadVisual | null } | undefined) =>
  isPendant(m?.visual)
    ? CABOCHON_ADVANCE_MM
    : m?.visual?.width_mm ?? FALLBACK_BEAD_MM;
