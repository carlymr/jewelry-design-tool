import type { DesignBead } from "@/lib/types";

/**
 * Mirror mode (GRA-42) keeps the strand a palindrome around its middle so a
 * necklace can be built outward from its pendant. It is an edit mode, not a
 * data model: the strand stays a flat array, and the axis falls out of its
 * length. An odd strand's center element (usually the pendant) is the axis
 * and reflects onto itself; an even strand mirrors around its middle gap.
 * Element i reflects to n-1-i and gap g to n-g.
 *
 * Everything here is pure index math; DesignBoard wires it to the cursor and
 * records the undo step.
 */

export type Side = "left" | "right";

/** Gap (0..n) that reflects `gap` in a strand of n elements. */
export const reflectGap = (gap: number, n: number) => n - gap;

/** Index that reflects element `i` in a strand of n elements. */
const reflectIndex = (i: number, n: number) => n - 1 - i;

/** True when the strand reads the same from both ends (by material). */
export function isPalindrome(beads: DesignBead[]): boolean {
  for (let i = 0, j = beads.length - 1; i < j; i++, j--) {
    if (beads[i].material_id !== beads[j].material_id) return false;
  }
  return true;
}

const clone = (items: DesignBead[]) => items.map((b) => ({ ...b }));

/**
 * Insert `items` at `gap` and their reversal at the reflected gap, as one
 * edit. The caret lands just past the user's copy, which keeps it on their
 * side even though the strand grew on the other end too.
 */
export function mirroredInsert(
  beads: DesignBead[],
  gap: number,
  items: DesignBead[]
): { beads: DesignBead[]; insertion: number } {
  const n = beads.length;
  const g = Math.min(Math.max(gap, 0), n);
  const r = reflectGap(g, n);
  const next = [...beads];
  const mirrored = clone(items).reverse();
  if (g < r) {
    // Higher gap first, so the lower insert can't shift it.
    next.splice(r, 0, ...mirrored);
    next.splice(g, 0, ...items);
    return { beads: next, insertion: g + items.length };
  }
  // The user's copy sits at or right of the axis (a center gap counts as
  // the right side), so its reflection lands below it and shifts it along.
  // At the center gap itself this yields `reversed + items`, i.e. both
  // sides at once.
  next.splice(g, 0, ...items);
  next.splice(r, 0, ...mirrored);
  return { beads: next, insertion: g + 2 * items.length };
}

/**
 * Remove the inclusive range [start, end] and its reflection, as one edit.
 * A range that straddles the axis overlaps its own reflection; taking the
 * union deletes it once. The caret lands where the range began, counted in
 * the surviving beads.
 */
export function mirroredDelete(
  beads: DesignBead[],
  start: number,
  end: number
): { beads: DesignBead[]; insertion: number } {
  const n = beads.length;
  const rStart = reflectIndex(end, n);
  const rEnd = reflectIndex(start, n);
  const gone = (i: number) => (i >= start && i <= end) || (i >= rStart && i <= rEnd);
  const next: DesignBead[] = [];
  let insertion = 0;
  beads.forEach((b, i) => {
    if (gone(i)) return;
    next.push(b);
    if (i < start) insertion++;
  });
  return { beads: next, insertion };
}

/** A center to fold around: the half-open range of elements that stay put
 * (the pendant, say), or an empty range at a gap to fold at that gap. */
export type FoldCenter = { start: number; end: number };

/**
 * Fold the strand around `center`: the kept side and the center stay as
 * they are, and the kept side's reversal replaces the other. The result is
 * a palindrome around the center, so the center becomes the strand's
 * middle — which is what makes an off-center pendant central again.
 */
export function makeSymmetric(
  beads: DesignBead[],
  center: FoldCenter,
  keep: Side
): DesignBead[] {
  const middle = beads.slice(center.start, center.end);
  const left = beads.slice(0, center.start);
  const right = beads.slice(center.end);
  return keep === "left"
    ? [...left, ...middle, ...clone(left).reverse()]
    : [...clone(right).reverse(), ...middle, ...right];
}

/** True when the two strands hold the same materials in the same order. */
export const sameStrand = (a: DesignBead[], b: DesignBead[]) =>
  a.length === b.length && a.every((x, i) => x.material_id === b[i].material_id);
