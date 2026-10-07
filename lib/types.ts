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

/** Categories whose items can sit on a strand: what the board's palette
 * offers (anything else with a generated visual is placeable too) and the
 * default when specifying a material out of a lot. Wire/cord/tools stay
 * inventory-only. */
export const PLACEABLE_CATEGORIES = new Set<string>(["Beads", "Cabochons", "Findings"]);

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
  /** An unitemized lot or assortment (GRA-36): a bag of mixed beads or a
   * parcel of uncounted stones whose contents are specified later as
   * separate rows. Never placed on the board; `quantity` × `unit_cost` is
   * what the lot cost. */
  is_lot: boolean;
  /** The lot this row was specified out of, when it was (see lib/lots.ts). */
  lot_id: string | null;
  /** The slice of that lot's price this row took; null unless from a lot. */
  lot_cost: number | null;
  /** Owner; null only on legacy rows created before auth (see migration 0005). */
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export type NewMaterial = Omit<
  Material,
  | "id"
  | "created_at"
  | "updated_at"
  | "visual"
  | "user_id"
  | "order_id"
  | "source"
  | "generic_key"
  | "is_lot"
  | "lot_id"
  | "lot_cost"
> & {
  visual?: BeadVisual | null;
  order_id?: string | null;
  source?: MaterialSource | null;
  generic_key?: string | null;
  is_lot?: boolean;
  lot_id?: string | null;
  lot_cost?: number | null;
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
  /** The line is an unitemized lot/assortment (GRA-36): imported as one
   * row to specify materials out of later, instead of guessed variants. */
  lot: boolean;
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
  /** Photos of the finished piece in the design-photos bucket, primary first
   * (GRA-38). They ground listing generation and are kept for the listing. */
  photo_paths: string[];
  status: DesignStatus;
  etsy_listing_url: string | null;
  /** Owner; null only on legacy rows created before auth (see migration 0005). */
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Where a piece is between the board and a sale (migration 0013's check
 * constraint holds the same list). */
export const DESIGN_STATUSES = ["design", "finished", "listed", "sold"] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

/** Photos a design holds, all of which go to the listing generator; more
 * adds latency and tokens without describing the piece any better. Lives
 * here, not in lib/design-photos.ts, because generate-listing enforces it
 * too and must not import the browser Supabase client. */
export const MAX_DESIGN_PHOTOS = 6;

/** Package units offered for Etsy's calculated shipping (a subset of Etsy's
 * enums). Here, not in lib/etsy.ts, so the publish route can validate with
 * them without importing the browser Supabase client. */
export const WEIGHT_UNITS = ["oz", "lb", "g", "kg"] as const;
export const DIMENSION_UNITS = ["in", "cm", "mm"] as const;

export const DESIGN_STATUS_LABELS: Record<DesignStatus, string> = {
  design: "Design",
  finished: "Finished, unlisted",
  listed: "Listed",
  sold: "Sold",
};

export interface DesignBead {
  material_id: string;
  /** The bezel-setting material this cabochon sits in (GRA-29). Only
   * meaningful on a cabochon; the pair draws and hangs as one pendant and
   * the bezel draws down stock like a placed element. */
  setting_id?: string;
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
  /** Etsy's Materials field; absent on listings generated before it existed. */
  materials?: string[];
  price: number;
}

export type NewDesign = Omit<
  Design,
  | "id"
  | "created_at"
  | "updated_at"
  | "pricing"
  | "listing"
  | "user_id"
  | "photo_paths"
  | "status"
  | "etsy_listing_url"
> & {
  pricing?: DesignPricing | null;
  listing?: DesignListing | null;
  photo_paths?: string[];
  status?: DesignStatus;
  etsy_listing_url?: string | null;
};
