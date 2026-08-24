import { getSupabaseConfig } from "./supabase-config";

// Server-side guard for the API routes. The primary check is a Supabase
// session token (Authorization: Bearer <jwt>), verified against GoTrue via
// fetch — not supabase-js, which stays out of server bundles by convention
// (see CLAUDE.md). The legacy x-app-token shared secret is accepted as a
// fallback so already-deployed clients keep working; remove it once the
// 0006 lockdown migration ships.
export async function isAuthorized(request: Request): Promise<boolean> {
  const config = getSupabaseConfig();
  const auth = request.headers.get("authorization");
  if (config && auth?.startsWith("Bearer ")) {
    const res = await fetch(`${config.url}/auth/v1/user`, {
      headers: { Authorization: auth, apikey: config.key },
    });
    if (res.ok) return true;
  }

  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  return !token || request.headers.get("x-app-token") === token;
}
