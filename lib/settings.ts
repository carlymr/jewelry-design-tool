import { getSupabase } from "./supabase";
import { getUserId } from "./auth";

/** Business-wide pricing/listing settings, one row per user in
 * `user_settings.pricing` (migration 0009). Values stay strings because they
 * mirror input fields. The shape is owned by PricingStudio; this module just
 * moves the blob. */
export interface PricingSettings {
  hourly_rate: string;
  overhead_pct: string;
  markup_pct: string;
  /** Round the selling price to the nearest this-many dollars; "0" = exact.
   * Missing on settings saved before it existed (defaults fill it in). */
  price_rounding: string;
  style_guidelines: string;
  // Etsy draft defaults (GRA-37): ids from the connected shop, remembered
  // from the last publish. Empty string = not chosen yet.
  etsy_when_made: string;
  etsy_shipping_profile_id: string;
  etsy_processing_profile_id: string;
  etsy_return_policy_id: string;
  /** Category per piece type, since necklaces and bracelets file differently. */
  etsy_category_necklace: string;
  etsy_category_bracelet: string;
  /** Packaged weight/size for calculated shipping, remembered from the last
   * publish (most pieces ship in the same packaging). */
  etsy_item_weight: string;
  etsy_item_weight_unit: string;
  etsy_item_length: string;
  etsy_item_width: string;
  etsy_item_height: string;
  etsy_item_dimensions_unit: string;
  title_template: string;
  description_template: string;
}

export async function loadPricingSettings(): Promise<PricingSettings | null> {
  const { data, error } = await getSupabase()
    .from("user_settings")
    .select("pricing")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.pricing as PricingSettings | null) ?? null;
}

export async function savePricingSettings(
  settings: PricingSettings
): Promise<void> {
  // Stamp the owner client-side like the other tables (the 0009 default
  // covers it too, but upsert needs the conflict key present anyway).
  const user_id = await getUserId();
  const { error } = await getSupabase()
    .from("user_settings")
    .upsert({ user_id, pricing: settings }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}
