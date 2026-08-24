import { getSupabaseConfig } from "./supabase-config";

// Server-side guard for the API routes: requires a valid Supabase session
// token (Authorization: Bearer <jwt>), verified against GoTrue via fetch —
// not supabase-js, which stays out of server bundles by convention (see
// CLAUDE.md).
export async function isAuthorized(request: Request): Promise<boolean> {
  const config = getSupabaseConfig();
  const auth = request.headers.get("authorization");
  if (!config || !auth?.startsWith("Bearer ")) return false;
  const res = await fetch(`${config.url}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: config.key },
  });
  return res.ok;
}
