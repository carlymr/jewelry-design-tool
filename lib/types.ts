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
  created_at: string;
  updated_at: string;
}

export type NewMaterial = Omit<
  Material,
  "id" | "created_at" | "updated_at" | "visual"
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
  created_at: string;
  updated_at: string;
}

export interface DesignBead {
  material_id: string;
}

export type NewDesign = Omit<Design, "id" | "created_at" | "updated_at">;
