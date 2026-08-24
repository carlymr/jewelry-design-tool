"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  DollarSign,
  Download,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import { apiHeaders } from "@/lib/api-token";
import { listDesigns, updateDesign } from "@/lib/designs";
import type {
  Design,
  DesignExtra,
  DesignListing,
  Material,
} from "@/lib/types";

const MM_PER_INCH = 25.4;
const FALLBACK_BEAD_MM = 6;
const SETTINGS_KEY = "pricing-settings";

// Business-wide knobs, shared across designs (kept as strings so inputs can
// be cleared while typing, like the original artifact tool).
interface Settings {
  hourly_rate: string;
  overhead_pct: string;
  markup_pct: string;
  style_guidelines: string;
}

const DEFAULT_SETTINGS: Settings = {
  hourly_rate: "25",
  overhead_pct: "15",
  markup_pct: "200",
  style_guidelines: "",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // fall through to defaults
  }
  return DEFAULT_SETTINGS;
}

interface Props {
  materials: Material[];
}

export default function PricingStudio({ materials }: Props) {
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
  const [showExtraSearch, setShowExtraSearch] = useState(false);
  const [extraSearch, setExtraSearch] = useState("");

  const materialById = useMemo(
    () => new Map(materials.map((m) => [m.id, m])),
    [materials]
  );

  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  const updateSettings = (fields: Partial<Settings>) => {
    const next = { ...settings, ...fields };
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // losing persistence is fine
    }
  };

  const applyDesign = (design: Design) => {
    setSelectedId(design.id);
    setLaborHours(
      design.pricing?.labor_hours ? String(design.pricing.labor_hours) : ""
    );
    setExtras(design.pricing?.extras ?? []);
    setListing(design.listing);
    setDirty(false);
    setShowExtraSearch(false);
  };

  useEffect(() => {
    listDesigns()
      .then((loaded) => {
        setDesigns(loaded);
        setDesignsLoaded(true);
        if (loaded.length > 0) applyDesign(loaded[0]);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load designs")
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const design = designs.find((d) => d.id === selectedId) ?? null;

  const switchDesign = (id: string) => {
    if (dirty && !confirm("Discard unsaved pricing/listing changes?")) return;
    const next = designs.find((d) => d.id === id);
    if (next) applyDesign(next);
  };

  // --- materials usage derived from the actual design ---
  const beadUsage = useMemo(() => {
    if (!design) return [];
    const counts = new Map<string, number>();
    for (const b of design.beads ?? []) {
      counts.set(b.material_id, (counts.get(b.material_id) ?? 0) + 1);
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
    setGenerating(true);
    setError("");
    try {
      const usedMaterials = [
        ...beadUsage
          .filter((u) => u.material)
          .map((u) => ({ name: u.material!.name, quantity: u.count })),
        ...extras
          .map((e) => ({
            name: materialById.get(e.material_id)?.name ?? "",
            quantity: e.quantity,
          }))
          .filter((m) => m.name && m.quantity > 0),
      ];
      if (usedMaterials.length === 0) {
        setError("This design has no materials to describe yet.");
        return;
      }
      const res = await fetch("/api/generate-listing", {
        method: "POST",
        headers: apiHeaders(),
        body: JSON.stringify({
          design_name: design.name,
          materials: usedMaterials,
          price: costs.sellingPrice,
          labor_hours: parseFloat(laborHours) || undefined,
          length_in: strandIn > 0 ? strandIn : undefined,
          style_guidelines: settings.style_guidelines || undefined,
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
    <div className="space-y-6">
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

      {/* Materials from the design */}
      <div className="bg-gray-50 p-6 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">Materials Used</h2>
        {beadUsage.length === 0 && extras.length === 0 && (
          <p className="text-sm text-gray-500 mb-3">
            This design has no beads yet — add some on the Design Board.
          </p>
        )}
        <div className="space-y-2">
          {beadUsage.map((u) => (
            <div
              key={u.materialId}
              className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200"
            >
              <span className="w-9 flex justify-center shrink-0">
                <BeadSwatch
                  visual={u.material?.visual ?? null}
                  size={28}
                  seed={u.materialId}
                />
              </span>
              <span className="flex-1 text-sm text-gray-900 min-w-0">
                {u.material?.name ?? "(material no longer in inventory)"}
              </span>
              <span className="text-sm text-gray-600 w-20 text-right">
                × {u.count}
              </span>
              <span className="text-sm text-gray-600 w-24 text-right">
                ${(u.material?.unit_cost ?? 0).toFixed(3)}/ea
              </span>
              <span className="text-sm font-medium w-20 text-right">
                ${u.cost.toFixed(2)}
              </span>
            </div>
          ))}
          {extras.map((e) => {
            const m = materialById.get(e.material_id);
            return (
              <div
                key={e.material_id}
                className="flex items-center gap-3 p-3 bg-white rounded-lg border border-blue-200"
              >
                <span className="w-9 flex justify-center shrink-0">
                  <BeadSwatch visual={m?.visual ?? null} size={28} seed={e.material_id} />
                </span>
                <span className="flex-1 text-sm text-gray-900 min-w-0">
                  {m?.name ?? "(material no longer in inventory)"}
                  <span className="ml-2 text-xs text-blue-600">extra</span>
                </span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={e.quantity}
                  onChange={(ev) =>
                    setExtraQuantity(e.material_id, parseFloat(ev.target.value) || 0)
                  }
                  className="w-20 px-2 py-1 text-sm border border-gray-300 rounded text-right"
                />
                <span className="text-sm text-gray-600 w-24 text-right">
                  ${(m?.unit_cost ?? 0).toFixed(3)}/ea
                </span>
                <span className="text-sm font-medium w-20 text-right">
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
            <div className="p-4 bg-white border border-blue-200 rounded-lg">
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
                    className="w-full flex justify-between items-center p-2 border border-gray-200 rounded hover:bg-blue-50 text-left"
                  >
                    <span className="text-sm text-gray-900">
                      {m.name}
                      <span className="ml-2 text-xs text-gray-500">
                        {m.category} · ${m.unit_cost.toFixed(3)}/ea
                      </span>
                    </span>
                    <span className="text-xs text-gray-500">
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

      {/* Labor & overhead + cost breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-50 p-6 rounded-lg">
          <h3 className="text-lg font-semibold mb-4">Labor &amp; Overhead</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Labor Time (hours)
              </label>
              <input
                type="number"
                step="0.25"
                min={0}
                value={laborHours}
                onChange={(e) => {
                  setLaborHours(e.target.value);
                  setDirty(true);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Hourly Rate ($)
              </label>
              <input
                type="number"
                min={0}
                value={settings.hourly_rate}
                onChange={(e) => updateSettings({ hourly_rate: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Overhead Rate (%)
              </label>
              <input
                type="number"
                min={0}
                value={settings.overhead_pct}
                onChange={(e) => updateSettings({ overhead_pct: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Markup (%)
              </label>
              <input
                type="number"
                min={0}
                value={settings.markup_pct}
                onChange={(e) => updateSettings({ markup_pct: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-purple-50 to-pink-50 p-6 rounded-lg border border-purple-200">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <DollarSign className="w-5 h-5 mr-2 text-purple-600" />
            Cost Breakdown
          </h3>
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
      </div>

      {/* Listing generator */}
      <div className="bg-gray-50 p-6 rounded-lg">
        <h2 className="text-xl font-semibold mb-4">Etsy Listing</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Style Guidelines (Optional)
            </label>
            <textarea
              value={settings.style_guidelines}
              onChange={(e) => updateSettings({ style_guidelines: e.target.value })}
              rows={3}
              placeholder="e.g., Use elegant, luxury language. Focus on healing properties. Mention handcrafted quality and uniqueness."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500"
            />
          </div>
          <div className="flex justify-center">
            <button
              onClick={generateListing}
              disabled={generating || !design || (design.beads?.length ?? 0) + extras.length === 0}
              className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed flex items-center"
            >
              <Sparkles className="w-5 h-5 mr-2" />
              {generating
                ? "Generating…"
                : listing
                  ? "Regenerate Listing"
                  : "Generate Listing"}
            </button>
          </div>
        </div>
      </div>

      {listing && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Generated Listing</h3>
          <div className="space-y-4">
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
                <p className="text-xs text-gray-600 mt-1">
                  Current calculator suggests ${costs.sellingPrice.toFixed(2)} —
                  regenerate or{" "}
                  <button
                    className="underline text-purple-700"
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
        </div>
      )}
    </div>
  );
}
