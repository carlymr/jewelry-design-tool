export const CATEGORIES = [
  "Beads",
  "Cabochons",
  "Findings",
  "Wire",
  "Stringing",
  "Tools",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface Material {
  id: string;
  name: string;
  category: string;
  unit_cost: number;
  quantity: number;
  unit_type: string;
  supplier: string;
  created_at: string;
  updated_at: string;
}

export type NewMaterial = Omit<Material, "id" | "created_at" | "updated_at">;

/** One line item extracted from a receipt by the API route. */
export interface ExtractedItem {
  name: string;
  category: string;
  quantity_purchased: string;
  total_price: number;
  estimated_units: number;
  unit_type: string;
  unit_cost: number;
}
