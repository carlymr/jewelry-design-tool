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
  style_guidelines: string;
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
