// Shared env resolution for Supabase. Kept separate from lib/supabase.ts so
// server code (the receipt route uses the Storage REST API, not supabase-js)
// can import it without pulling supabase-js into the bundle.
// Publishable key first; the legacy anon key is a fallback only because the
// Vercel integration injects that name. Don't reintroduce anon-key-first logic.
export function getSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url, key };
}
