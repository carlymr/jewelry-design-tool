import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./supabase-config";

let client: SupabaseClient | null = null;

/**
 * Lazily create the browser Supabase client so the module can be imported
 * during build without env vars present.
 */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const config = getSupabaseConfig();
    if (!config) {
      throw new Error(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see .env.example)."
      );
    }
    client = createClient(config.url, config.key);
  }
  return client;
}
