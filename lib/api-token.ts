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

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UPLOAD_PATH_RE = new RegExp(`^(${UUID})/${UUID}\\.([a-z0-9]+)$`, "i");

/** Whether `path` is one of the caller's own transient uploads — the
 * `{user_id}/{uuid}.{ext}` shape lib/photo-upload.ts generates, with an
 * allowed extension and the folder equal to the caller's id. The bucket
 * policies (migration 0011) enforce the same ownership; the routes check it
 * too so a signed-in user can't point them at someone else's in-flight
 * file. */
export function isOwnUpload(
  path: string,
  userId: string,
  extensions: readonly string[]
): boolean {
  const m = UPLOAD_PATH_RE.exec(path);
  return m !== null && m[1] === userId && extensions.includes(m[2].toLowerCase());
}
