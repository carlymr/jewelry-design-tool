"use client";

import GenericBadge from "@/components/GenericBadge";
import { isGeneric } from "@/lib/generic-catalog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  Copy,
  DollarSign,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import EtsyPublish, { EtsyConnectionBar } from "@/components/EtsyPublish";
import { CURRENT_ERA_WHEN_MADE, fetchEtsyShop, type EtsyShopInfo } from "@/lib/etsy";
import { useSession } from "@/components/AuthGate";
import { apiHeaders } from "@/lib/auth";
import { listDesigns, updateDesign } from "@/lib/designs";
import {
  deleteDesignPhotos,
  designPhotoUrls,
  uploadDesignPhoto,
} from "@/lib/design-photos";
import { resolveSetting } from "@/lib/bezel-fit";
import {
  loadPricingSettings,
  savePricingSettings,
  type PricingSettings as Settings,
} from "@/lib/settings";
import {
  DESIGN_STATUSES,
  DESIGN_STATUS_LABELS,
  MAX_DESIGN_PHOTOS,
  type Design,
  type DesignExtra,
  type DesignListing,
  type DesignStatus,
  type Material,
} from "@/lib/types";

const MM_PER_INCH = 25.4;
const FALLBACK_BEAD_MM = 6;
const SETTINGS_KEY = "pricing-settings";
// Working-copy draft persisted to localStorage so a design switch, reload, or
// tab close can't lose an unsaved (and paid-for) generated listing — same
// safety net as the design board's strand draft.
const DRAFT_KEY = "pricing-draft";
// Pricing inputs and the listing autosave to the design this long after the
// last edit; the localStorage draft covers the gap and failed saves.
const AUTOSAVE_MS = 1000;

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
// Selling-price rounding choices for the Rates panel ("0" = exact).
const ROUNDING_OPTIONS = [
  ["0", "Exact"],
  ["1", "Nearest $1"],
  ["5", "Nearest $5"],
  ["10", "Nearest $10"],
] as const;

const DEFAULT_SETTINGS: Settings = {
  hourly_rate: "25",
  overhead_pct: "15",
  markup_pct: "200",
  price_rounding: "0",
  etsy_when_made: CURRENT_ERA_WHEN_MADE,
  etsy_shipping_profile_id: "",
  etsy_processing_profile_id: "",
  etsy_return_policy_id: "",
  etsy_category_necklace: "",
  etsy_category_bracelet: "",
  etsy_item_weight: "",
  etsy_item_weight_unit: "oz",
  etsy_item_length: "",
  etsy_item_width: "",
  etsy_item_height: "",
  etsy_item_dimensions_unit: "in",
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

/** Where the picker row's Etsy link goes: the public listing once the piece
 * is live, the seller's listing editor before that, since a published draft's
 * public URL is a "not found" page until it's activated. */
function etsyLinkHref(url: string, status: DesignStatus): string {
  const id = /etsy\.com\/listing\/(\d+)/.exec(url)?.[1];
  return id && status !== "listed" && status !== "sold"
    ? `https://www.etsy.com/your/shops/me/listing-editor/edit/${id}`
    : url;
}

/** Copies one listing field for pasting into Etsy's form, which takes each
 * field separately. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {}
        )
      }
      className="flex items-center px-2 py-1 text-xs border border-gray-300 rounded-md bg-white hover:bg-gray-100 text-gray-700"
      title={`Copy ${label.toLowerCase()}`}
    >
      {copied ? (
        <Check className="w-3 h-3 mr-1 text-green-600" />
      ) : (
        <Copy className="w-3 h-3 mr-1" />
      )}
      {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
    </button>
  );
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
  // Why the last autosave failed; its own banner, so other actions clearing
  // the general error can't hide it while Retry save is still showing.
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveFailed = saveError !== null;
  const [generating, setGenerating] = useState(false);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Both config panels start collapsed: they're set-once knobs, and the point
  // of the page is the listing, not the configuration.
  const [showTemplates, setShowTemplates] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [showExtraSearch, setShowExtraSearch] = useState(false);
  const [extraSearch, setExtraSearch] = useState("");

  // Photos of the finished piece (GRA-38) and the design's listing status
  // are design metadata, written straight to the row rather than through the
  // pricing draft's Save — an uploaded file must be recorded right away or
  // it's orphaned in storage.
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [etsyUrlInput, setEtsyUrlInput] = useState("");
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Etsy connection (GRA-37), loaded once for the page: the bar at the top
  // shows it and the listing card's publish panel needs its shop options.
  const [etsyShop, setEtsyShop] = useState<EtsyShopInfo | null>(null);
  const [etsyError, setEtsyError] = useState("");
  const loadEtsyShop = () => {
    setEtsyError("");
    fetchEtsyShop()
      .then(setEtsyShop)
      .catch((e) => setEtsyError(e instanceof Error ? e.message : "Couldn't reach Etsy"));
  };
  useEffect(loadEtsyShop, []);

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
    setSaveError(null);
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
  // The ?? covers rows read before migration 0013 adds the columns.
  const photoPaths = useMemo(() => design?.photo_paths ?? [], [design]);
  const status: DesignStatus = design?.status ?? "design";

  useEffect(() => {
    setEtsyUrlInput(design?.etsy_listing_url ?? "");
  }, [design?.id, design?.etsy_listing_url]);

  // Signed display URLs for photos we don't have one for yet.
  useEffect(() => {
    const missing = photoPaths.filter((p) => !photoUrls[p]);
    if (missing.length === 0) return;
    let cancelled = false;
    designPhotoUrls(missing)
      .then((urls) => {
        if (!cancelled) setPhotoUrls((prev) => ({ ...prev, ...urls }));
      })
      .catch(() => {
        // Thumbnails just don't render; the paths still go to the generator.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoPaths]);

  /** Write design metadata (photos, status, Etsy link) and refresh the row
   * in place. The pricing working copy lives in separate state, so replacing
   * the row doesn't disturb unsaved pricing or listing edits. */
  const patchDesign = async (
    id: string,
    fields: Partial<Pick<Design, "photo_paths" | "status" | "etsy_listing_url">>
  ) => {
    const saved = await updateDesign(id, fields);
    setDesigns((ds) => ds.map((d) => (d.id === saved.id ? saved : d)));
    return saved;
  };

  const addPhotos = async (files: FileList | null) => {
    if (!design || !files || files.length === 0) return;
    const room = MAX_DESIGN_PHOTOS - photoPaths.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (picked.length === 0) return;
    setUploadingPhotos(true);
    setError("");
    const uploaded: string[] = [];
    try {
      for (const file of picked) uploaded.push(await uploadDesignPhoto(design.id, file));
      await patchDesign(design.id, { photo_paths: [...photoPaths, ...uploaded] });
      if (files.length > picked.length) {
        setError(`A design holds up to ${MAX_DESIGN_PHOTOS} photos; the rest were skipped.`);
      }
    } catch (e) {
      // Nothing points at files that didn't make it into the row.
      deleteDesignPhotos(uploaded).catch(() => {});
      setError(e instanceof Error ? e.message : "Photo upload failed");
    } finally {
      setUploadingPhotos(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const removePhoto = async (path: string) => {
    if (!design || !confirm("Delete this photo?")) return;
    setError("");
    try {
      await patchDesign(design.id, { photo_paths: photoPaths.filter((p) => p !== path) });
      // The row no longer references it; a failed file delete only wastes space.
      deleteDesignPhotos([path]).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove photo");
    }
  };

  const makePrimaryPhoto = async (path: string) => {
    if (!design) return;
    setError("");
    try {
      await patchDesign(design.id, {
        photo_paths: [path, ...photoPaths.filter((p) => p !== path)],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reorder photos");
    }
  };

  const changeStatus = async (next: DesignStatus) => {
    if (!design) return;
    setError("");
    try {
      await patchDesign(design.id, { status: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update status");
    }
  };

  const saveEtsyUrl = async () => {
    if (!design) return;
    const url = etsyUrlInput.trim();
    if (url === (design.etsy_listing_url ?? "")) return;
    if (url && !/^https:\/\/([\w-]+\.)*etsy\.com\//i.test(url)) {
      setError("That doesn't look like an Etsy link — paste the listing's https://www.etsy.com/… URL.");
      return;
    }
    setError("");
    try {
      // Linking a listing implies the piece is listed, unless it's already sold.
      await patchDesign(design.id, {
        etsy_listing_url: url || null,
        ...(url && (status === "design" || status === "finished")
          ? { status: "listed" as const }
          : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the Etsy link");
    }
  };

  const switchDesign = async (id: string) => {
    // Save the current design's pending edits first; only a failed save
    // leaves anything to discard.
    if (
      dirty &&
      !(await saveToDesign()) &&
      !confirm(
        `Couldn't save pricing/listing changes for "${design?.name ?? "this design"}". Discard them?`
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
    const calculatedPrice = totalCost * ((parseFloat(settings.markup_pct) || 0) / 100);
    // Round to the nearest step, but never down to $0 for a piece that costs
    // something. Everything downstream (listing price, profit, the
    // out-of-date check) uses the rounded figure.
    const step = parseFloat(settings.price_rounding) || 0;
    const sellingPrice =
      step > 0 && calculatedPrice > 0
        ? Math.max(step, Math.round(calculatedPrice / step) * step)
        : calculatedPrice;
    return {
      materialsCost,
      laborCost,
      overhead,
      totalCost,
      calculatedPrice,
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
          photo_paths: photoPaths.length ? photoPaths : undefined,
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

  // --- autosave: the working copy is written to the design shortly after
  // each edit, so a generated (paid-for) listing can't be lost by leaving
  // the page. Refs give the async save and the unmount flush the latest
  // values without re-subscribing. ---
  const working = { selectedId, laborHours, extras, listing };
  const workingRef = useRef(working);
  workingRef.current = working;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // The running save (with any queued follow-ups), so callers can wait for
  // the real outcome and at most one write is ever in flight.
  const inflightRef = useRef<Promise<boolean> | null>(null);
  const saveQueuedRef = useRef(false);

  const writeWorking = (w: typeof working) =>
    updateDesign(w.selectedId!, {
      pricing: { labor_hours: parseFloat(w.laborHours) || 0, extras: w.extras },
      listing: w.listing,
    });

  /** One write of the current working copy; resolves whether it succeeded. */
  const saveOnce = async (): Promise<boolean> => {
    const snap = workingRef.current;
    if (!snap.selectedId) return true;
    try {
      const saved = await writeWorking(snap);
      setDesigns((ds) => ds.map((d) => (d.id === saved.id ? saved : d)));
      const now = workingRef.current;
      // Edits made while the write was in flight stay dirty for the next save.
      if (
        now.selectedId === snap.selectedId &&
        now.laborHours === snap.laborHours &&
        now.extras === snap.extras &&
        now.listing === snap.listing
      ) {
        setDirty(false);
      }
      setSaveError(null);
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "unknown error");
      return false;
    }
  };

  /** Save now. A call made while a save is running queues one follow-up and
   * resolves with that follow-up's result, so it only reports success once
   * the latest edits are actually written. */
  const saveToDesign = (): Promise<boolean> => {
    if (inflightRef.current) {
      saveQueuedRef.current = true;
      return inflightRef.current;
    }
    setSaving(true);
    const run = (async () => {
      let ok = await saveOnce();
      while (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        ok = await saveOnce();
      }
      return ok;
    })().finally(() => {
      inflightRef.current = null;
      setSaving(false);
    });
    inflightRef.current = run;
    return run;
  };

  useEffect(() => {
    // A failed save waits for Retry (or the next edit) instead of looping.
    if (!dirty || !selectedId || saveFailed) return;
    const t = setTimeout(() => {
      saveToDesign();
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, selectedId, laborHours, extras, listing, saveFailed]);

  // An edit after a failure clears the failed state so autosave resumes.
  useEffect(() => {
    setSaveError(null);
  }, [laborHours, extras, listing]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(
    () => () => {
      // Leaving the page (in-app navigation) inside the autosave window:
      // flush without waiting, but behind any save already in flight so an
      // older write can't land last. The localStorage draft is the backstop.
      if (dirtyRef.current && workingRef.current.selectedId) {
        const snap = workingRef.current;
        (inflightRef.current ?? Promise.resolve(true))
          .then(() => writeWorking(snap))
          .catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const listingText = listing
    ? `TITLE:\n${listing.title}\n\nDESCRIPTION:\n${listing.description}\n\nTAGS:\n${listing.tags.join(", ")}\n\n${listing.materials?.length ? `MATERIALS:\n${listing.materials.join(", ")}\n\n` : ""}PRICE: $${listing.price.toFixed(2)}`
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

  const etsyBar = (
    <EtsyConnectionBar
      shop={etsyShop}
      loadError={etsyError}
      onRetry={loadEtsyShop}
      onChange={setEtsyShop}
    />
  );

  if (designsLoaded && designs.length === 0) {
    return (
      <div className="space-y-4">
        {/* Connecting doesn't depend on having a design. */}
        {etsyBar}
        <div className="text-center py-12 text-gray-500">
          <p className="mb-2">No saved designs yet.</p>
          <p className="text-sm">
            Build and save a strand on the Design Board first — pricing works from
            the actual beads in a design.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {etsyBar}

      {/* Design picker */}
      <div className="bg-gray-50 p-4 rounded-lg flex flex-wrap items-center gap-3">
        <select
          value={selectedId ?? ""}
          onChange={(e) => switchDesign(e.target.value)}
          // Switching saves first; don't race a save that's already running.
          disabled={saving}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.status && d.status !== "design" ? ` · ${DESIGN_STATUS_LABELS[d.status]}` : ""}
            </option>
          ))}
        </select>
        {design && (
          <span className="text-sm text-gray-600">
            {design.beads?.length ?? 0} beads · {strandIn.toFixed(2)}&quot;
          </span>
        )}
        {design && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Status
            <select
              value={status}
              onChange={(e) => changeStatus(e.target.value as DesignStatus)}
              className="px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
            >
              {DESIGN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DESIGN_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}
        {/* From Finished on, so pasting the link can itself mark the piece Listed. */}
        {design && (status !== "design" || design.etsy_listing_url) && (
          <div className="flex items-center gap-1 min-w-0 w-full sm:w-auto sm:flex-1 sm:max-w-md">
            <input
              type="url"
              value={etsyUrlInput}
              onChange={(e) => setEtsyUrlInput(e.target.value)}
              onBlur={saveEtsyUrl}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="Etsy listing URL"
              aria-label="Etsy listing URL"
              className="flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
            />
            {design.etsy_listing_url && (
              <a
                href={etsyLinkHref(design.etsy_listing_url, status)}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-purple-700 hover:text-purple-900"
                title={
                  status === "listed" || status === "sold"
                    ? "Open on Etsy"
                    : "Open in Etsy's listing editor (the public page appears once the listing is live)"
                }
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        )}
        {/* Autosave status; doubles as Save now / Retry. */}
        <button
          onClick={() => {
            setSaveError(null);
            saveToDesign();
          }}
          disabled={saving || !dirty}
          className={`ml-auto flex items-center px-3 py-2 rounded-lg text-sm disabled:cursor-default ${
            saveFailed
              ? "bg-red-600 text-white hover:bg-red-700"
              : dirty && !saving
                ? "bg-purple-600 text-white hover:bg-purple-700"
                : "bg-white border border-gray-300 text-gray-600"
          }`}
          title={dirty && !saving && !saveFailed ? "Changes save automatically — click to save now" : undefined}
        >
          {saving || dirty ? (
            <Save className="w-4 h-4 mr-1" />
          ) : (
            <Check className="w-4 h-4 mr-1 text-green-600" />
          )}
          {saving
            ? "Saving…"
            : saveFailed
              ? "Retry save"
              : dirty
                ? "Unsaved changes"
                : "All changes saved"}
        </button>
      </div>

      {saveError !== null && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">
            Couldn&apos;t save your changes ({saveError}). They&apos;re kept on this
            device — use Retry save.
          </p>
        </div>
      )}

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

          {design && (
            <div className="mb-4 p-3 bg-white border border-gray-200 rounded-lg">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <h3 className="text-sm font-medium text-gray-700 flex-1">
                  Photos of the finished piece
                </h3>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => addPhotos(e.target.files)}
                />
                <button
                  onClick={() => photoInputRef.current?.click()}
                  disabled={uploadingPhotos || photoPaths.length >= MAX_DESIGN_PHOTOS}
                  className="flex items-center px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Camera className="w-4 h-4 mr-1" />
                  {uploadingPhotos ? "Uploading…" : "Add photos"}
                </button>
              </div>
              {photoPaths.length === 0 ? (
                <p className="text-xs text-gray-500">
                  Add photos and the listing is written from how the piece
                  actually looks, not from stored bead specs. Up to{" "}
                  {MAX_DESIGN_PHOTOS}.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {photoPaths.map((path, i) => (
                      <div
                        key={path}
                        className={`relative w-20 h-20 rounded-md overflow-hidden border bg-gray-100 ${
                          i === 0 ? "border-purple-400 ring-1 ring-purple-300" : "border-gray-200"
                        }`}
                      >
                        {photoUrls[path] ? (
                          // Signed Storage URLs; next/image would need the
                          // Supabase host configured for no real gain here.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={photoUrls[path]}
                            alt={`Photo ${i + 1} of the piece`}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="flex items-center justify-center w-full h-full text-xs text-gray-400">
                            …
                          </span>
                        )}
                        {i === 0 ? (
                          <span className="absolute bottom-0 inset-x-0 text-[10px] text-center bg-purple-600/80 text-white">
                            Primary
                          </span>
                        ) : (
                          <button
                            onClick={() => makePrimaryPhoto(path)}
                            className="absolute bottom-0 inset-x-0 text-[10px] text-center bg-black/50 text-white hover:bg-black/70"
                          >
                            Make primary
                          </button>
                        )}
                        <button
                          onClick={() => removePhoto(path)}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-white/90 text-gray-700 hover:text-red-600"
                          title="Delete photo"
                          aria-label={`Delete photo ${i + 1}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {listing
                      ? "Regenerate to write the listing from these photos."
                      : "Generate uses these photos to describe the piece."}
                  </p>
                </>
              )}
            </div>
          )}

          {listing ? (
            <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Title (140 characters max)
                  </label>
                  <CopyButton text={listing.title} label="Title" />
                </div>
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
                <div className="flex items-center justify-between gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Description
                  </label>
                  <CopyButton text={listing.description} label="Description" />
                </div>
                <textarea
                  value={listing.description}
                  onChange={(e) => updateListing({ description: e.target.value })}
                  rows={12}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Tags
                  </label>
                  {/* Comma-separated: Etsy's tag field splits a pasted list. */}
                  <CopyButton text={listing.tags.join(", ")} label="Tags" />
                </div>
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
              {listing.materials?.length ? (
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Materials
                    </label>
                    <CopyButton text={listing.materials.join(", ")} label="Materials" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {listing.materials.map((m, index) => (
                      <span
                        key={index}
                        className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm"
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h4 className="font-medium">Listing Price</h4>
                  <CopyButton text={listing.price.toFixed(2)} label="Price" />
                </div>
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
                  Copy all
                </button>
                <button
                  onClick={downloadListing}
                  className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </button>
              </div>
              {/* After settings load, so the form seeds from remembered
                  choices and a publish can't overwrite them with defaults. */}
              {etsyShop && !etsyShop.connected && (
                <p className="text-sm text-gray-500">
                  Connect your Etsy shop at the top of the page to publish this
                  listing as a draft.
                </p>
              )}
              {design && settingsLoaded && etsyShop?.connected && (
                <EtsyPublish
                  shop={etsyShop}
                  design={design}
                  listing={listing}
                  photoPaths={photoPaths}
                  settings={settings}
                  updateSettings={updateSettings}
                  onPublished={(res) => {
                    // Link the design to its new draft; status stays as-is
                    // until the piece is actually live on Etsy.
                    patchDesign(design.id, { etsy_listing_url: res.listing_url }).catch((e) =>
                      setError(
                        `The draft was created, but linking it to this design failed: ${
                          e instanceof Error ? e.message : "unknown error"
                        }`
                      )
                    );
                  }}
                />
              )}
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
                      <label className="text-sm text-gray-700">Round price to</label>
                      <select
                        value={settings.price_rounding}
                        onChange={(e) => updateSettings({ price_rounding: e.target.value })}
                        className="w-32 px-2 py-1 border border-gray-300 rounded-md text-sm bg-white"
                      >
                        {ROUNDING_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
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
              {Math.abs(costs.sellingPrice - costs.calculatedPrice) > 0.005 && (
                <p className="text-xs text-gray-500 text-right -mt-2">
                  Rounded from ${costs.calculatedPrice.toFixed(2)}
                </p>
              )}
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
                          {isGeneric(m) ? <GenericBadge /> : `${m.quantity} in stock`}
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
