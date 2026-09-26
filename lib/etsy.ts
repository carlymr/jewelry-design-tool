import { apiHeaders } from "./auth";

// Client wrappers for the Etsy routes (GRA-37). The server side lives in
// lib/etsy-server.ts; the routes import only this module's types.

export interface EtsyOption {
  id: number;
  label: string;
}

export type EtsyShopInfo =
  | { connected: false }
  | {
      connected: true;
      shop_name: string;
      shipping_profiles: EtsyOption[];
      processing_profiles: EtsyOption[];
      return_policies: EtsyOption[];
      /** Leaf jewelry categories, path relative to Jewelry ("Necklaces > Beaded Necklaces"). */
      categories: { id: number; path: string }[];
    };

export interface EtsyPublishRequest {
  title: string;
  description: string;
  tags: string[];
  materials?: string[];
  price: number;
  taxonomy_id: number;
  shipping_profile_id: number;
  readiness_state_id?: number;
  return_policy_id?: number;
  who_made: "i_did" | "someone_else" | "collective";
  when_made: string;
  photo_paths: string[];
}

export interface EtsyPublishResult {
  listing_id: number;
  /** Public URL; it resolves once the draft is activated. */
  listing_url: string;
  /** The seller's listing editor for the draft. */
  edit_url: string;
  photo_errors: string[];
}

/** Etsy's "when was it made" choices that fit this shop. The era value
 * follows Etsy's enum, which Etsy rolls forward over time. */
export const WHEN_MADE_OPTIONS = [
  ["2020_2026", "2020–2026 (already made)"],
  ["made_to_order", "Made to order"],
] as const;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: await apiHeaders() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

export const fetchEtsyShop = () => call<EtsyShopInfo>("/api/etsy/shop");

export const disconnectEtsy = () => call<EtsyShopInfo>("/api/etsy/shop", { method: "DELETE" });

/** The Etsy authorization URL to send the browser to. */
export const startEtsyConnect = async () =>
  (await call<{ url: string }>("/api/etsy/connect", { method: "POST" })).url;

export const finishEtsyConnect = (code: string, state: string) =>
  call<{ shop_id: number }>("/api/etsy/callback", {
    method: "POST",
    body: JSON.stringify({ code, state }),
  });

export const publishToEtsy = (req: EtsyPublishRequest) =>
  call<EtsyPublishResult>("/api/etsy/publish", {
    method: "POST",
    body: JSON.stringify(req),
  });
