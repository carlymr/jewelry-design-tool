import { NextRequest, NextResponse } from "next/server";
import { authorizedUser } from "@/lib/api-token";
import {
  deleteConnection,
  etsyAccess,
  etsyErrorResponse,
  etsyFetch,
} from "@/lib/etsy-server";
import type { EtsyShopInfo } from "@/lib/etsy";

// GET: whether the caller has connected an Etsy shop, plus the choices the
// publish form needs from it (shipping and processing profiles, return
// policies, jewelry categories). DELETE: disconnect.

interface Paged<T> {
  results: T[];
}
interface TaxonomyNode {
  id: number;
  name: string;
  children: TaxonomyNode[];
}

// The seller taxonomy is global and changes rarely; keep it per instance.
let jewelryCategories: { id: number; path: string }[] | null = null;

async function loadJewelryCategories() {
  if (jewelryCategories) return jewelryCategories;
  const { results } = await etsyFetch<Paged<TaxonomyNode>>("/application/seller-taxonomy/nodes");
  // Fall back to the whole tree if Etsy ever renames the Jewelry root.
  const jewelry = results.find((n) => n.name === "Jewelry");
  const leaves: { id: number; path: string }[] = [];
  const walk = (node: TaxonomyNode, trail: string[]) => {
    if (!node.children?.length) leaves.push({ id: node.id, path: trail.join(" > ") });
    for (const child of node.children ?? []) walk(child, [...trail, child.name]);
  };
  if (jewelry) walk(jewelry, []);
  else for (const root of results) walk(root, [root.name]);
  jewelryCategories = leaves.sort((a, b) => a.path.localeCompare(b.path));
  return jewelryCategories;
}

export async function GET(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const access = await etsyAccess(request.headers.get("authorization")!, user.id);
    if (!access) return NextResponse.json({ connected: false } satisfies EtsyShopInfo);
    const { accessToken, shopId } = access;
    const auth = { accessToken };
    // Processing profiles and return policies are optional on a draft; a
    // refusal there shouldn't take the whole panel down.
    const optional = <T,>(p: Promise<Paged<T>>) => p.catch((): Paged<T> => ({ results: [] }));
    const [shop, shipping, readiness, returns, categories] = await Promise.all([
      etsyFetch<{ shop_name: string }>(`/application/shops/${shopId}`, auth),
      etsyFetch<Paged<{ shipping_profile_id: number; title: string; is_deleted?: boolean }>>(
        `/application/shops/${shopId}/shipping-profiles`,
        auth
      ),
      optional(
        etsyFetch<
          Paged<{ readiness_state_id: number; readiness_state: string; processing_days_display_label?: string }>
        >(`/application/shops/${shopId}/readiness-state-definitions?limit=100`, auth)
      ),
      optional(
        etsyFetch<
          Paged<{ return_policy_id: number; accepts_returns: boolean; accepts_exchanges: boolean; return_deadline: number | null }>
        >(`/application/shops/${shopId}/policies/return`, auth)
      ),
      loadJewelryCategories(),
    ]);
    const info: EtsyShopInfo = {
      connected: true,
      shop_name: shop.shop_name,
      shipping_profiles: shipping.results
        .filter((p) => !p.is_deleted)
        .map((p) => ({ id: p.shipping_profile_id, label: p.title })),
      processing_profiles: readiness.results.map((r) => ({
        id: r.readiness_state_id,
        label: [
          r.readiness_state === "ready_to_ship" ? "Ready to ship" : "Made to order",
          r.processing_days_display_label,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      return_policies: returns.results.map((r) => ({
        id: r.return_policy_id,
        label:
          r.accepts_returns || r.accepts_exchanges
            ? [
                r.accepts_returns && "Returns",
                r.accepts_exchanges && "Exchanges",
              ]
                .filter(Boolean)
                .join(" & ") + (r.return_deadline ? ` within ${r.return_deadline} days` : "")
            : "No returns or exchanges",
      })),
      categories,
    };
    return NextResponse.json(info);
  } catch (error) {
    return etsyErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    await deleteConnection(request.headers.get("authorization")!, user.id);
    return NextResponse.json({ connected: false } satisfies EtsyShopInfo);
  } catch (error) {
    return etsyErrorResponse(error);
  }
}
