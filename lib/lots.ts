import type { Material } from "./types";

// Lots (GRA-36): unitemized assortments imported as `materials` rows flagged
// `is_lot`, out of which specific materials are later "specified" (rows with
// `lot_id` pointing back and `lot_cost` holding their slice of the lot's
// price). Pure helpers only — no Supabase import — so routes and components
// can both use them; the data functions live in lib/materials.ts.

/** Whether a material row is a lot (an unitemized assortment). */
export const isLot = (m: Pick<Material, "is_lot"> | null | undefined) => !!m?.is_lot;

/** Whether a material row was specified out of a lot. */
export const isFromLot = (m: Pick<Material, "lot_id"> | null | undefined) => !!m?.lot_id;

/** What the lot cost as a whole: it is stored as `quantity` units at
 * `unit_cost` each ("300 carat @ $0.15", or "1 lot @ $20"). */
export const lotPrice = (lot: Pick<Material, "quantity" | "unit_cost">) =>
  Number(lot.quantity) * Number(lot.unit_cost);

/** How much of a lot's price its specified items have claimed so far, and
 * what remains unallocated. The remainder is clamped at zero: over-allocation
 * is reported separately so the UI can flag it rather than show a negative. */
export function lotAllocation(
  lot: Pick<Material, "id" | "quantity" | "unit_cost">,
  items: Pick<Material, "lot_id" | "lot_cost">[]
) {
  const price = lotPrice(lot);
  const allocated = items
    .filter((m) => m.lot_id === lot.id)
    .reduce((sum, m) => sum + Number(m.lot_cost ?? 0), 0);
  return {
    price,
    allocated,
    remaining: Math.max(0, price - allocated),
    over: allocated > price + 0.005,
  };
}

/** Round to cents the way the DB column (numeric(10,2)) will. */
export const toCents = (n: number) => Math.round(n * 100) / 100;
