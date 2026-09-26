"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Send } from "lucide-react";
import {
  DIMENSION_UNITS,
  EtsyApiError,
  WEIGHT_UNITS,
  WHEN_MADE_OPTIONS,
  type EtsyPackage,
  validWhenMade,
  disconnectEtsy,
  publishToEtsy,
  startEtsyConnect,
  type EtsyPublishResult,
  type EtsyShopInfo,
} from "@/lib/etsy";
import type { PricingSettings } from "@/lib/settings";
import { NECKLACE_MIN_MM } from "@/lib/strand-layout";
import type { Design, DesignListing } from "@/lib/types";

// Etsy on the pricing page (GRA-37). EtsyConnectionBar sits at the top of
// the page (connect / disconnect, always visible); EtsyPublish lives on the
// listing card and publishes the current listing to the connected shop as a
// draft. PricingStudio loads the shop info once and passes it to both.
// Shop-specific choices (category, shipping/processing profile, return
// policy, when made) are remembered in the account's pricing settings,
// with the category kept per piece type.

type ConnectedShop = Extract<EtsyShopInfo, { connected: true }>;

/** Connection status for the top of the pricing page. `shop` is null while
 * loading; `onChange` receives the new state after a disconnect. */
export function EtsyConnectionBar({
  shop,
  loadError,
  onRetry,
  onChange,
}: {
  shop: EtsyShopInfo | null;
  loadError: string;
  onRetry: () => void;
  onChange: (shop: EtsyShopInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      window.location.href = await startEtsyConnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the Etsy connection");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("Disconnect your Etsy shop? You can reconnect any time.")) return;
    setBusy(true);
    setError("");
    try {
      onChange(await disconnectEtsy());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't disconnect");
    } finally {
      setBusy(false);
    }
  };

  let content: React.ReactNode;
  if (loadError) {
    content = (
      <p className="text-sm text-red-700">
        Couldn&apos;t check your Etsy connection: {loadError}{" "}
        <button onClick={onRetry} className="underline font-medium">
          Retry
        </button>
      </p>
    );
  } else if (!shop) {
    content = <p className="text-sm text-gray-500">Checking your Etsy connection…</p>;
  } else if (!shop.connected) {
    content = (
      <>
        <p className="text-sm text-gray-700 flex-1 min-w-48">
          Connect your Etsy shop to publish listings as drafts.
          <span className="block text-xs text-gray-500">
            Etsy only redirects to the live site, so connect there; the
            connection then works everywhere you sign in.
          </span>
        </p>
        <button
          onClick={connect}
          disabled={busy}
          className="px-3 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm shrink-0"
        >
          {busy ? "Opening Etsy…" : "Connect Etsy shop"}
        </button>
      </>
    );
  } else {
    content = (
      <>
        <p className="text-sm text-gray-700 flex-1">
          Etsy: connected to <span className="font-medium">{shop.shop_name}</span>
        </p>
        <button
          onClick={disconnect}
          disabled={busy}
          className="text-xs text-gray-500 underline hover:text-gray-700"
        >
          Disconnect
        </button>
      </>
    );
  }

  return (
    // Orange only when something needs doing; connected is the everyday
    // state, so it stays quiet.
    <div
      className={`px-4 py-3 rounded-lg border ${
        shop?.connected && !loadError && !error
          ? "bg-white border-gray-200"
          : "bg-orange-50 border-orange-200"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">{content}</div>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}

interface Props {
  shop: ConnectedShop;
  design: Design;
  listing: DesignListing;
  photoPaths: string[];
  settings: PricingSettings;
  updateSettings: (fields: Partial<PricingSettings>) => void;
  onPublished: (result: EtsyPublishResult) => void;
}

const selectClass =
  "w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white";

export default function EtsyPublish({
  shop,
  design,
  listing,
  photoPaths,
  settings,
  updateSettings,
  onPublished,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [result, setResult] = useState<EtsyPublishResult | null>(null);

  const isBracelet = design.target_length_mm < NECKLACE_MIN_MM;
  const categoryKey = isBracelet ? "etsy_category_bracelet" : "etsy_category_necklace";

  // Per-design outcome; don't carry a previous design's result over.
  useEffect(() => {
    setResult(null);
    setShowForm(false);
    setError("");
  }, [design.id]);

  // Form values, seeded from remembered settings or a sensible default.
  const [form, setForm] = useState({
    category: "",
    shipping: "",
    processing: "",
    returns: "",
  });
  // Packaged weight/size, needed only with a calculated shipping profile.
  // Seeded from (and saved back to) settings: pieces usually ship alike.
  const [pkg, setPkg] = useState({
    weight: settings.etsy_item_weight,
    weightUnit: settings.etsy_item_weight_unit || "oz",
    length: settings.etsy_item_length,
    width: settings.etsy_item_width,
    height: settings.etsy_item_height,
    dimUnit: settings.etsy_item_dimensions_unit || "in",
  });
  const needsPackage = !!shop.shipping_profiles.find((p) => String(p.id) === form.shipping)
    ?.calculated;
  const pkgNumbers = [pkg.weight, pkg.length, pkg.width, pkg.height].map(Number);
  const packageReady = pkgNumbers.every((n) => Number.isFinite(n) && n > 0);
  useEffect(() => {
    const has = (list: { id: number }[], id: string) => list.some((o) => String(o.id) === id);
    const remembered = settings[categoryKey];
    const guess =
      shop.categories.find((c) =>
        isBracelet ? /^Bracelets > Beaded/.test(c.path) : /^Necklaces > Beaded/.test(c.path)
      ) ?? shop.categories.find((c) => c.path.startsWith(isBracelet ? "Bracelets" : "Necklaces"));
    setForm({
      category: has(shop.categories, remembered) ? remembered : guess ? String(guess.id) : "",
      shipping: has(shop.shipping_profiles, settings.etsy_shipping_profile_id)
        ? settings.etsy_shipping_profile_id
        : shop.shipping_profiles.length === 1
          ? String(shop.shipping_profiles[0].id)
          : "",
      processing: has(shop.processing_profiles, settings.etsy_processing_profile_id)
        ? settings.etsy_processing_profile_id
        : shop.processing_profiles[0]
          ? String(shop.processing_profiles[0].id)
          : "",
      returns: has(shop.return_policies, settings.etsy_return_policy_id)
        ? settings.etsy_return_policy_id
        : "",
    });
    // Seed when the shop loads or the piece type changes, not on every
    // settings write (which this form itself triggers).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, categoryKey]);

  const publish = async () => {
    if (
      design.etsy_listing_url &&
      !confirm("This design already links to an Etsy listing. Create another draft anyway?")
    )
      return;
    setBusy(true);
    setError("");
    setResult(null);
    updateSettings({
      [categoryKey]: form.category,
      etsy_shipping_profile_id: form.shipping,
      etsy_processing_profile_id: form.processing,
      etsy_return_policy_id: form.returns,
      ...(needsPackage
        ? {
            etsy_item_weight: pkg.weight,
            etsy_item_weight_unit: pkg.weightUnit,
            etsy_item_length: pkg.length,
            etsy_item_width: pkg.width,
            etsy_item_height: pkg.height,
            etsy_item_dimensions_unit: pkg.dimUnit,
          }
        : {}),
    });
    try {
      const res = await publishToEtsy({
        title: listing.title,
        description: listing.description,
        tags: listing.tags,
        materials: listing.materials,
        price: listing.price,
        taxonomy_id: Number(form.category),
        shipping_profile_id: Number(form.shipping),
        readiness_state_id: form.processing ? Number(form.processing) : undefined,
        return_policy_id: form.returns ? Number(form.returns) : undefined,
        package: needsPackage
          ? {
              item_weight: pkgNumbers[0],
              item_weight_unit: pkg.weightUnit as EtsyPackage["item_weight_unit"],
              item_length: pkgNumbers[1],
              item_width: pkgNumbers[2],
              item_height: pkgNumbers[3],
              item_dimensions_unit: pkg.dimUnit as EtsyPackage["item_dimensions_unit"],
            }
          : undefined,
        who_made: "i_did",
        when_made: validWhenMade(settings.etsy_when_made),
        photo_paths: photoPaths,
      });
      setResult(res);
      setShowForm(false);
      onPublished(res);
    } catch (e) {
      const message = (e instanceof Error ? e.message : "Publishing failed").replace(/\.$/, "");
      // A rejected request (4xx, e.g. Etsy refusing the draft) created
      // nothing. Anything else — a 5xx, a timeout, a lost response — may have
      // failed after the draft existed, so don't invite a blind retry.
      setError(
        e instanceof EtsyApiError && e.status < 500
          ? `${message}.`
          : `${message}. A draft may still have been created — check your Etsy drafts before publishing again.`
      );
    } finally {
      setBusy(false);
    }
  };

  const ready =
    !!form.category &&
    !!form.shipping &&
    listing.price > 0 &&
    (!needsPackage || packageReady);
  const body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-700 flex-1">
            Publishes to <span className="font-medium">{shop.shop_name}</span>
          </span>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              disabled={busy}
              className="flex items-center px-3 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 text-sm"
            >
              <Send className="w-4 h-4 mr-1" />
              {design.etsy_listing_url ? "Publish another draft…" : "Publish draft to Etsy…"}
            </button>
          )}
        </div>

        {showForm && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-gray-700 sm:col-span-2">
              Category ({isBracelet ? "bracelet" : "necklace"})
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className={`${selectClass} mt-1`}
              >
                <option value="">Choose a category…</option>
                {shop.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.path}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              Shipping profile
              <select
                value={form.shipping}
                onChange={(e) => setForm({ ...form, shipping: e.target.value })}
                className={`${selectClass} mt-1`}
              >
                <option value="">Choose…</option>
                {shop.shipping_profiles.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              Processing profile
              <select
                value={form.processing}
                onChange={(e) => setForm({ ...form, processing: e.target.value })}
                className={`${selectClass} mt-1`}
              >
                <option value="">Shop default</option>
                {shop.processing_profiles.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              Return policy
              <select
                value={form.returns}
                onChange={(e) => setForm({ ...form, returns: e.target.value })}
                className={`${selectClass} mt-1`}
              >
                <option value="">Shop default</option>
                {shop.return_policies.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-gray-700">
              When made
              <select
                value={validWhenMade(settings.etsy_when_made)}
                onChange={(e) => updateSettings({ etsy_when_made: e.target.value })}
                className={`${selectClass} mt-1`}
              >
                {WHEN_MADE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {needsPackage && (
              <fieldset className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-white border border-orange-200 rounded-md">
                <legend className="px-1 text-xs text-gray-600">
                  This shipping profile is calculated, so Etsy needs the packaged
                  weight and size
                </legend>
                <label className="text-sm text-gray-700">
                  Package weight
                  <span className="mt-1 flex gap-2">
                    <input
                      type="number"
                      min={0}
                      step="0.1"
                      value={pkg.weight}
                      onChange={(e) => setPkg({ ...pkg, weight: e.target.value })}
                      className={`${selectClass} flex-1 min-w-0`}
                    />
                    <select
                      value={pkg.weightUnit}
                      onChange={(e) => setPkg({ ...pkg, weightUnit: e.target.value })}
                      className={`${selectClass} w-20`}
                      aria-label="Weight unit"
                    >
                      {WEIGHT_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
                <div className="text-sm text-gray-700">
                  Package size (L × W × H)
                  <span className="mt-1 flex gap-2">
                    {(["length", "width", "height"] as const).map((dim) => (
                      <input
                        key={dim}
                        type="number"
                        min={0}
                        step="0.1"
                        value={pkg[dim]}
                        onChange={(e) => setPkg({ ...pkg, [dim]: e.target.value })}
                        className={`${selectClass} flex-1 min-w-0`}
                        aria-label={`Package ${dim}`}
                      />
                    ))}
                    <select
                      value={pkg.dimUnit}
                      onChange={(e) => setPkg({ ...pkg, dimUnit: e.target.value })}
                      className={`${selectClass} w-20`}
                      aria-label="Size unit"
                    >
                      {DIMENSION_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
              </fieldset>
            )}
            <p className="text-xs text-gray-500 sm:col-span-2">
              Creates a draft (not visible to buyers) with the title, description,
              tags, {listing.materials?.length ? "materials, " : ""}price $
              {listing.price.toFixed(2)}, quantity 1, and{" "}
              {photoPaths.length
                ? `${photoPaths.length} photo${photoPaths.length > 1 ? "s" : ""} in the order shown above`
                : "no photos"}
              . Review and activate it on Etsy.
            </p>
            <div className="flex gap-2 sm:col-span-2">
              <button
                onClick={publish}
                disabled={busy || !ready}
                className="flex items-center px-3 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                <Send className="w-4 h-4 mr-1" />
                {busy ? "Publishing…" : "Publish draft"}
              </button>
              <button
                onClick={() => setShowForm(false)}
                disabled={busy}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white hover:bg-gray-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </>
  );

  return (
    <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg">
      <h4 className="text-sm font-medium text-gray-800 mb-2">Etsy</h4>
      {body}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      {result && (
        <div className="mt-2 text-sm text-gray-800">
          Draft created.{" "}
          <a
            href={result.edit_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-orange-700 underline font-medium"
          >
            Open it in Etsy&apos;s listing editor
            <ExternalLink className="w-3 h-3 ml-1" />
          </a>
          {result.photo_errors.length > 0 && (
            <ul className="mt-1 text-amber-800 list-disc pl-5">
              {result.photo_errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
