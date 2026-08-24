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

export interface Material {
  id: string;
  name: string;
  category: string;
  unit_cost: number;
  quantity: number;
  unit_type: string;
  supplier: string;
  visual: BeadVisual | null;
  /** Owner; null only on legacy rows created before auth (see migration 0005). */
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export type NewMaterial = Omit<
  Material,
  "id" | "created_at" | "updated_at" | "visual" | "user_id"
> & {
  visual?: BeadVisual | null;
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
