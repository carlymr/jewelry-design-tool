import { getSupabaseConfig } from "./supabase-config";

// Per-user hourly caps on the AI routes (GRA-18). Every call is recorded in
// public.api_usage through the record_ai_call() RPC (migration 0012) with the
// caller's own JWT — the table has no policies, so the function is the only
// way in and a user can't reset their own counter. Server-side and fetch-only,
// like the rest of the route helpers (no supabase-js in server bundles).
//
// This is defense-in-depth against runaway Anthropic spend, not a
// correctness guard: if the RPC fails for any reason (function not applied
// yet, DB hiccup) the call is ALLOWED and the failure logged. Rate limiting
// must never take receipt processing down.

export type AiRoute =
  | "process-receipt"
  | "generate-visuals"
  | "generate-listing"
  | "analyze-photo";

/** Calls per rolling hour across every AI route. */
export const HOURLY_LIMIT = 60;
/** Tighter per-route caps; anything not listed falls under HOURLY_LIMIT only. */
export const ROUTE_HOURLY_LIMITS: Partial<Record<AiRoute, number>> = {
  "process-receipt": 20,
};

const ROUTE_LABELS: Partial<Record<AiRoute, string>> = {
  "process-receipt": "receipt processing",
};

/** Records this call and returns a 429 Response if the caller is over
 * limit, or null to proceed. Call right after the auth check, before any
 * Anthropic request. Rejected calls still count (the RPC records before it
 * counts), which is the intended "back off" behavior. */
export async function enforceRateLimit(
  request: Request,
  route: AiRoute
): Promise<Response | null> {
  const config = getSupabaseConfig();
  const auth = request.headers.get("authorization");
  if (!config || !auth) return null;

  let usage: { total: number; route: number };
  try {
    const res = await fetch(`${config.url}/rest/v1/rpc/record_ai_call`, {
      method: "POST",
      // A hung RPC must fail open like an erroring one, not eat the route's
      // time budget; the abort throws into the catch below.
      signal: AbortSignal.timeout(3000),
      headers: {
        Authorization: auth,
        apikey: config.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_route: route }),
    });
    if (!res.ok) {
      throw new Error(`record_ai_call responded ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { total?: unknown; route?: unknown };
    if (typeof json.total !== "number" || typeof json.route !== "number") {
      throw new Error(`record_ai_call returned an unexpected shape: ${JSON.stringify(json)}`);
    }
    usage = { total: json.total, route: json.route };
  } catch (error) {
    // Fail open: log and let the call through.
    console.error(`Rate limit check failed for ${route}; allowing the call.`, error);
    return null;
  }

  const routeLimit = ROUTE_HOURLY_LIMITS[route];
  if (routeLimit !== undefined && usage.route > routeLimit) {
    return limitResponse(
      `You've hit the hourly limit for ${ROUTE_LABELS[route] ?? route} (${routeLimit}/hour). Try again in a bit.`
    );
  }
  if (usage.total > HOURLY_LIMIT) {
    return limitResponse(
      `You've hit the hourly limit for AI features (${HOURLY_LIMIT}/hour). Try again in a bit.`
    );
  }
  return null;
}

function limitResponse(error: string): Response {
  return Response.json({ error }, { status: 429 });
}
