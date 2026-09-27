import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSupabaseConfig } from "./supabase-config";

// Server-only Etsy Open API v3 helpers (GRA-37). Like the other route
// helpers this is fetch-only: no supabase-js server-side, and the database
// is reached through PostgREST with the caller's own JWT (there is no
// service key). Because that JWT could equally be used from the browser,
// OAuth tokens are stored encrypted with a key derived from
// ETSY_SHARED_SECRET (migration 0014): the row alone can't act on the shop.

const API = "https://api.etsy.com/v3";
const TOKEN_URL = `${API}/public/oauth/token`;
export const AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
export const ETSY_SCOPES = "listings_w listings_r shops_r";
/** Refresh a little before expiry so a token can't lapse mid-publish. */
const EXPIRY_MARGIN_MS = 60_000;
const REFRESH_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export class EtsyError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function etsyConfig(): { keystring: string; secret: string } {
  const keystring = process.env.ETSY_KEYSTRING;
  const secret = process.env.ETSY_SHARED_SECRET;
  if (!keystring || !secret) {
    throw new EtsyError(
      500,
      "Etsy isn't configured on the server (ETSY_KEYSTRING and ETSY_SHARED_SECRET)."
    );
  }
  return { keystring, secret };
}

// --- encryption: AES-256-GCM, output base64url(iv | tag | ciphertext) ---

function cipherKey(): Buffer {
  return createHash("sha256")
    .update(`jewelry-design-tool:etsy:v1:${etsyConfig().secret}`)
    .digest();
}

export function seal(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

/** Decrypts seal() output; throws on tampering or a rotated secret. */
export function unseal<T>(sealed: string): T {
  const buf = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}

// --- PKCE ---

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, allowed alphabet
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// --- Etsy HTTP ---

async function etsyErrorFrom(res: Response): Promise<EtsyError> {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; error_description?: string }
    | null;
  const detail = body?.error_description || body?.error || res.statusText;
  // Keeps Etsy's status: the token flow checks it for a revoked grant, and
  // etsyErrorResponse passes 4xx through so the client knows nothing was
  // created.
  return new EtsyError(res.status, `Etsy responded ${res.status}: ${detail}`);
}

/** Call an Etsy v3 endpoint (path after /v3, e.g. "/application/users/me"). */
export async function etsyFetch<T>(
  path: string,
  init: RequestInit & { accessToken?: string } = {}
): Promise<T> {
  const { keystring, secret } = etsyConfig();
  const { accessToken, headers, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "x-api-key": `${keystring}:${secret}`,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });
  if (!res.ok) throw await etsyErrorFrom(res);
  return (await res.json()) as T;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const { keystring, secret } = etsyConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-api-key": `${keystring}:${secret}`,
    },
    body: new URLSearchParams({ client_id: keystring, ...params }),
  });
  if (!res.ok) throw await etsyErrorFrom(res);
  return (await res.json()) as TokenResponse;
}

export const exchangeCode = (code: string, verifier: string, redirectUri: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

// --- stored connection (PostgREST, caller's JWT, RLS owner-only) ---

interface ConnectionRow {
  user_id: string;
  etsy_user_id: number;
  shop_id: number;
  tokens: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
}

function rest(authHeader: string) {
  const config = getSupabaseConfig();
  if (!config) throw new EtsyError(500, "Supabase is not configured on the server.");
  return {
    url: `${config.url}/rest/v1/etsy_connections`,
    headers: { Authorization: authHeader, apikey: config.key },
  };
}

export async function saveConnection(
  authHeader: string,
  userId: string,
  shopId: number,
  tokens: TokenResponse
): Promise<void> {
  const r = rest(authHeader);
  const now = Date.now();
  const row: ConnectionRow = {
    user_id: userId,
    // Etsy access tokens are "<numeric user id>.<token>".
    etsy_user_id: Number(tokens.access_token.split(".")[0]),
    shop_id: shopId,
    tokens: seal({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
    access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(now + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
  };
  const res = await fetch(`${r.url}?on_conflict=user_id`, {
    method: "POST",
    headers: {
      ...r.headers,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new EtsyError(500, `Couldn't save the Etsy connection: ${await res.text()}`);
}

export async function deleteConnection(authHeader: string, userId: string): Promise<void> {
  const r = rest(authHeader);
  const res = await fetch(`${r.url}?user_id=eq.${userId}`, {
    method: "DELETE",
    headers: r.headers,
  });
  if (!res.ok) throw new EtsyError(500, `Couldn't disconnect Etsy: ${await res.text()}`);
}

/** A usable access token and the shop it belongs to, refreshing when
 * needed; null when the user hasn't connected (or must reconnect). */
export async function etsyAccess(
  authHeader: string,
  userId: string
): Promise<{ accessToken: string; shopId: number } | null> {
  const r = rest(authHeader);
  const res = await fetch(`${r.url}?select=*&user_id=eq.${userId}`, { headers: r.headers });
  if (!res.ok) throw new EtsyError(500, `Couldn't read the Etsy connection: ${await res.text()}`);
  const [row] = (await res.json()) as ConnectionRow[];
  if (!row) return null;

  let tokens: Tokens;
  try {
    tokens = unseal<Tokens>(row.tokens);
  } catch {
    return null; // shared secret rotated: reconnect
  }
  if (Date.parse(row.access_expires_at) - EXPIRY_MARGIN_MS > Date.now()) {
    return { accessToken: tokens.access_token, shopId: row.shop_id };
  }
  if (Date.parse(row.refresh_expires_at) <= Date.now()) return null;
  try {
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    await saveConnection(authHeader, userId, row.shop_id, fresh);
    return { accessToken: fresh.access_token, shopId: row.shop_id };
  } catch (e) {
    // A rejected refresh token means the grant is gone; anything else
    // (network, Etsy 5xx) is worth surfacing as-is.
    if (e instanceof EtsyError && (e.status === 400 || e.status === 401)) return null;
    throw e;
  }
}

/** JSON error response for a route's catch block. */
export function etsyErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unknown error";
  // Etsy's 4xx pass through (the client reads any 4xx as "nothing was
  // created"); anything else from upstream is a 502.
  const status =
    error instanceof EtsyError
      ? error.status >= 400 && error.status < 500
        ? error.status
        : error.status === 500
          ? 500
          : 502
      : 500;
  return Response.json({ error: message }, { status });
}
