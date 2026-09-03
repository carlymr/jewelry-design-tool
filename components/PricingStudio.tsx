"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  DollarSign,
  Download,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import { useSession } from "@/components/AuthGate";
import { apiHeaders } from "@/lib/auth";
import { listDesigns, updateDesign } from "@/lib/designs";
import { resolveSetting } from "@/lib/bezel-fit";
import {
  loadPricingSettings,
  savePricingSettings,
  type PricingSettings as Settings,
} from "@/lib/settings";
import type {
  Design,
  DesignExtra,
  DesignListing,
  Material,
} from "@/lib/types";

const MM_PER_INCH = 25.4;
const FALLBACK_BEAD_MM = 6;
const SETTINGS_KEY = "pricing-settings";
// Working-copy draft persisted to localStorage so a design switch, reload, or
// tab close can't lose an unsaved (and paid-for) generated listing — same
// safety net as the design board's strand draft.
const DRAFT_KEY = "pricing-draft";

interface PricingDraft {
  selectedId: string | null;
  laborHours: string;
  extras: DesignExtra[];
  listing: DesignListing | null;
}

// Business-wide knobs, shared across designs (kept as strings so inputs can
// be cleared while typing, like the original artifact tool). Templates keep
// title/description format consistent across the whole store. The store of
// record is user_settings in the DB (lib/settings.ts); localStorage is a
// cache and offline fallback.
const DEFAULT_SETTINGS: Settings = {
  hourly_rate: "25",
  overhead_pct: "15",
  markup_pct: "200",
  style_guidelines: "",
  title_template: "",
  description_template: "",
};

function loadLocalSettings(key: string): Settings | null {
  try {
    // Fall back to the pre-auth global key so rates saved before per-user
    // namespacing carry over to the first account that signs in.
    const raw = localStorage.getItem(key) ?? localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // fall through to null
  }
  return null;
}

interface Props {
  materials: Material[];
}

export default function PricingStudio({ materials }: Props) {
  // Settings and drafts are namespaced per account so nothing leaks between
  // sign-ins on a shared browser.
  const session = useSession();
  const settingsKey = `${SETTINGS_KEY}:${session?.user.id ?? "local"}`;
  const draftKey = `${DRAFT_KEY}:${session?.user.id ?? "local"}`;

  const [designs, setDesigns] = useState<Design[]>([]);
  const [designsLoaded, setDesignsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  // per-design pricing inputs
  const [laborHours, setLaborHours] = useState("");
  const [extras, setExtras] = useState<DesignExtra[]>([]);
  const [listing, setListing] = useState<DesignListing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Both config panels start collapsed: they're set-once knobs, and the point
  // of the page is the listing, not the configuration.
  const [showTemplates, setShowTemplates] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [showExtraSearch, setShowExtraSearch] = useState(false);
  const [extraSearch, setExtraSearch] = useState("");

  const materialById = useMemo(
    () => new Map(materials.map((m) => [m.id, m])),
    [materials]
  );

  // --- settings: DB first, localStorage as fallback (and one-time migration
  // source for pre-0009 users, whose only copy is local) ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = loadLocalSettings(settingsKey);
      try {
        const remote = await loadPricingSettings();
        if (cancelled) return;
        if (remote) {
          const merged = { ...DEFAULT_SETTINGS, ...remote };
          setSettings(merged);
          try {
            localStorage.setItem(settingsKey, JSON.stringify(merged));
          } catch {
            // cache refresh only
          }
        } else if (local) {
          setSettings(local);
          savePricingSettings(local).catch(() => {
            // still cached locally; the next edit retries
          });
        }
      } catch {
        if (!cancelled && local) setSettings(local);
      } finally {
        if (!cancelled) setSettingsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsKey]);

  // Debounced DB write so typing in a template doesn't upsert per keystroke;
  // localStorage is written synchronously as the safety net in between.
  const SETTINGS_SAVE_ERROR =
    "Couldn't save settings to your account — they're kept on this device for now.";
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<Settings | null>(null);
  const flushSettings = (next: Settings) =>
    savePricingSettings(next)
      .then(() => {
        if (pendingSettings.current === next) pendingSettings.current = null;
        // A transient failure shouldn't leave the banner up after a save lands.
        setError((e) => (e === SETTINGS_SAVE_ERROR ? "" : e));
      })
      .catch(() => setError(SETTINGS_SAVE_ERROR));
  const updateSettings = (fields: Partial<Settings>) => {
    const next = { ...settings, ...fields };
    setSettings(next);
    try {
      localStorage.setItem(settingsKey, JSON.stringify(next));
    } catch {
      // losing the cache is fine
    }
    pendingSettings.current = next;
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    settingsSaveTimer.current = setTimeout(() => flushSettings(next), 800);
  };
  // The panels' explicit Save buttons: write immediately and re-collapse, so
  // a long templates panel doesn't stay parked above the listing.
  const saveSettingsAndClose = (collapse: () => void) => {
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
    if (pendingSettings.current) flushSettings(pendingSettings.current);
    collapse();
  };
  useEffect(
    () => () => {
      // Flush a pending settings write on unmount so navigating away right
      // after an edit doesn't drop it.
      if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current);
      if (pendingSettings.current)
        savePricingSettings(pendingSettings.current).catch(() => {});
    },
    []
  );

  // --- read any unsaved draft (must be declared before the persist effect:
  // both run on mount, and the clean-state persist would clear it first) ---
  const draftRef = useRef<PricingDraft | null>(null);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) draftRef.current = JSON.parse(raw);
    } catch {
      // A corrupt draft shouldn't break the page.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- persist the working copy while dirty; clear it once saved/discarded ---
  useEffect(() => {
    try {
      if (!dirty) {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ selectedId, laborHours, extras, listing })
        );
      }
    } catch {
      // Quota/private-mode failures just lose the safety net, nothing else.
    }
  }, [dirty, selectedId, laborHours, extras, listing, draftKey]);

  const applyDesign = (design: Design) => {
    setSelectedId(design.id);
    setLaborHours(
      design.pricing?.labor_hours ? String(design.pricing.labor_hours) : ""
    );
    setExtras(design.pricing?.extras ?? []);
    setListing(design.listing);
    setDirty(false);
    setShowExtraSearch(false);
    setError("");
  };

  useEffect(() => {
    listDesigns()
      .then((loaded) => {
        setDesigns(loaded);
        setDesignsLoaded(true);
        const draft = draftRef.current;
        const draftDesign = draft?.selectedId
          ? loaded.find((d) => d.id === draft.selectedId)
          : undefined;
        if (draft && draftDesign) {
          applyDesign(draftDesign);
          if (typeof draft.laborHours === "string") setLaborHours(draft.laborHours);
          if (Array.isArray(draft.extras)) setExtras(draft.extras);
          if (draft.listing !== undefined) setListing(draft.listing);
          setDirty(true);
        } else if (loaded.length > 0) {
          applyDesign(loaded[0]);
        }
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load designs")
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const design = designs.find((d) => d.id === selectedId) ?? null;

  const switchDesign = (id: string) => {
    if (
      dirty &&
      !confirm(
        `Discard unsaved pricing/listing changes for "${design?.name ?? "this design"}"?`
      )
    )
      return;
    const next = designs.find((d) => d.id === id);
    if (next) applyDesign(next);
  };

  // --- materials usage derived from the actual design ---
  const beadUsage = useMemo(() => {
    if (!design) return [];
    const counts = new Map<string, number>();
    const add = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const b of design.beads ?? []) {
      add(b.material_id);
      // A cabochon's bezel setting (GRA-29) is used material like any other;
      // the shared resolver drops a stale one exactly as the board does.
      const setting = resolveSetting(b, materialById);
      if (setting) add(setting.id);
    }
    return Array.from(counts, ([materialId, count]) => {
      const material = materialById.get(materialId) ?? null;
      return {
        materialId,
        material,
        count,
        cost: (material?.unit_cost ?? 0) * count,
      };
    }).sort((a, b) =>
      (a.material?.name ?? "").localeCompare(b.material?.name ?? "")
    );
  }, [design, materialById]);

  const strandIn = useMemo(() => {
    if (!design) return 0;
    const mm = (design.beads ?? []).reduce(
      (sum, b) =>
        sum + (materialById.get(b.material_id)?.visual?.length_mm ?? FALLBACK_BEAD_MM),
      0
    );
    return mm / MM_PER_INCH;
  }, [design, materialById]);

  // --- cost math (same model as the original artifact tool) ---
  const costs = useMemo(() => {
    const beadsCost = beadUsage.reduce((sum, u) => sum + u.cost, 0);
    const extrasCost = extras.reduce(
      (sum, e) => sum + (materialById.get(e.material_id)?.unit_cost ?? 0) * e.quantity,
      0
    );
    const materialsCost = beadsCost + extrasCost;
    const laborCost =
      (parseFloat(laborHours) || 0) * (parseFloat(settings.hourly_rate) || 0);
    const directCosts = materialsCost + laborCost;
    const overhead = directCosts * ((parseFloat(settings.overhead_pct) || 0) / 100);
    const totalCost = directCosts + overhead;
    const sellingPrice = totalCost * ((parseFloat(settings.markup_pct) || 0) / 100);
    return {
      materialsCost,
      laborCost,
      overhead,
      totalCost,
      sellingPrice,
      profit: sellingPrice - totalCost,
    };
  }, [beadUsage, extras, laborHours, settings, materialById]);

  // --- extras editing ---
  const addExtra = (material: Material) => {
    const existing = extras.find((e) => e.material_id === material.id);
    setExtras(
      existing
        ? extras.map((e) =>
            e.material_id === material.id ? { ...e, quantity: e.quantity + 1 } : e
          )
        : [...extras, { material_id: material.id, quantity: 1 }]
    );
    setDirty(true);
    setShowExtraSearch(false);
    setExtraSearch("");
  };

  const setExtraQuantity = (materialId: string, quantity: number) => {
    setExtras(
      extras.map((e) => (e.material_id === materialId ? { ...e, quantity } : e))
    );
    setDirty(true);
  };

  const removeExtra = (materialId: string) => {
    setExtras(extras.filter((e) => e.material_id !== materialId));
    setDirty(true);
  };

  // Deleted inventory items price as $0, which silently understates the
  // totals — surface it once, above the materials list.
  const missingCount =
    beadUsage.filter((u) => !u.material).length +
    extras.filter((e) => !materialById.get(e.material_id)).length;

  const extraCandidates = useMemo(() => {
    const term = extraSearch.toLowerCase();
    return materials
      .filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.category.toLowerCase().includes(term)
      )
      .slice(0, 30);
  }, [materials, extraSearch]);

  // --- listing generation ---
  const generateListing = async () => {
    if (!design) return;
    if (listing && !confirm("Replace the current listing? Any edits to it will be lost."))
      return;
    setGenerating(true);
    setError("");
    try {
      // Names alone lose treatments (a dyed "galaxy" tiger's eye is inventoried
      // as plain Tiger's Eye per the naming standard), so send the stored
      // visual and the verbatim supplier listing too — the route folds them
      // into the prompt so colors come from the actual beads.
      const toListingMaterial = (m: Material, quantity: number) => ({
        name: m.name,
        quantity,
        visual: m.visual ?? undefined,
        source: m.source
          ? {
              listing_title: m.source.listing_title.slice(0, 1000),
              variation: m.source.variation?.slice(0, 1000) ?? null,
            }
          : undefined,
      });
      const usedMaterials = [
        ...beadUsage
          .filter((u) => u.material)
          .map((u) => toListingMaterial(u.material!, u.count)),
        ...extras
          .flatMap((e) => {
            const m = materialById.get(e.material_id);
            return m && e.quantity > 0 ? [toListingMaterial(m, e.quantity)] : [];
          }),
      ];
      if (usedMaterials.length === 0) {
        setError("This design has no materials to describe yet.");
        return;
      }
      const res = await fetch("/api/generate-listing", {
        method: "POST",
        headers: await apiHeaders(),
        body: JSON.stringify({
          design_name: design.name,
          materials: usedMaterials,
          price: costs.sellingPrice,
          labor_hours: parseFloat(laborHours) || undefined,
          length_in: strandIn > 0 ? strandIn : undefined,
          style_guidelines: settings.style_guidelines || undefined,
          title_template: settings.title_template || undefined,
          description_template: settings.description_template || undefined,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      setListing({ ...result.listing, price: costs.sellingPrice });
      setDirty(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate listing");
    } finally {
      setGenerating(false);
    }
  };

  const updateListing = (fields: Partial<DesignListing>) => {
    if (!listing) return;
    setListing({ ...listing, ...fields });
    setDirty(true);
  };

  const saveToDesign = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError("");
    try {
      const saved = await updateDesign(selectedId, {
        pricing: { labor_hours: parseFloat(laborHours) || 0, extras },
        listing,
      });
      setDesigns(designs.map((d) => (d.id === saved.id ? saved : d)));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const listingText = listing
    ? `TITLE:\n${listing.title}\n\nDESCRIPTION:\n${listing.description}\n\nTAGS:\n${listing.tags.join(", ")}\n\nPRICE: $${listing.price.toFixed(2)}`
    : "";

  const downloadListing = () => {
    const blob = new Blob([listingText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(design?.name ?? "listing").replace(/[^\w-]+/g, "-")}-etsy-listing.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (designsLoaded && designs.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p className="mb-2">No saved designs yet.</p>
        <p className="text-sm">
          Build and save a strand on the Design Board first — pricing works from
          the actual beads in a design.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Design picker */}
      <div className="bg-gray-50 p-4 rounded-lg flex flex-wrap items-center gap-3">
        <select
          value={selectedId ?? ""}
          onChange={(e) => switchDesign(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {design && (
          <span className="text-sm text-gray-600">
            {design.beads?.length ?? 0} beads · {strandIn.toFixed(2)}&quot;
          </span>
        )}
        <button
          onClick={saveToDesign}
          disabled={saving || !dirty}
          className="ml-auto flex items-center px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
        >
          <Save className="w-4 h-4 mr-1" />
          {saving ? "Saving…" : dirty ? "Save to design" : "Saved"}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* The listing is the point of the page, so it leads (and comes first on
          mobile); costs and materials sit in a sidebar on desktop. */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 items-start">
        {/* Main column: the listing */}
        <div className="lg:col-span-3 bg-gray-50 p-6 rounded-lg">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <h2 className="text-xl font-semibold flex-1">Etsy Listing</h2>
            <button
              onClick={() => setShowTemplates((s) => !s)}
              className={`flex items-center px-3 py-2 border rounded-md text-sm ${
                showTemplates
                  ? "bg-purple-100 border-purple-300 text-purple-800"
                  : "bg-white border-gray-300 hover:bg-gray-100"
              }`}
            >
              <Pencil className="w-4 h-4 mr-1" />
              Templates &amp; style
            </button>
            <button
              onClick={generateListing}
              // Gated on settingsLoaded so a click right after page load can't
              // draft a listing (and price it) from default rates and empty
              // templates while the account's real settings are still in flight.
              disabled={
                generating ||
                !settingsLoaded ||
                !design ||
                (design.beads?.length ?? 0) + extras.length === 0
              }
              className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center text-sm"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              {generating
                ? "Generating…"
                : listing
                  ? "Regenerate"
                  : "Generate Listing"}
            </button>
          </div>

          {showTemplates && (
            <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg space-y-4">
              {!settingsLoaded ? (
                <p className="text-sm text-gray-500">Loading settings…</p>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Title Template (Optional)
                    </label>
                    <input
                      type="text"
                      value={settings.title_template}
                      onChange={(e) =>
                        updateSettings({ title_template: e.target.value })
                      }
                      placeholder='e.g., [Primary stone] [type of piece] - [length] - [color]'
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500 font-mono text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Bracketed placeholders are filled in from the design; the
                      rest is kept verbatim, so every listing title has the same
                      shape.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Description Template (Optional)
                    </label>
                    <textarea
                      value={settings.description_template}
                      onChange={(e) =>
                        updateSettings({ description_template: e.target.value })
                      }
                      rows={4}
                      placeholder={
                        "Outline every description follows, e.g.:\n[One-sentence hook]\n\nMaterials: [stones and metals]\nLength: [length]\n\n[Care instructions]"
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Style Guidelines (Optional)
                    </label>
                    <textarea
                      value={settings.style_guidelines}
                      onChange={(e) =>
                        updateSettings({ style_guidelines: e.target.value })
                      }
                      rows={3}
                      placeholder="e.g., Use elegant, luxury language. Focus on healing properties. Mention handcrafted quality and uniqueness."
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-500">
                      Applied to every listing in the store and saved to your
                      account.
                    </p>
                    <button
                      onClick={() => saveSettingsAndClose(() => setShowTemplates(false))}
                      className="flex items-center px-3 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-sm shrink-0"
                    >
                      <Save className="w-4 h-4 mr-1" />
                      Save &amp; close
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {listing ? (
            <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Title (140 characters max)
                </label>
                <textarea
                  value={listing.title}
                  onChange={(e) => updateListing({ title: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500"
                />
                <div className="text-xs text-gray-500 mt-1">
                  {listing.title.length}/140 characters
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description
                </label>
                <textarea
                  value={listing.description}
                  onChange={(e) => updateListing({ description: e.target.value })}
                  rows={12}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tags
                </label>
                <div className="flex flex-wrap gap-2">
                  {listing.tags.map((tag, index) => (
                    <span
                      key={index}
                      className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <h4 className="font-medium mb-2">Listing Price</h4>
                <div className="text-2xl font-bold text-purple-700">
                  ${listing.price.toFixed(2)}
                </div>
                {Math.abs(listing.price - costs.sellingPrice) > 0.005 && (
                  <p className="text-sm mt-2 px-3 py-2 bg-amber-100 border border-amber-300 text-amber-800 rounded">
                    Out of date — the calculator now suggests $
                    {costs.sellingPrice.toFixed(2)}. Regenerate or{" "}
                    <button
                      className="underline font-medium"
                      onClick={() => updateListing({ price: costs.sellingPrice })}
                    >
                      update the price
                    </button>
                    .
                  </p>
                )}
              </div>
              <div className="flex space-x-3">
                <button
                  onClick={() => navigator.clipboard.writeText(listingText)}
                  className="flex items-center px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Listing
                </button>
                <button
                  onClick={downloadListing}
                  className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">
              No listing yet — Generate drafts one from the design&apos;s actual
              materials and the calculated price.
            </p>
          )}
        </div>

        {/* Sidebar: price + materials */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-gradient-to-r from-purple-50 to-pink-50 p-6 rounded-lg border border-purple-200">
            <div className="flex items-center mb-4">
              <h3 className="text-lg font-semibold flex items-center flex-1">
                <DollarSign className="w-5 h-5 mr-2 text-purple-600" />
                Price
              </h3>
              <button
                onClick={() => setShowRates((s) => !s)}
                className={`flex items-center px-2 py-1 border rounded-md text-xs ${
                  showRates
                    ? "bg-purple-100 border-purple-300 text-purple-800"
                    : "bg-white border-purple-200 text-gray-700 hover:bg-purple-50"
                }`}
              >
                <Pencil className="w-3 h-3 mr-1" />
                Rates
              </button>
            </div>

            {showRates && (
              <div className="mb-4 p-3 bg-white border border-purple-200 rounded-lg space-y-3">
                {!settingsLoaded ? (
                  <p className="text-sm text-gray-500">Loading settings…</p>
                ) : (
                  <>
                    {(
                      [
                        ["Hourly Rate ($)", "hourly_rate"],
                        ["Overhead Rate (%)", "overhead_pct"],
                        ["Markup (%)", "markup_pct"],
                      ] as const
                    ).map(([label, field]) => (
                      <div key={field} className="flex items-center justify-between gap-3">
                        <label className="text-sm text-gray-700">{label}</label>
                        <input
                          type="number"
                          min={0}
                          value={settings[field]}
                          onChange={(e) => updateSettings({ [field]: e.target.value })}
                          className="w-24 px-2 py-1 border border-gray-300 rounded-md text-sm text-right"
                        />
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-gray-500">
                        Business-wide rates, saved to your account.
                      </p>
                      <button
                        onClick={() => saveSettingsAndClose(() => setShowRates(false))}
                        className="flex items-center px-2 py-1 bg-purple-600 text-white rounded-md hover:bg-purple-700 text-xs shrink-0"
                      >
                        <Save className="w-3 h-3 mr-1" />
                        Save &amp; close
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex items-center justify-between mb-3 pb-3 border-b border-purple-200">
              <label className="text-sm text-gray-700">Labor Time (hours)</label>
              <input
                type="number"
                step="0.25"
                min={0}
                value={laborHours}
                onChange={(e) => {
                  setLaborHours(e.target.value);
                  setDirty(true);
                }}
                className="w-24 px-2 py-1 border border-gray-300 rounded-md text-sm text-right bg-white"
              />
            </div>

            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Materials:</span>
                <span className="font-medium">${costs.materialsCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Labor:</span>
                <span className="font-medium">${costs.laborCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Overhead:</span>
                <span className="font-medium">${costs.overhead.toFixed(2)}</span>
              </div>
              <div className="border-t pt-3 flex justify-between">
                <span className="font-semibold">Total Cost:</span>
                <span className="font-semibold">${costs.totalCost.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-lg">
                <span className="font-bold text-purple-700">Selling Price:</span>
                <span className="font-bold text-purple-700">
                  ${costs.sellingPrice.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Profit:</span>
                <span className="text-green-600 font-medium">
                  ${costs.profit.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Materials from the design */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold mb-3">Materials Used</h3>
            {missingCount > 0 && (
              <div className="mb-3 px-3 py-2 bg-amber-100 border border-amber-300 text-amber-800 rounded text-sm">
                {missingCount} material{missingCount > 1 ? "s" : ""} in this design{" "}
                {missingCount > 1 ? "are" : "is"} no longer in inventory and priced
                as $0 — totals understate the real cost.
              </div>
            )}
            {beadUsage.length === 0 && extras.length === 0 && (
              <p className="text-sm text-gray-500 mb-3">
                This design has no beads yet — add some on the Design Board.
              </p>
            )}
            <div className="space-y-2">
              {beadUsage.map((u) => (
                <div
                  key={u.materialId}
                  className="flex items-center gap-2 p-2 bg-white rounded-lg border border-gray-200"
                >
                  <span className="w-8 flex justify-center shrink-0">
                    <BeadSwatch
                      visual={u.material?.visual ?? null}
                      size={24}
                      seed={u.materialId}
                    />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-gray-900">
                      {u.material?.name ?? "(material no longer in inventory)"}
                    </span>
                    <span className="block text-xs text-gray-500">
                      × {u.count} · ${(u.material?.unit_cost ?? 0).toFixed(3)}/ea
                    </span>
                  </span>
                  <span className="text-sm font-medium shrink-0">
                    ${u.cost.toFixed(2)}
                  </span>
                </div>
              ))}
              {extras.map((e) => {
                const m = materialById.get(e.material_id);
                return (
                  <div
                    key={e.material_id}
                    className="flex items-center gap-2 p-2 bg-white rounded-lg border border-blue-200"
                  >
                    <span className="w-8 flex justify-center shrink-0">
                      <BeadSwatch visual={m?.visual ?? null} size={24} seed={e.material_id} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-900">
                        {m?.name ?? "(material no longer in inventory)"}
                        <span className="ml-2 text-xs text-blue-600">extra</span>
                      </span>
                      <span className="block text-xs text-gray-500">
                        ${(m?.unit_cost ?? 0).toFixed(3)}/ea
                      </span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={e.quantity}
                      onChange={(ev) =>
                        setExtraQuantity(e.material_id, parseFloat(ev.target.value) || 0)
                      }
                      className="w-16 px-2 py-1 text-sm border border-gray-300 rounded text-right"
                    />
                    <span className="text-sm font-medium w-14 text-right shrink-0">
                      ${((m?.unit_cost ?? 0) * e.quantity).toFixed(2)}
                    </span>
                    <button
                      onClick={() => removeExtra(e.material_id)}
                      className="text-red-500 hover:text-red-700 p-1"
                      title="Remove extra"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add clasps, wire, and other off-board materials */}
            <div className="mt-3">
              {showExtraSearch ? (
                <div className="p-3 bg-white border border-blue-200 rounded-lg">
                  <div className="flex justify-between items-center mb-3">
                    <h4 className="font-medium text-gray-900 text-sm">
                      Add material from inventory
                    </h4>
                    <button
                      onClick={() => setShowExtraSearch(false)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <input
                      type="text"
                      placeholder="Search by name or category…"
                      value={extraSearch}
                      onChange={(e) => setExtraSearch(e.target.value)}
                      className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md text-sm"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {extraCandidates.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => addExtra(m)}
                        className="w-full flex justify-between items-center gap-2 p-2 border border-gray-200 rounded hover:bg-blue-50 text-left"
                      >
                        <span className="text-sm text-gray-900 min-w-0">
                          {m.name}
                          <span className="ml-2 text-xs text-gray-500">
                            {m.category} · ${m.unit_cost.toFixed(3)}/ea
                          </span>
                        </span>
                        <span className="text-xs text-gray-500 shrink-0">
                          {m.quantity} in stock
                        </span>
                      </button>
                    ))}
                    {extraCandidates.length === 0 && (
                      <p className="text-center py-3 text-sm text-gray-500">
                        No materials match your search
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowExtraSearch(true)}
                  className="flex items-center px-3 py-2 bg-white border border-gray-300 rounded-md hover:bg-gray-100 text-sm"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add clasp, wire, or other material
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
