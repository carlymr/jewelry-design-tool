import type { BeadVisual } from "./bead-visual";

export const CATEGORIES = [
  "Beads",
  "Cabochons",
  "Findings",
  "Wire",
  "Stringing",
  "Tools",
  "Other",
] as const;

/** The categories actually present in a set of materials, in CATEGORIES order
 * with any unrecognized ones (free-text rows) appended alphabetically. Filter
 * dropdowns build their options from this so they never offer an empty choice. */
export function presentCategories(materials: { category: string }[]): string[] {
  const present = new Set(materials.map((m) => m.category).filter(Boolean));
  const known = CATEGORIES.filter((c) => present.has(c)) as string[];
  const extra = [...present].filter((c) => !known.includes(c)).sort();
  return [...known, ...extra];
}

/** Where a material came from — the listing details that identify it. */
export interface MaterialSource {
  listing_title: string;
  /** Variation / personalization / selection text, e.g. "IR3896 30X24X5MM43CT". */
  variation: string | null;
  /** Price paid for this line after discounts. */
  line_price: number;
  /** Receipt page the line appears on (1-based), when known. */
  page: number | null;
}

/** One receipt: the order it documents and where the file is archived. */
export interface Order {
  id: string;
  user_id: string;
  platform: string;
  seller: string;
  order_number: string;
  order_date: string | null;
  total: number | null;
  receipt_path: string | null;
  created_at: string;
  updated_at: string;
}

export type NewOrder = Omit<Order, "id" | "user_id" | "created_at" | "updated_at">;

export interface Material {
  id: string;
  name: string;
  category: string;
  unit_cost: number;
  quantity: number;
  unit_type: string;
  supplier: string;
  visual: BeadVisual | null;
  order_id: string | null;
  source: MaterialSource | null;
  /** Catalog key when this row was seeded from lib/generic-catalog.ts (GRA-17);
   * null for an ordinary inventory row. Generics carry no stock. */
  generic_key: string | null;
  /** Owner; null only on legacy rows created before auth (see migration 0005). */
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export type NewMaterial = Omit<
  Material,
  "id" | "created_at" | "updated_at" | "visual" | "user_id" | "order_id" | "source" | "generic_key"
> & {
  visual?: BeadVisual | null;
  order_id?: string | null;
  source?: MaterialSource | null;
  generic_key?: string | null;
};

/** One line item extracted from a receipt by the API route. */
export interface ExtractedItem {
  name: string;
  category: string;
  quantity_purchased: string;
  total_price: number;
  estimated_units: number;
  unit_type: string;
  unit_cost: number;
  visual: BeadVisual | null;
  source: MaterialSource;
}

/** The order header the receipt route reads off a receipt. */
export interface ExtractedOrder {
  platform: string;
  seller: string;
  order_number: string;
  order_date: string | null;
  total: number | null;
}

/** A strand design: an ordered list of beads plus a target length. */
export interface Design {
  id: string;
  name: string;
  target_length_mm: number;
  beads: DesignBead[];
  pricing: DesignPricing | null;
  listing: DesignListing | null;
  /** Owner; null only on legacy rows created before auth (see migration 0005). */
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignBead {
  material_id: string;
}

/** An off-board material used by a design (clasp, wire, etc.). */
export interface DesignExtra {
  material_id: string;
  quantity: number;
}

/** Pricing inputs saved per design; business-wide rates live in localStorage. */
export interface DesignPricing {
  labor_hours: number;
  extras: DesignExtra[];
}

/** A generated Etsy listing, editable and saved with its design. */
export interface DesignListing {
  title: string;
  description: string;
  tags: string[];
  price: number;
}

export type NewDesign = Omit<
  Design,
  "id" | "created_at" | "updated_at" | "pricing" | "listing" | "user_id"
> & {
  pricing?: DesignPricing | null;
  listing?: DesignListing | null;
};
