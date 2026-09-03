import { getSupabaseConfig } from "./supabase-config";

// Server-side guard for the API routes: requires a valid Supabase session
// token (Authorization: Bearer <jwt>), verified against GoTrue via fetch —
// not supabase-js, which stays out of server bundles by convention (see
// CLAUDE.md).

/** The caller behind a valid session token, or null if the request carries
 * no usable token. Routes that scope storage paths to the caller need the
 * id; GoTrue's /auth/v1/user response carries it. */
export async function authorizedUser(request: Request): Promise<{ id: string } | null> {
  const config = getSupabaseConfig();
  const auth = request.headers.get("authorization");
  if (!config || !auth?.startsWith("Bearer ")) return null;
  const res = await fetch(`${config.url}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: config.key },
  });
  if (!res.ok) return null;
  const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return typeof user?.id === "string" && user.id ? { id: user.id } : null;
}

export async function isAuthorized(request: Request): Promise<boolean> {
  return (await authorizedUser(request)) !== null;
}
