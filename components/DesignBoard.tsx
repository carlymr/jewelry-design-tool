"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Save,
  Trash2,
  RefreshCw,
  Repeat,
  ArrowRightToLine,
  Eraser,
  ZoomIn,
  ZoomOut,
  Pin,
  Info,
  Replace,
  X,
  Undo2,
  Redo2,
  FlipHorizontal2,
  CircleHelp,
  Gem,
} from "lucide-react";
import BeadSwatch, { Bead, settingBoxPx } from "@/components/BeadSwatch";
import BeadFilters from "@/components/BeadFilters";
import SearchField from "@/components/SearchField";
import MaterialDetailModal from "@/components/MaterialDetail";
import { useSession } from "@/components/AuthGate";
import { apiHeaders } from "@/lib/auth";
import { updateMaterial } from "@/lib/materials";
import {
  createDesign,
  deleteDesign,
  listDesigns,
  updateDesign,
} from "@/lib/designs";
import {
  pendantAttachment,
  colorFamilyOf,
  sizeBucketOf,
  DRILL_LABELS,
  type BeadVisual,
} from "@/lib/bead-visual";
import { curveGeometry, curvePath } from "@/lib/strand-layout";
import { fits, fittingBezels } from "@/lib/bezel-fit";
import { useHistory } from "@/lib/useHistory";
import {
  isPalindrome,
  makeSymmetric,
  mirroredDelete,
  mirroredInsert,
  reflectGap,
  sameStrand,
  type FoldCenter,
  type Side,
} from "@/lib/mirror";
import { presentCategories, type Design, type DesignBead, type Material } from "@/lib/types";

const MM_PER_INCH = 25.4;
// CSS reference pixel: 96px per inch, so this renders beads at ~life size.
const ACTUAL_PX_PER_MM = 96 / MM_PER_INCH;
// Beads without a generated visual still need to advance the strand somehow.
const FALLBACK_BEAD_MM = 6;
const MAX_BEADS = 500;
// Standard jewelry lengths; anything else via the Custom… option.
const LENGTH_PRESETS: { in: number; label?: string }[] = [
  { in: 6 },
  { in: 6.5 },
  { in: 7, label: "bracelet" },
  { in: 7.5 },
  { in: 8 },
  { in: 9 },
  { in: 10, label: "anklet" },
  { in: 12, label: "collar" },
  { in: 14, label: "collar" },
  { in: 16, label: "choker" },
  { in: 18, label: "princess" },
  { in: 20, label: "matinee" },
  { in: 24, label: "matinee" },
  { in: 30, label: "opera" },
  { in: 36, label: "rope" },
];
const VISUALS_BATCH = 60;
// Categories whose items can sit on a strand and belong in the palette.
// Wire/cord/tools stay inventory-only. Anything else with a generated visual
// (e.g. a chain filed under Stringing) is also placeable.
const PLACEABLE_CATEGORIES = new Set(["Beads", "Cabochons", "Findings"]);
// Working-copy draft persisted to localStorage so navigation, reloads, and
// tab closes can't lose unsaved strand work.
const DRAFT_KEY = "design-board-draft";
// Materials the user has pinned to the palette's working set (GRA-39).
// Persisted separately from the draft and scoped per design, so each piece
// keeps its own working set: a saved design's pins live under
// `{PINS_KEY}:{user}:{design id}`; the not-yet-saved design's under the bare
// `{PINS_KEY}:{user}` slot, and they move to the design's slot on first save.
const PINS_KEY = "design-board-pins";
// How many strand edits undo can walk back.
const HISTORY_LIMIT = 50;
// One undo step: the strand plus the cursor, captured together so the
// selection always matches the beads it points at.
type StrandSnapshot = {
  beads: DesignBead[];
  selection: { anchor: number; focus: number } | null;
  insertion: number;
};

/** Pinned ids stored under one slot; a missing or corrupt entry reads as none. */
function readPins(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface Props {
  materials: Material[];
  onMaterialsChanged: () => Promise<void>;
}

// A cabochon is worn as a pendant: it hangs below the string from a bail and
// advances the strand by only the bail's width, not the stone's size. The
// exception is a center-drilled stone, which strings inline like a bead.
const CABOCHON_ADVANCE_MM = 6;
const CABOCHON_BAIL_MM = 4;

// Cabochons (unless center-drilled) and bezel settings hang below the string.
const isPendant = (v: BeadVisual | null | undefined) => {
  const a = pendantAttachment(v);
  return a !== null && a !== "inline";
};
// Wire-hung pendants have no ring; the rest hang from a bail (real, or a
// placeholder standing in for the setting an undrilled stone still needs).
const hasBail = (v: BeadVisual) => pendantAttachment(v) !== "wire";

const beadLengthMm = (m: Material | undefined) =>
  isPendant(m?.visual)
    ? CABOCHON_ADVANCE_MM
    : m?.visual?.length_mm ?? FALLBACK_BEAD_MM;
const beadWidthMm = (m: Material | undefined) =>
  isPendant(m?.visual)
    ? CABOCHON_ADVANCE_MM
    : m?.visual?.width_mm ?? FALLBACK_BEAD_MM;

export default function DesignBoard({ materials, onMaterialsChanged }: Props) {
  // Drafts are namespaced per account so nothing leaks between sign-ins on
  // a shared browser.
  const session = useSession();
  const draftKey = `${DRAFT_KEY}:${session?.user.id ?? "local"}`;

  // --- design state (working copy) ---
  const [designs, setDesigns] = useState<Design[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  // Pins are scoped per design on top of that (see PINS_KEY).
  const pinsKeyFor = (designId: string | null) =>
    `${PINS_KEY}:${session?.user.id ?? "local"}${designId ? `:${designId}` : ""}`;
  const pinsKey = pinsKeyFor(currentId);
  const [name, setName] = useState("Untitled design");
  const [targetMm, setTargetMm] = useState(7 * MM_PER_INCH);
  const [beads, setBeads] = useState<DesignBead[]>([]);
  const [dirty, setDirty] = useState(false);

  // --- UI state ---
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(
    null
  );
  const [insertion, setInsertion] = useState(0);
  // Undo/redo snapshots carry the cursor along with the strand, so undoing
  // puts the selection back where it was. Only user edits (`mutateBeads`)
  // record; loading or starting a design resets the stacks instead.
  const history = useHistory<StrandSnapshot>(HISTORY_LIMIT);
  const [repeatCount, setRepeatCount] = useState(3);
  const [zoomMode, setZoomMode] = useState<"fit" | "custom">("fit");
  // "line" is the straight editing strand; "curve" shows the piece as worn
  // (circle for bracelet lengths, hanging drape for necklaces).
  const [layout, setLayout] = useState<"line" | "curve">("line");
  // The `?` shortcut popover beside the hint line (GRA-45). Closes on
  // Escape or a click outside; it listens on the document and never stops
  // the event, so the board's own key handling is untouched.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowShortcuts(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!shortcutsRef.current?.contains(e.target as Node)) setShowShortcuts(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [showShortcuts]);
  // Non-null while the free-form target-length input is open (raw text so
  // the field can be cleared mid-typing).
  const [customTarget, setCustomTarget] = useState<string | null>(null);
  const [customPx, setCustomPx] = useState(6);
  const [containerW, setContainerW] = useState(1100);
  const boardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // Drag-to-rearrange: the bead range in flight (mutated, not state — only
  // dropIndex needs to re-render) and a flag to swallow the click that fires
  // after a drag's pointerup.
  const dragRef = useRef<{
    start: number;
    end: number;
    startX: number;
    moved: boolean;
  } | null>(null);
  const didDragRef = useRef(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [familyFilter, setFamilyFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  // Manually pinned material ids, in the order they were pinned, tagged with
  // the slot they were read from so the persist effect below can never write
  // one design's (or account's) pins into another's slot — the key changes
  // whenever the design does, including during the draft restore on mount.
  const [pins, setPins] = useState<{ key: string | null; ids: string[] }>({
    key: null,
    ids: [],
  });
  const pinned = pins.ids;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  // Which material's detail modal is open (id, so a post-save refresh flows
  // straight into the open modal instead of leaving it on a stale object).
  const [detailId, setDetailId] = useState<string | null>(null);
  // Replace mode (GRA-41): the material whose every placement is about to be
  // swapped for whatever palette card gets clicked next.
  const [replacingId, setReplacingId] = useState<string | null>(null);
  // Set into… (GRA-29): the fitting-bezel list under the selection toolbar.
  const [settingPickerOpen, setSettingPickerOpen] = useState(false);
  const settingPickerRef = useRef<HTMLDivElement>(null);
  // Mirror mode (GRA-42): edits are reflected around the strand's center so
  // it stays a palindrome. Session-only — it rides along in the draft but
  // never reaches the design row.
  const [mirror, setMirror] = useState(false);
  // Ids we've already requested a visual for, so partial API results don't
  // retry forever and later-added materials still get picked up.
  const attemptedVisuals = useRef(new Set<string>());

  const materialById = useMemo(
    () => new Map(materials.map((m) => [m.id, m])),
    [materials]
  );
  const detailMaterial = detailId ? materialById.get(detailId) ?? null : null;

  // The bezel a placed cabochon sits in (GRA-29). Only while the stone is
  // still a cabochon and the setting still exists as a bezel — otherwise the
  // element degrades to a bare stone rather than breaking.
  const settingOf = useCallback(
    (b: DesignBead): Material | undefined => {
      if (!b.setting_id) return undefined;
      if (materialById.get(b.material_id)?.visual?.shape !== "cabochon") return undefined;
      const setting = materialById.get(b.setting_id);
      return setting?.visual?.shape === "bezel" ? setting : undefined;
    },
    [materialById]
  );

  // Track the board's width so fit-to-screen can compute a scale.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setContainerW(el.clientWidth));
    observer.observe(el);
    setContainerW(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // The worn view fits vertically too, budgeted against the viewport (the
  // container's own height follows its content, so it can't be the budget).
  const [viewportH, setViewportH] = useState(800);
  useEffect(() => {
    const update = () => setViewportH(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // --- restore any unsaved draft (must be declared before the persist
  // effect below: both run on mount, and the restore must read the draft
  // before the clean-state persist effect clears it) ---
  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current) return;
    draftRestored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!Array.isArray(draft.beads)) return;
      setCurrentId(typeof draft.currentId === "string" ? draft.currentId : null);
      setName(typeof draft.name === "string" ? draft.name : "Untitled design");
      setTargetMm(typeof draft.targetMm === "number" ? draft.targetMm : 7 * MM_PER_INCH);
      setBeads(draft.beads);
      setInsertion(draft.beads.length);
      setMirror(draft.mirror === true);
      setDirty(true);
    } catch {
      // A corrupt draft shouldn't break the board.
    }
  }, []);

  // --- persist the working copy while dirty; clear it once saved/discarded ---
  useEffect(() => {
    try {
      if (!dirty) {
        localStorage.removeItem(draftKey);
      } else {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ currentId, name, targetMm, beads, mirror })
        );
      }
    } catch {
      // Quota/private-mode failures just lose the safety net, nothing else.
    }
  }, [dirty, currentId, name, targetMm, beads, mirror, draftKey]);

  // --- pinned materials: restore per account + design, then persist every
  // change back to the slot they came from ---
  useEffect(() => {
    setPins({ key: pinsKey, ids: readPins(pinsKey) });
  }, [pinsKey]);

  useEffect(() => {
    if (pins.key !== pinsKey) return;
    try {
      localStorage.setItem(pinsKey, JSON.stringify(pins.ids));
    } catch {
      // Quota/private-mode failures just lose the pins, nothing else.
    }
  }, [pins, pinsKey]);

  const updatePinned = (update: (prev: string[]) => string[]) =>
    setPins((prev) => ({ ...prev, ids: update(prev.ids) }));
  const togglePin = (id: string) =>
    updatePinned((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // --- load designs ---
  useEffect(() => {
    listDesigns()
      .then(setDesigns)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load designs"));
  }, []);

  // --- lazy visual generation for placeable items that never came through a
  // receipt ---
  useEffect(() => {
    const missing = materials.filter(
      (m) =>
        PLACEABLE_CATEGORIES.has(m.category) &&
        !m.visual &&
        !attemptedVisuals.current.has(m.id)
    );
    if (missing.length === 0) return;
    missing.forEach((m) => attemptedVisuals.current.add(m.id));

    (async () => {
      setGenerating(true);
      try {
        for (let i = 0; i < missing.length; i += VISUALS_BATCH) {
          const batch = missing.slice(i, i + VISUALS_BATCH);
          const res = await fetch("/api/generate-visuals", {
            method: "POST",
            headers: await apiHeaders(),
            body: JSON.stringify({
              materials: batch.map((m) => ({ id: m.id, name: m.name })),
            }),
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
          const visuals = result.visuals as { id: string; visual: BeadVisual }[];
          await Promise.all(visuals.map(({ id, visual }) => updateMaterial(id, { visual })));
        }
        await onMaterialsChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate bead artwork");
      } finally {
        setGenerating(false);
      }
    })();
  }, [materials, onMaterialsChanged]);

  // --- palette ---
  // Everything that can be placed on a strand, before the user's filters.
  const placeable = useMemo(
    () => materials.filter((m) => PLACEABLE_CATEGORIES.has(m.category) || m.visual),
    [materials]
  );
  // Only offer types the palette actually holds — including the odd item
  // filed outside PLACEABLE_CATEGORIES that earned a visual anyway.
  const categoryOptions = useMemo(() => presentCategories(placeable), [placeable]);

  // How many of each material the strand holds, keyed in the order the
  // materials first appear on it (so its keys double as the on-strand list).
  // A cabochon's setting counts like a placed element: the bezel draws down
  // stock and joins the working set.
  const strandCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const add = (id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const b of beads) {
      add(b.material_id);
      if (b.setting_id) add(b.setting_id);
    }
    return counts;
  }, [beads]);

  // Replace mode only means something while its material is still on the
  // strand. Once the last one is removed the id is cleared outright, so the
  // mode can't quietly come back when that material is re-added or undone
  // onto the strand — only an explicit click re-enters it.
  useEffect(() => {
    if (replacingId && !strandCounts.has(replacingId)) setReplacingId(null);
  }, [replacingId, strandCounts]);
  const replacing =
    replacingId && strandCounts.has(replacingId)
      ? materialById.get(replacingId) ?? null
      : null;
  const replacingCount = replacing ? strandCounts.get(replacing.id) ?? 0 : 0;

  // The working set: what you're building with right now. Materials already on
  // the strand stay reachable automatically, and pinning keeps one around after
  // it leaves the strand. Both ignore the search and filters, so switching
  // between a few beads no longer means re-searching for each one.
  const workingSet = useMemo(() => {
    const ids = [...strandCounts.keys(), ...pinned.filter((id) => !strandCounts.has(id))];
    return ids
      .map((id) => materialById.get(id))
      .filter((m): m is Material => m !== undefined);
  }, [strandCounts, pinned, materialById]);

  const workingSetIds = useMemo(
    () => new Set(workingSet.map((m) => m.id)),
    [workingSet]
  );

  const palette = useMemo(() => {
    const term = paletteSearch.toLowerCase();
    return placeable
      // The working set is rendered above; don't card it twice.
      .filter((m) => !workingSetIds.has(m.id))
      .filter((m) => !categoryFilter || m.category === categoryFilter)
      .filter((m) => m.name.toLowerCase().includes(term))
      .filter((m) => !familyFilter || colorFamilyOf(m.visual) === familyFilter)
      .filter((m) => !sizeFilter || sizeBucketOf(m.visual) === sizeFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [placeable, workingSetIds, paletteSearch, categoryFilter, familyFilter, sizeFilter]);

  // --- derived strand geometry ---
  const strand = useMemo(() => {
    let x = 0;
    const placed = beads.map((b, index) => {
      const material = materialById.get(b.material_id);
      const setting = settingOf(b);
      // A set stone hangs from its bezel's loop, whatever its drill type.
      const lengthMm = setting ? CABOCHON_ADVANCE_MM : beadLengthMm(material);
      const bead = { index, material, setting, xMm: x, lengthMm };
      x += lengthMm;
      return bead;
    });
    return { placed, totalMm: x };
  }, [beads, materialById, settingOf]);

  const totalCost = useMemo(
    () =>
      strand.placed.reduce(
        (sum, p) => sum + (p.material?.unit_cost ?? 0) + (p.setting?.unit_cost ?? 0),
        0
      ),
    [strand]
  );

  const stockIssues = useMemo(() => {
    const issues: { name: string; need: number; have: number }[] = [];
    for (const [id, need] of strandCounts) {
      const m = materialById.get(id);
      if (m && need > m.quantity) {
        issues.push({ name: m.name, need, have: m.quantity });
      }
    }
    return issues;
  }, [strandCounts, materialById]);

  const range = selection
    ? {
        start: Math.min(selection.anchor, selection.focus),
        end: Math.max(selection.anchor, selection.focus),
      }
    : null;

  // --- editing actions ---
  const mutateBeads = (next: DesignBead[]) => {
    history.record({ beads, selection, insertion });
    setBeads(next.slice(0, MAX_BEADS));
    setDirty(true);
  };

  // Stepping through history is an edit like any other: it dirties the
  // design and flows into the draft.
  const restoreSnapshot = (snap: StrandSnapshot | null) => {
    if (!snap) return;
    setBeads(snap.beads);
    setSelection(snap.selection);
    setInsertion(snap.insertion);
    setDirty(true);
  };
  const undo = () => restoreSnapshot(history.undo({ beads, selection, insertion }));
  const redo = () => restoreSnapshot(history.redo({ beads, selection, insertion }));

  // Insert a run at a gap — reflected onto the other side too in mirror
  // mode — and say where the caret lands. Shared by add, repeat and fill so
  // each stays one undo step.
  const plainInsert = (gap: number, items: DesignBead[]) => {
    const at = Math.min(Math.max(gap, 0), beads.length);
    const next = [...beads];
    next.splice(at, 0, ...items);
    return { beads: next, insertion: at + items.length };
  };
  const insertRun = (gap: number, items: DesignBead[]) =>
    mirror ? mirroredInsert(beads, gap, items) : plainInsert(gap, items);

  // A mirrored insert can land its reflected copy before the selection,
  // shifting the beads it points at: follow them, or drop the selection if
  // the copy split it. (A plain insert after the selection never moves it.)
  const followSelection = (gap: number, inserted: number) => {
    if (!mirror || !selection || !range) return;
    const n = beads.length;
    const r = reflectGap(Math.min(gap, n), n);
    if (r <= range.start) {
      setSelection({ anchor: selection.anchor + inserted, focus: selection.focus + inserted });
    } else if (r <= range.end) {
      setSelection(null);
    }
  };

  // Remove an inclusive range — and its reflection in mirror mode — as one
  // edit, saying where the caret lands. Shared by the selection delete and
  // Backspace.
  const deleteRange = (start: number, end: number) =>
    mirror
      ? mirroredDelete(beads, start, end)
      : { beads: beads.filter((_, i) => i < start || i > end), insertion: start };

  const addBead = (materialId: string) => {
    // The first bead on an empty strand becomes the axis itself — mirroring
    // it would put down two pendants.
    const both = mirror && beads.length > 0;
    if (beads.length + (both ? 2 : 1) > MAX_BEADS) return;
    const bead = { material_id: materialId };
    const placed = both
      ? mirroredInsert(beads, insertion, [bead])
      : plainInsert(insertion, [bead]);
    mutateBeads(placed.beads);
    setInsertion(placed.insertion);
    setSelection(null);
    // Hand focus to the board so Backspace immediately undoes a mis-click —
    // otherwise the palette button (or, in Safari, the page body) keeps focus
    // and the board's key handler never hears about it. preventScroll keeps
    // the palette from jumping out from under the pointer.
    boardRef.current?.focus({ preventScroll: true });
  };

  // Swap every placement of one material for another, in place: order,
  // count and the selection (which is by index) all stay put. Picking the
  // material already being replaced is a no-op that just leaves the mode.
  const replaceMaterial = (fromId: string, toId: string) => {
    setReplacingId(null);
    if (fromId === toId) return;
    const to = materialById.get(toId)?.visual ?? null;
    mutateBeads(
      beads.map((b) => {
        if (b.material_id === fromId) {
          // The setting survives only if the new stone still fits it.
          const bezel = b.setting_id ? materialById.get(b.setting_id)?.visual : null;
          return bezel && to && fits(to, bezel)
            ? { material_id: toId, setting_id: b.setting_id }
            : { material_id: toId };
        }
        if (b.setting_id === fromId) {
          // Swapping a bezel that's in use as a setting: keep the stone set
          // if the new bezel fits it, else it's back to needing a setting.
          const stone = materialById.get(b.material_id)?.visual ?? null;
          return stone && to && fits(stone, to)
            ? { ...b, setting_id: toId }
            : { material_id: b.material_id };
        }
        return b;
      })
    );
    boardRef.current?.focus({ preventScroll: true });
  };

  // Set into… (GRA-29) applies to exactly one selected cabochon.
  const selectedBead = range && range.start === range.end ? beads[range.start] : null;
  const selectedCab =
    selectedBead && materialById.get(selectedBead.material_id)?.visual?.shape === "cabochon"
      ? materialById.get(selectedBead.material_id) ?? null
      : null;
  const fittingSettings = useMemo(
    () => (selectedCab ? fittingBezels(selectedCab, materials) : []),
    [selectedCab, materials]
  );
  // The list only means something for the selection it was opened on.
  useEffect(() => setSettingPickerOpen(false), [selection]);
  useEffect(() => {
    if (!settingPickerOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!settingPickerRef.current?.contains(e.target as Node)) setSettingPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [settingPickerOpen]);

  const setSetting = (settingId: string | null) => {
    if (!range || range.start !== range.end) return;
    setSettingPickerOpen(false);
    mutateBeads(
      beads.map((b, i) => {
        if (i !== range.start) return b;
        return settingId ? { ...b, setting_id: settingId } : { material_id: b.material_id };
      })
    );
    boardRef.current?.focus({ preventScroll: true });
  };

  // The selection toolbar can offer Replace only when the selected run is one
  // material — otherwise there's nothing unambiguous to swap out.
  const selectionMaterialIds = range
    ? new Set(beads.slice(range.start, range.end + 1).map((b) => b.material_id))
    : null;
  const selectionMaterialId =
    selectionMaterialIds?.size === 1 ? [...selectionMaterialIds][0] : null;
  const selectionMaterial = selectionMaterialId
    ? materialById.get(selectionMaterialId) ?? null
    : null;
  const selectionCount = range ? range.end - range.start + 1 : 0;

  const deleteSelection = useCallback(() => {
    if (!range) return;
    const removed = deleteRange(range.start, range.end);
    mutateBeads(removed.beads);
    setSelection(null);
    setInsertion(removed.insertion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beads, range, mirror]);

  const repeatSelection = (times: number) => {
    if (!range || times < 1) return;
    const pattern = beads.slice(range.start, range.end + 1);
    // Mirroring doubles the growth, and a truncated mirror isn't one, so
    // stop at however many whole repeats fit.
    if (mirror) {
      times = Math.min(times, Math.floor((MAX_BEADS - beads.length) / (2 * pattern.length)));
      if (times < 1) return;
    }
    const items = Array.from({ length: times }, () => pattern.map((b) => ({ ...b }))).flat();
    const placed = insertRun(range.end + 1, items);
    mutateBeads(placed.beads);
    followSelection(range.end + 1, items.length);
    setInsertion(Math.min(placed.insertion, MAX_BEADS));
  };

  const fillToTarget = () => {
    const pattern = range
      ? beads.slice(range.start, range.end + 1)
      : beads.slice();
    const patternMm = pattern.reduce(
      (sum, b) => sum + beadLengthMm(materialById.get(b.material_id)),
      0
    );
    if (pattern.length === 0 || patternMm <= 0) return;
    // Count whole repeats that fit; in mirror mode each one lands on both
    // ends, so it costs twice the length and twice the beads.
    const perPlacement = mirror ? 2 : 1;
    let times = 0;
    let total = strand.totalMm;
    let count = beads.length;
    while (
      total + patternMm * perPlacement <= targetMm + 0.001 &&
      count + pattern.length * perPlacement <= MAX_BEADS
    ) {
      times++;
      total += patternMm * perPlacement;
      count += pattern.length * perPlacement;
    }
    if (times === 0) return;
    const items = Array.from({ length: times }, () => pattern.map((b) => ({ ...b }))).flat();
    const placed = insertRun(beads.length, items);
    mutateBeads(placed.beads);
    followSelection(beads.length, items.length);
    setInsertion(placed.insertion);
  };

  // Whether the strand already reads the same from both ends (mirror mode's
  // invariant, which the asymmetry note watches).
  const symmetric = useMemo(() => isPalindrome(beads), [beads]);

  // Make symmetric folds the strand at the cursor, not at its middle — on
  // an asymmetric strand the pendant usually isn't central yet. A selected
  // run is the center and stays put (click the pendant to fold around it);
  // otherwise the insertion gap is the fold line. The user picks which side
  // survives: the buttons offer both, each disabled when it would change
  // nothing (or overflow the strand).
  const foldCenter: FoldCenter = range
    ? { start: range.start, end: range.end + 1 }
    : { start: Math.min(insertion, beads.length), end: Math.min(insertion, beads.length) };
  const folds = useMemo(() => {
    const fold = (keep: Side) => {
      const next = makeSymmetric(beads, foldCenter, keep);
      const ok = beads.length > 0 && next.length <= MAX_BEADS && !sameStrand(next, beads);
      return { next, ok };
    };
    return { left: fold("left"), right: fold("right") };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beads, foldCenter.start, foldCenter.end]);

  // One-shot; works with mirror mode off too — it's how an asymmetric
  // strand gets into shape before mirroring from there. Afterwards the
  // cursor sits just right of the center, so mirrored adds build outward.
  const symmetrize = (keep: Side) => {
    const fold = folds[keep];
    if (!fold.ok) return;
    const shift = keep === "left" ? 0 : beads.length - foldCenter.end - foldCenter.start;
    const start = foldCenter.start + shift;
    const end = foldCenter.end + shift;
    mutateBeads(fold.next);
    setSelection(range ? { anchor: start, focus: end - 1 } : null);
    setInsertion(end);
    boardRef.current?.focus({ preventScroll: true });
  };
  const foldTitle = (keep: Side) =>
    beads.length === 0
      ? "Place some beads first"
      : !folds[keep].ok
        ? `Already what keeping the ${keep} side would give`
        : range
          ? `Keep the selected ${range.end === range.start ? "bead" : "run"} as the center and mirror the ${keep} side onto the other`
          : `Fold at the caret: mirror the ${keep} side onto the other`;

  const clearAll = () => {
    if (beads.length > 0 && !confirm("Remove all beads from the strand?")) return;
    mutateBeads([]);
    setSelection(null);
    setInsertion(0);
  };

  const clampIndex = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);

  const handleBeadClick = (index: number, shiftKey: boolean) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    if (shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: index });
    } else {
      setSelection({ anchor: index, focus: index });
    }
    setInsertion(index + 1);
  };

  const handleBoardClick = (e: React.MouseEvent) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    setSelection(null);
    setInsertion(gapIndexFromClientX(e.clientX, e.clientY));
  };

  // --- drag to rearrange ---
  const handleBeadPointerDown = (index: number, e: React.PointerEvent) => {
    // Capture so the drag keeps tracking even when the pointer wobbles off
    // the strand-hugging svg (which would otherwise abort it).
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events without a live pointer can't be captured; the drag
      // still works as long as the pointer stays over the svg.
    }
    // Dragging a bead inside the current selection moves the whole run.
    const inSelection = range && index >= range.start && index <= range.end;
    dragRef.current = inSelection
      ? { start: range.start, end: range.end, startX: e.clientX, moved: false }
      : { start: index, end: index, startX: e.clientX, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (e.buttons === 0) {
      // The release happened somewhere we never saw a pointerup.
      cancelDrag();
      return;
    }
    // A few px of slop so ordinary clicks don't register as drags.
    if (!d.moved && Math.abs(e.clientX - d.startX) < 5) return;
    d.moved = true;
    setDropIndex(gapIndexFromClientX(e.clientX, e.clientY));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d?.moved) {
      didDragRef.current = true;
      // The gesture's own click fires synchronously after pointerup; clear
      // the flag afterwards so it can't swallow an unrelated later click.
      setTimeout(() => {
        didDragRef.current = false;
      }, 0);
      moveDraggedTo(gapIndexFromClientX(e.clientX, e.clientY));
    }
    dragRef.current = null;
    setDropIndex(null);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDropIndex(null);
  };

  const moveDraggedTo = (gap: number) => {
    const d = dragRef.current;
    if (!d) return;
    const block = beads.slice(d.start, d.end + 1);
    // Gaps inside or immediately after the block mean "didn't move".
    const at = gap <= d.start ? gap : gap > d.end + 1 ? gap - block.length : d.start;
    if (at === d.start) return;
    const rest = [...beads.slice(0, d.start), ...beads.slice(d.end + 1)];
    rest.splice(at, 0, ...block);
    mutateBeads(rest);
    setSelection({ anchor: at, focus: at + block.length - 1 });
    setInsertion(at + block.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    // Ctrl/Cmd+Z undoes; Shift with it, or Ctrl/Cmd+Y, redoes.
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "z" || key === "y") {
        e.preventDefault();
        if (key === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
    }
    // Plain M toggles mirror mode (Ctrl/Cmd+M is left to the browser).
    if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setMirror((on) => !on);
      return;
    }
    if (e.key === "Escape") {
      // With the shortcut popover open, Escape belongs to it (its document
      // listener closes it); don't also clear the selection underneath.
      if (showShortcuts) return;
      if (replacing) setReplacingId(null);
      else setSelection(null);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      if (e.shiftKey) {
        if (beads.length === 0) return;
        const hi = beads.length - 1;
        if (selection) {
          const focus = clampIndex(selection.focus + delta, hi);
          setSelection({ anchor: selection.anchor, focus });
          // The caret follows the selection's active (focus) edge.
          setInsertion(focus >= selection.anchor ? focus + 1 : focus);
        } else {
          // Start selecting from the bead beside the caret.
          const idx = clampIndex(delta === 1 ? insertion : insertion - 1, hi);
          setSelection({ anchor: idx, focus: idx });
          setInsertion(delta === 1 ? idx + 1 : idx);
        }
      } else {
        setSelection(null);
        setInsertion(clampIndex(insertion + delta, beads.length));
      }
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    if (range) {
      deleteSelection();
      return;
    }
    // No selection: remove the bead just before the insertion point,
    // i.e. the most recently placed one.
    const at = Math.min(insertion, beads.length);
    if (at === 0) return;
    const removed = deleteRange(at - 1, at - 1);
    mutateBeads(removed.beads);
    setInsertion(removed.insertion);
  };

  // --- design persistence ---
  const loadDesign = (design: Design) => {
    setCurrentId(design.id);
    setName(design.name);
    setTargetMm(Number(design.target_length_mm));
    setCustomTarget(null);
    setBeads(design.beads ?? []);
    setDirty(false);
    setSelection(null);
    setInsertion((design.beads ?? []).length);
    // Neither undo, replace mode nor mirror mode crosses designs, and the
    // load itself isn't a step.
    history.reset();
    setReplacingId(null);
    setMirror(false);
  };

  const switchDesign = (id: string) => {
    if (dirty && !confirm("Discard unsaved changes to the current design?")) return;
    if (id === "") {
      newDesign(true);
      return;
    }
    const design = designs.find((d) => d.id === id);
    if (design) loadDesign(design);
  };

  const newDesign = (skipConfirm = false) => {
    if (!skipConfirm && dirty && !confirm("Discard unsaved changes to the current design?"))
      return;
    setCurrentId(null);
    setName("Untitled design");
    setCustomTarget(null);
    setBeads([]);
    setDirty(false);
    setSelection(null);
    setInsertion(0);
    history.reset();
    setReplacingId(null);
    setMirror(false);
  };

  const saveDesign = async () => {
    setSaving(true);
    setError("");
    try {
      const fields = { name, target_length_mm: targetMm, beads };
      if (currentId) {
        const saved = await updateDesign(currentId, fields);
        setDesigns(designs.map((d) => (d.id === saved.id ? saved : d)));
      } else {
        const saved = await createDesign(fields);
        // The working set built while unsaved belongs to this design now:
        // move it to the design's slot before the key switch restores from it.
        try {
          localStorage.setItem(pinsKeyFor(saved.id), JSON.stringify(pinned));
          localStorage.removeItem(pinsKey);
        } catch {
          // Losing the pins here is no worse than losing them anywhere else.
        }
        setDesigns([saved, ...designs]);
        setCurrentId(saved.id);
      }
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save design");
    } finally {
      setSaving(false);
    }
  };

  const removeDesign = async () => {
    if (!currentId) return;
    if (!confirm(`Delete design "${name}"?`)) return;
    setError("");
    try {
      await deleteDesign(currentId);
      setDesigns(designs.filter((d) => d.id !== currentId));
      try {
        localStorage.removeItem(pinsKey);
      } catch {
        // A stale pin slot is harmless.
      }
      newDesign(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete design");
    }
  };

  // --- strand rendering constants ---
  const maxWidthMm = Math.max(10, ...strand.placed.map((p) => beadWidthMm(p.material)));
  // Extra vertical room below the string for hanging cabochon pendants.
  const pendantDropMm = Math.max(
    0,
    ...strand.placed.map((p) => {
      const v = p.material?.visual;
      if (!v) return 0;
      if (p.setting?.visual) return settingBoxPx(p.setting.visual, 1).L;
      return isPendant(v) ? (hasBail(v) ? CABOCHON_BAIL_MM : 0) + v.length_mm : 0;
    })
  );
  const rulerHeight = 34;
  const marginLeft = 24;
  const boardMm = Math.max(targetMm, strand.totalMm) + 30;
  // "As worn" curve spans the full target (or the strand, if it overran),
  // so the unfilled remainder is visible as bare string.
  const curve = curveGeometry(Math.max(targetMm, strand.totalMm));
  // Padding around the curve for bead widths and hanging pendants.
  const curvePadMm = maxWidthMm / 2 + pendantDropMm + 4;
  const fitPx =
    layout === "curve"
      ? Math.min(
          12,
          Math.max(
            0.8,
            Math.min(
              (containerW - 16) / (curve.widthMm + curvePadMm * 2),
              // Height budget matches the container's max-h-[75vh].
              (viewportH * 0.75 - 16) / (curve.heightMm + curvePadMm * 2)
            )
          )
        )
      : Math.min(12, Math.max(0.8, (containerW - marginLeft - 24) / boardMm));
  const pxPerMm = zoomMode === "fit" ? fitPx : customPx;
  const strandHeight = (maxWidthMm + pendantDropMm) * pxPerMm + 16;
  const boardWidth = marginLeft + boardMm * pxPerMm + 24;
  const centerY = 8 + (maxWidthMm * pxPerMm) / 2;
  const curveOffPx = curvePadMm * pxPerMm;
  const curveWidthPx = (curve.widthMm + curvePadMm * 2) * pxPerMm;
  const curveHeightPx = (curve.heightMm + curvePadMm * 2) * pxPerMm;

  // Necklaces are built center-out and worn symmetric, so the strand is
  // centered on the worn curve: its midpoint sits at the drape's lowest
  // point (or the bracelet's bottom), with bare string split evenly across
  // both ends. Zero when the strand fills or overruns the curve.
  const wornOffsetMm = layout === "curve" ? (curve.curveMm - strand.totalMm) / 2 : 0;

  /** Position of arc length s on the worn curve, in svg px. */
  const curvePointPx = (sMm: number) => {
    const p = curve.pointAt(Math.min(Math.max(sMm, 0), curve.curveMm));
    return {
      x: curveOffPx + p.x * pxPerMm,
      y: curveOffPx + p.y * pxPerMm,
      tangentDeg: p.tangentDeg,
      hangDeg: p.hangDeg,
    };
  };

  /** Caret/drop/target tick drawn perpendicular to the worn curve. */
  // Vertical marker on the straight layout, spanning the strand's thickness
  // plus `extraPx` each side — the counterpart of curveTick below.
  const straightTick = (
    xPx: number,
    stroke: string,
    strokeWidth: number,
    extraPx: number,
    dash?: string
  ) => (
    <line
      x1={xPx}
      y1={centerY - (maxWidthMm * pxPerMm) / 2 - extraPx}
      x2={xPx}
      y2={centerY + (maxWidthMm * pxPerMm) / 2 + extraPx}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
    />
  );

  const curveTick = (
    sMm: number,
    stroke: string,
    strokeWidth: number,
    extraPx: number,
    dash?: string
  ) => {
    const pt = curvePointPx(sMm);
    const rad = ((pt.tangentDeg + 90) * Math.PI) / 180;
    const r = (maxWidthMm / 2) * pxPerMm + extraPx;
    return (
      <line
        x1={pt.x - Math.cos(rad) * r}
        y1={pt.y - Math.sin(rad) * r}
        x2={pt.x + Math.cos(rad) * r}
        y2={pt.y + Math.sin(rad) * r}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
      />
    );
  };

  /** Transform putting an element's local frame at its spot on the strand:
   * origin at the element center, x along the given direction. */
  const frameAt = (centerS: number, rotation: "tangent" | "hang") => {
    if (layout === "curve") {
      const pt = curvePointPx(centerS + wornOffsetMm);
      const deg = rotation === "tangent" ? pt.tangentDeg : pt.hangDeg - 90;
      return `translate(${pt.x}, ${pt.y}) rotate(${deg})`;
    }
    return `translate(${marginLeft + centerS * pxPerMm}, ${centerY})`;
  };

  const zoomBy = (factor: number) => {
    setZoomMode("custom");
    setCustomPx(Math.min(14, Math.max(1, pxPerMm * factor)));
  };

  const inchTicks = useMemo(() => {
    const ticks: { xMm: number; major: boolean; label?: string }[] = [];
    const maxIn = boardMm / MM_PER_INCH;
    for (let quarter = 0; quarter <= maxIn * 4; quarter++) {
      const inches = quarter / 4;
      ticks.push({
        xMm: inches * MM_PER_INCH,
        major: quarter % 4 === 0,
        label: quarter % 4 === 0 ? `${inches}"` : undefined,
      });
    }
    return ticks;
  }, [boardMm]);

  const lengthIn = strand.totalMm / MM_PER_INCH;
  // Round away float noise (177.8 / 25.4 = 7.000000000000001) so preset
  // matching and display stay clean.
  const targetIn = Math.round((targetMm / MM_PER_INCH) * 100) / 100;
  /** Arc length of the gap before index i (equals total at the strand end). */
  const sAtGap = (i: number) =>
    i >= strand.placed.length ? strand.totalMm : strand.placed[i]?.xMm ?? 0;

  const insertionX = marginLeft + sAtGap(insertion) * pxPerMm;

  // Mirror axis: the middle gap of an even strand, or the middle of an odd
  // strand's center element. The ghost caret marks where the reflected
  // insert will land (skipped when it coincides with the caret).
  const beadCount = beads.length;
  const axisS =
    beadCount % 2 === 0
      ? sAtGap(beadCount / 2)
      : strand.placed[(beadCount - 1) / 2].xMm +
        strand.placed[(beadCount - 1) / 2].lengthMm / 2;
  const ghostGap = reflectGap(Math.min(insertion, beadCount), beadCount);
  const showGhost = mirror && ghostGap !== Math.min(insertion, beadCount);
  const ghostX = marginLeft + sAtGap(ghostGap) * pxPerMm;

  // Nearest gap between beads for a pointer position (used by strand clicks
  // and drag-drop). Declared here because it needs pxPerMm from above.
  const gapIndexFromClientX = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return beads.length;
    const rect = svg.getBoundingClientRect();
    const sMm =
      layout === "curve"
        ? curve.arcLengthAt(
            (clientX - rect.left - curveOffPx) / pxPerMm,
            (clientY - rect.top - curveOffPx) / pxPerMm
          ) - wornOffsetMm
        : (clientX - rect.left - marginLeft) / pxPerMm;
    let gap = 0;
    for (const p of strand.placed) {
      if (sMm > p.xMm + p.lengthMm / 2) gap = p.index + 1;
    }
    return gap;
  };

  const dropX = dropIndex === null ? null : marginLeft + sAtGap(dropIndex) * pxPerMm;

  /** One palette entry — used by both the working set and the filtered grid. */
  const paletteCard = (m: Material) => {
    const isPinned = pinned.includes(m.id);
    const onStrand = strandCounts.has(m.id);
    const onStrandCount = strandCounts.get(m.id) ?? 0;
    // In replace mode every card becomes a candidate replacement; the one
    // being replaced is flagged so a stray click on it reads as "never mind".
    const isSource = replacing?.id === m.id;
    return (
      <div
        key={m.id}
        className={`flex items-center gap-3 bg-white border rounded-lg px-3 py-2 hover:border-purple-400 group ${
          isSource ? "border-purple-500 ring-2 ring-purple-200" : "border-gray-200"
        }`}
      >
        <button
          onClick={() => (replacing ? replaceMaterial(replacing.id, m.id) : addBead(m.id))}
          className="flex items-center gap-3 flex-1 text-left min-w-0"
          title={
            !replacing
              ? "Add to strand"
              : isSource
                ? "This is the one being replaced — click to cancel"
                : `Replace all ${replacingCount} ${replacing.name} with this`
          }
        >
          <span className="w-9 flex justify-center shrink-0">
            <BeadSwatch visual={m.visual} size={32} seed={m.id} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm text-gray-900 leading-snug">{m.name}</span>
            <span className="block text-xs text-gray-500">
              {m.quantity} in stock · ${m.unit_cost.toFixed(3)}/ea
              {m.visual?.shape === "chain" && (
                <span className="text-purple-600"> · adds 1&quot; per click</span>
              )}
              {pendantAttachment(m.visual) === "placeholder" && (
                <span className="text-amber-600">
                  {" "}
                  · needs setting — {fittingBezels(m, materials).length} fit
                </span>
              )}
            </span>
          </span>
          {isSource ? (
            <X className="w-4 h-4 text-purple-500 opacity-0 group-hover:opacity-100 shrink-0" />
          ) : replacing ? (
            <Replace className="w-4 h-4 text-purple-500 opacity-0 group-hover:opacity-100 shrink-0" />
          ) : (
            <Plus className="w-4 h-4 text-purple-500 opacity-0 group-hover:opacity-100 shrink-0" />
          )}
        </button>
        {onStrand && !replacing && (
          <button
            onClick={() => setReplacingId(m.id)}
            className="p-1 text-gray-300 hover:text-purple-600 shrink-0"
            title={`Replace all ${onStrandCount} on the strand with…`}
            aria-label={`Replace all ${onStrandCount} ${m.name} on the strand`}
          >
            <Replace className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => togglePin(m.id)}
          className={`p-1 shrink-0 ${
            isPinned ? "text-purple-600" : "text-gray-300 hover:text-purple-600"
          }`}
          aria-pressed={isPinned}
          title={isPinned ? "Unpin from working set" : "Pin to working set"}
        >
          <Pin className={`w-3.5 h-3.5 ${isPinned ? "fill-current" : ""}`} />
        </button>
        <button
          onClick={() => setDetailId(m.id)}
          className="p-1 text-gray-300 hover:text-purple-600 shrink-0"
          title="Details — edit, order info, photo"
          aria-label={`Details for ${m.name}`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };


  return (
    <div
      className="space-y-4"
      onKeyDown={handleKeyDown}
    >
      {/* Design toolbar */}
      <div className="bg-gray-50 p-4 rounded-lg flex flex-wrap items-center gap-3">
        <select
          value={currentId ?? ""}
          onChange={(e) => switchDesign(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          <option value="">+ New design</option>
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm flex-1 min-w-40"
          placeholder="Design name"
        />
        <label className="text-sm text-gray-600 flex items-center gap-2">
          Target
          <select
            value={customTarget !== null ? "custom" : targetIn}
            onChange={(e) => {
              if (e.target.value === "custom") {
                setCustomTarget(String(targetIn));
                return;
              }
              setCustomTarget(null);
              setTargetMm(parseFloat(e.target.value) * MM_PER_INCH);
              setDirty(true);
            }}
            className="px-2 py-2 border border-gray-300 rounded-md text-sm bg-white"
          >
            {LENGTH_PRESETS.map((p) => (
              <option key={p.in} value={p.in}>
                {p.in}&quot;{p.label ? ` · ${p.label}` : ""}
              </option>
            ))}
            {customTarget === null &&
              !LENGTH_PRESETS.some((p) => p.in === targetIn) && (
                <option value={targetIn}>{targetIn.toFixed(2)}&quot;</option>
              )}
            <option value="custom">Custom…</option>
          </select>
          {customTarget !== null && (
            <input
              type="number"
              min={1}
              max={100}
              step={0.5}
              value={customTarget}
              onChange={(e) => {
                setCustomTarget(e.target.value);
                const v = parseFloat(e.target.value);
                if (v > 0 && v <= 100) {
                  setTargetMm(v * MM_PER_INCH);
                  setDirty(true);
                }
              }}
              className="w-20 px-2 py-2 border border-gray-300 rounded-md text-sm"
              aria-label="Custom target length in inches"
              autoFocus
            />
          )}
        </label>
        <div className="flex items-center gap-1 bg-white border border-gray-300 rounded-md p-0.5">
          <button
            onClick={() => setZoomMode("fit")}
            className={`px-2 py-1.5 text-xs rounded ${
              zoomMode === "fit"
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-gray-500 hover:text-gray-900"
            }`}
            title="Scale the whole strand to fit the screen"
          >
            Fit
          </button>
          <button
            onClick={() => {
              setZoomMode("custom");
              setCustomPx(ACTUAL_PX_PER_MM);
            }}
            className={`px-2 py-1.5 text-xs rounded ${
              zoomMode === "custom" && Math.abs(customPx - ACTUAL_PX_PER_MM) < 0.01
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-gray-500 hover:text-gray-900"
            }`}
            title="Real size (approximate, assumes a standard 96dpi screen)"
          >
            1:1
          </button>
          <button
            onClick={() => zoomBy(1 / 1.25)}
            className="p-1.5 text-gray-500 hover:text-gray-900 rounded"
            title="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={() => zoomBy(1.25)}
            className="p-1.5 text-gray-500 hover:text-gray-900 rounded"
            title="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1 bg-white border border-gray-300 rounded-md p-0.5">
          <button
            onClick={() => setLayout("line")}
            className={`px-2 py-1.5 text-xs rounded ${
              layout === "line"
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-gray-500 hover:text-gray-900"
            }`}
            title="Straight editing strand with ruler"
          >
            Line
          </button>
          <button
            onClick={() => setLayout("curve")}
            className={`px-2 py-1.5 text-xs rounded ${
              layout === "curve"
                ? "bg-purple-100 text-purple-700 font-medium"
                : "text-gray-500 hover:text-gray-900"
            }`}
            title="How the piece lies when worn — a circle for bracelet lengths, a hanging drape for necklaces"
          >
            As worn
          </button>
        </div>
        <button
          onClick={saveDesign}
          disabled={saving || !dirty}
          className="flex items-center px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
        >
          <Save className="w-4 h-4 mr-1" />
          {saving ? "Saving…" : dirty || !currentId ? "Save" : "Saved"}
        </button>
        {currentId && (
          <button
            onClick={removeDesign}
            className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
            title="Delete design"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Strand board */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        {layout === "curve" && (
          <p className="mb-2 text-xs text-gray-500">
            {curve.kind === "circle"
              ? "Bracelet (as worn) — closes into a circle; targets of 12″ and up hang as a necklace"
              : "Necklace (as worn) — hangs as it would when worn"}
          </p>
        )}
        {/* selection bar (GRA-45): actions scoped to the selected run. The
            slot is always rendered so the strand doesn't jump when a click
            starts a selection; with nothing selected it just says how to.
            Whole-strand tools stay in the action row under the strand. */}
        {range ? (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-purple-50/70 border border-purple-200 rounded-lg px-3 py-1.5 text-sm">
            <span className="text-purple-900">
              <strong>{selectionCount}</strong> {selectionCount === 1 ? "bead" : "beads"}{" "}
              selected
              {selectionMaterial && <> · {selectionMaterial.name}</>}
            </span>
            {/* Selection actions — keep them in this one div so a further
                action (e.g. "Set into…") slots in beside Replace all…. */}
            <div className="flex flex-nowrap items-center gap-1">
              <button
                onClick={deleteSelection}
                className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Remove
              </button>
              <button
                onClick={() => selectionMaterialId && setReplacingId(selectionMaterialId)}
                disabled={!selectionMaterialId}
                className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                title={
                  selectionMaterialId
                    ? "Swap every bead of the selected material — anywhere on the strand — for one you pick from the palette"
                    : "Select beads of a single material to replace all of them"
                }
              >
                <Replace className="w-4 h-4 mr-1" />
                Replace all…
              </button>
            {selectedCab && (
              <div className="relative" ref={settingPickerRef}>
                <button
                  onClick={() =>
                    selectedBead?.setting_id ? setSetting(null) : setSettingPickerOpen((o) => !o)
                  }
                  aria-expanded={settingPickerOpen}
                  className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
                  title={
                    selectedBead?.setting_id
                      ? "Take this stone out of its bezel setting"
                      : "Set this stone into a bezel setting from your inventory"
                  }
                >
                  <Gem className="w-4 h-4 mr-1" />
                  {selectedBead?.setting_id ? "Unset" : "Set into…"}
                </button>
                {settingPickerOpen && !selectedBead?.setting_id && (
                  <div className="absolute left-0 top-full mt-1 z-20 w-72 max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg p-1">
                    {fittingSettings.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-gray-500">
                        No settings in inventory fit this stone
                      </p>
                    ) : (
                      fittingSettings.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setSetting(s.id)}
                          className="w-full flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-purple-50 text-left"
                        >
                          <span className="w-9 flex justify-center shrink-0">
                            <BeadSwatch visual={s.visual} size={28} seed={s.id} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm text-gray-900 truncate">{s.name}</span>
                            <span className="block text-xs text-gray-500">{s.quantity} in stock</span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            </div>
            <span className="ml-auto text-xs text-gray-500">
              {replacing ? "Esc to cancel replace" : "Esc to deselect"}
            </span>
          </div>
        ) : (
          <div className="mb-2 flex items-center border border-transparent rounded-lg px-3 py-1.5 text-sm text-gray-400">
            <span className="py-1.5">
              Click a bead to select it · shift-click or Shift+arrows for a range
            </span>
          </div>
        )}
        <div
          className={layout === "curve" ? "overflow-auto max-h-[75vh]" : "overflow-x-auto"}
          tabIndex={0}
          ref={boardRef}
        >
          <svg
            ref={svgRef}
            width={layout === "curve" ? curveWidthPx : boardWidth}
            height={layout === "curve" ? curveHeightPx : strandHeight + rulerHeight}
            onClick={handleBoardClick}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            className="block cursor-default touch-none"
          >
            {/* string: straight, or the full worn curve so the unfilled
                remainder shows as bare string */}
            {layout === "curve" ? (
              <path
                transform={`translate(${curveOffPx}, ${curveOffPx}) scale(${pxPerMm})`}
                d={curvePath(curve)}
                fill="none"
                stroke="#a8a29e"
                strokeWidth={1.5 / pxPerMm}
              />
            ) : (
              <line
                x1={marginLeft - 12}
                y1={centerY}
                x2={marginLeft + strand.totalMm * pxPerMm + 12}
                y2={centerY}
                stroke="#a8a29e"
                strokeWidth={1.5}
              />
            )}

            {/* beads — the outer frame puts the element's center at its spot
                on the strand with local x along the direction of travel, so
                the same drawing works straight or curved */}
            {strand.placed.map((p) => {
              const visual = p.material?.visual ?? null;
              const widthMm = beadWidthMm(p.material);
              const selected = range && p.index >= range.start && p.index <= range.end;
              const centerS = p.xMm + p.lengthMm / 2;
              const lengthPx = p.lengthMm * pxPerMm;
              const widthPx = widthMm * pxPerMm;
              const setting = p.setting?.visual ?? null;
              if (visual && (setting || isPendant(visual))) {
                // Pendant local frame: the string at the origin, stone hanging
                // toward +y. On the worn curve, +y is rotated to gravity
                // (drape) or radially outward (bracelet). A set stone's box
                // is its bezel's frame; it hangs from the bezel's loop.
                const box = setting
                  ? settingBoxPx(setting, pxPerMm)
                  : { L: visual.length_mm * pxPerMm, W: visual.width_mm * pxPerMm };
                const stoneW = box.W;
                const stoneL = box.L;
                const bail = !setting && hasBail(visual);
                const bailR = bail ? (CABOCHON_BAIL_MM / 2) * pxPerMm : 0;
                // Undrilled (or unrecorded) stones have no hardware yet — a
                // dashed amber bail marks the setting they still need.
                const bailDash = bail && pendantAttachment(visual) === "placeholder";
                const stoneTop = bail ? bailR * 1.6 : 0;
                const drillNote = setting
                  ? `Set in ${p.setting?.name ?? "bezel setting"}`
                  : visual.shape === "bezel"
                    ? "Empty bezel setting — select a cabochon and use Set into… to combine them"
                    : visual.drill
                      ? DRILL_LABELS[visual.drill]
                      : "Drill type not recorded — set it in Inventory";
                const fallbackName = visual.shape === "bezel" ? "Bezel setting" : "Cabochon";
                return (
                  <g
                    key={p.index}
                    transform={frameAt(centerS, "hang")}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBeadClick(p.index, e.shiftKey);
                    }}
                    onPointerDown={(e) => handleBeadPointerDown(p.index, e)}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <title>{`${p.material?.name ?? fallbackName} · ${drillNote}`}</title>
                    {selected && (
                      <rect
                        x={-stoneW / 2 - 1.5}
                        y={-bailR - 3}
                        width={stoneW + 3}
                        height={stoneTop + bailR + stoneL + 6}
                        rx={4}
                        fill="#a855f7"
                        opacity={0.25}
                      />
                    )}
                    {bail && (
                      <circle
                        cx={0}
                        cy={bailR * 0.6}
                        r={bailR}
                        fill="none"
                        stroke={bailDash ? "#d97706" : "#9ca3af"}
                        strokeWidth={Math.max(1, bailR * 0.35)}
                        strokeDasharray={bailDash ? `${bailR * 0.7} ${bailR * 0.5}` : undefined}
                      />
                    )}
                    <g transform={`translate(${stoneW / 2}, ${stoneTop}) rotate(90)`}>
                      <Bead
                        visual={visual}
                        setting={setting}
                        pxPerMm={pxPerMm}
                        seed={p.material?.id ?? "missing"}
                      />
                    </g>
                  </g>
                );
              }
              return (
                <g
                  key={p.index}
                  transform={frameAt(centerS, "tangent")}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBeadClick(p.index, e.shiftKey);
                  }}
                  onPointerDown={(e) => handleBeadPointerDown(p.index, e)}
                  className="cursor-grab active:cursor-grabbing"
                >
                  <g transform={`translate(${-lengthPx / 2}, ${-widthPx / 2})`}>
                    {selected && (
                      <rect
                        x={-1.5}
                        y={-3}
                        width={lengthPx + 3}
                        height={widthPx + 6}
                        rx={4}
                        fill="#a855f7"
                        opacity={0.25}
                      />
                    )}
                    {visual ? (
                      <Bead
                        visual={visual}
                        pxPerMm={pxPerMm}
                        seed={p.material?.id ?? "missing"}
                      />
                    ) : (
                      <g>
                        <ellipse
                          cx={lengthPx / 2}
                          cy={widthPx / 2}
                          rx={lengthPx / 2}
                          ry={widthPx / 2}
                          fill="#e5e7eb"
                          stroke="#9ca3af"
                          strokeDasharray="3 2"
                        />
                      </g>
                    )}
                  </g>
                </g>
              );
            })}

            {/* symmetric target markers when the centered strand overruns
                it (line mode has the ruler's dashed marker instead) */}
            {layout === "curve" && strand.totalMm > targetMm && (
              <>
                {curveTick(
                  wornOffsetMm + (strand.totalMm - targetMm) / 2,
                  "#dc2626",
                  1.5,
                  6,
                  "4 3"
                )}
                {curveTick(
                  wornOffsetMm + strand.totalMm - (strand.totalMm - targetMm) / 2,
                  "#dc2626",
                  1.5,
                  6,
                  "4 3"
                )}
              </>
            )}

            {/* mirror axis, and a ghost of where the reflected insert lands */}
            {mirror &&
              beadCount > 0 &&
              (layout === "curve"
                ? curveTick(axisS + wornOffsetMm, "#a8a29e", 1, 10, "3 3")
                : straightTick(marginLeft + axisS * pxPerMm, "#a8a29e", 1, 10, "3 3"))}
            {showGhost &&
              (layout === "curve"
                ? curveTick(sAtGap(ghostGap) + wornOffsetMm, "#c4b5fd", 2, 4, "3 3")
                : straightTick(ghostX, "#c4b5fd", 2, 4, "3 3"))}

            {/* insertion caret */}
            {layout === "curve"
              ? curveTick(sAtGap(insertion) + wornOffsetMm, "#a855f7", 2, 4)
              : straightTick(insertionX, "#a855f7", 2, 4)}

            {/* drop indicator while dragging */}
            {dropIndex !== null &&
              (layout === "curve" ? (
                curveTick(sAtGap(dropIndex) + wornOffsetMm, "#16a34a", 2.5, 6)
              ) : (
                <line
                  x1={dropX ?? 0}
                  y1={centerY - (maxWidthMm * pxPerMm) / 2 - 6}
                  x2={dropX ?? 0}
                  y2={centerY + (maxWidthMm * pxPerMm) / 2 + 6}
                  stroke="#16a34a"
                  strokeWidth={2.5}
                />
              ))}

            {/* ruler (straight view only) */}
            {layout === "line" && (
            <g transform={`translate(0, ${strandHeight})`}>
              <line
                x1={marginLeft}
                y1={0}
                x2={marginLeft + boardMm * pxPerMm}
                y2={0}
                stroke="#78716c"
                strokeWidth={1}
              />
              {inchTicks.map((tick, i) => (
                <g key={i}>
                  <line
                    x1={marginLeft + tick.xMm * pxPerMm}
                    y1={0}
                    x2={marginLeft + tick.xMm * pxPerMm}
                    y2={tick.major ? 10 : 5}
                    stroke="#78716c"
                    strokeWidth={1}
                  />
                  {tick.label && (
                    <text
                      x={marginLeft + tick.xMm * pxPerMm}
                      y={22}
                      textAnchor="middle"
                      fontSize={10}
                      fill="#57534e"
                    >
                      {tick.label}
                    </text>
                  )}
                </g>
              ))}
              {/* target marker */}
              <g>
                <line
                  x1={marginLeft + targetMm * pxPerMm}
                  y1={-strandHeight}
                  x2={marginLeft + targetMm * pxPerMm}
                  y2={12}
                  stroke="#dc2626"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <text
                  x={marginLeft + targetMm * pxPerMm + 4}
                  y={-strandHeight + 12}
                  fontSize={10}
                  fill="#dc2626"
                >
                  target {targetIn}&quot;
                </text>
              </g>
            </g>
            )}
          </svg>
        </div>

        {/* pattern actions + totals (GRA-45): whole-strand tools in divided
            groups. Each group is flex-nowrap inside a flex-wrap row, so on a
            narrow screen the row wraps by group rather than mid-group — except
            the Mirror group, whose outer div wraps so the asymmetry note can
            drop under its (non-splitting) buttons. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <div className="flex flex-nowrap items-center gap-1">
            <button
              onClick={undo}
              disabled={!history.canUndo}
              className="flex items-center px-2 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Undo (Ctrl+Z / ⌘Z)"
              aria-label="Undo"
            >
              <Undo2 className="w-5 h-5" />
            </button>
            <button
              onClick={redo}
              disabled={!history.canRedo}
              className="flex items-center px-2 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Redo (Ctrl+Shift+Z / ⌘⇧Z / Ctrl+Y)"
              aria-label="Redo"
            >
              <Redo2 className="w-5 h-5" />
            </button>
          </div>
          <div className="flex flex-nowrap items-center gap-1 border-l border-gray-200 pl-3">
            <button
              onClick={() => repeatSelection(repeatCount)}
              disabled={!range}
              className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title={range ? "Repeat the selected beads" : "Select beads first"}
            >
              <Repeat className="w-4 h-4 mr-1" />
              Repeat ×
            </button>
            <input
              type="number"
              min={1}
              max={50}
              value={repeatCount}
              onChange={(e) =>
                setRepeatCount(Math.max(1, parseInt(e.target.value) || 1))
              }
              className="w-12 px-2 py-1.5 border border-gray-300 rounded-md"
            />
            <button
              onClick={fillToTarget}
              disabled={beads.length === 0}
              className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Repeat the selection (or whole strand) until the target length is reached"
            >
              <ArrowRightToLine className="w-4 h-4 mr-1" />
              Fill to target
            </button>
          </div>
          {/* The three buttons never split; the asymmetry note may wrap
              under them when there's no room beside. */}
          <div className="flex flex-wrap items-center gap-1 border-l border-gray-200 pl-3">
            <div className="flex flex-nowrap items-center gap-1">
              <button
                onClick={() => setMirror((on) => !on)}
                aria-pressed={mirror}
                className={`flex items-center px-3 py-1.5 border rounded-md ${
                  mirror
                    ? "bg-purple-100 border-purple-300 text-purple-700 font-medium"
                    : "bg-white border-gray-300 hover:bg-gray-100"
                }`}
                title="Mirror edits around the strand's center (M) — build to the right of the pendant; drag isn't mirrored"
              >
                <FlipHorizontal2 className="w-4 h-4 mr-1" />
                Mirror
              </button>
              <button
                onClick={() => symmetrize("left")}
                disabled={!folds.left.ok}
                className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-l-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                title={`Make symmetric — ${foldTitle("left")}`}
              >
                ◀ Keep left
              </button>
              <button
                onClick={() => symmetrize("right")}
                disabled={!folds.right.ok}
                className="flex items-center px-3 py-1.5 -ml-px bg-white border border-gray-300 rounded-r-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                title={`Make symmetric — ${foldTitle("right")}`}
              >
                Keep right ▶
              </button>
            </div>
            {mirror && !symmetric && (
              <span className="text-xs text-amber-700">Strand isn&apos;t symmetric</span>
            )}
          </div>
          <div className="flex flex-nowrap items-center border-l border-gray-200 pl-3">
            <button
              onClick={clearAll}
              disabled={beads.length === 0}
              className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Eraser className="w-4 h-4 mr-1" />
              Clear
            </button>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-gray-700">
            <span>
              <strong>{beads.length}</strong> beads
            </span>
            <span
              className={
                strand.totalMm > targetMm ? "text-red-600 font-medium" : undefined
              }
            >
              <strong>{lengthIn.toFixed(2)}&quot;</strong> of {targetIn}&quot; (
              {strand.totalMm.toFixed(0)}mm)
            </span>
            <span>
              <strong>${totalCost.toFixed(2)}</strong> materials
            </span>
          </div>
        </div>

        {stockIssues.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {stockIssues.map((issue) => (
              <span
                key={issue.name}
                className="text-xs px-2 py-1 bg-amber-100 border border-amber-300 text-amber-800 rounded"
              >
                {issue.name}: need {issue.need}, have {issue.have}
              </span>
            ))}
          </div>
        )}

        <div className="relative mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-gray-500">
          <p>
            {beads.length === 0 ? (
              <>
                Click a bead in the palette to start the strand. Click a placed
                bead to select it (shift-click for a range), then Repeat or Fill
                to build a pattern.
              </>
            ) : (
              <>
                Click between beads to move the insertion point · Backspace
                removes the last-placed bead · Ctrl+Z / ⌘Z undoes
              </>
            )}
          </p>
          <div ref={shortcutsRef} className="contents">
            <button
              type="button"
              onClick={() => setShowShortcuts((on) => !on)}
              // Don't take focus: the board keeps it, so shortcuts still work
              // while the popover is open.
              onMouseDown={(e) => e.preventDefault()}
              aria-expanded={showShortcuts}
              aria-controls="board-shortcuts"
              aria-label="All keyboard shortcuts"
              title="All keyboard shortcuts"
              className="p-1 rounded text-gray-400 hover:text-gray-700"
            >
              <CircleHelp className="w-4 h-4" />
            </button>
            {showShortcuts && (
              <div
                id="board-shortcuts"
                aria-label="Keyboard shortcuts"
                className="absolute left-0 top-full z-10 mt-1 w-full max-w-md bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs text-gray-700"
              >
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-baseline">
                  <dt className="whitespace-nowrap"><Kbd>←</Kbd> <Kbd>→</Kbd></dt>
                  <dd>Move the insertion point</dd>
                  <dt className="whitespace-nowrap"><Kbd>Shift</Kbd> + <Kbd>←</Kbd> <Kbd>→</Kbd></dt>
                  <dd>Select beads from the insertion point (extends a selection)</dd>
                  <dt className="whitespace-nowrap"><Kbd>Esc</Kbd></dt>
                  <dd>Clear the selection, or cancel Replace all</dd>
                  <dt className="whitespace-nowrap"><Kbd>Backspace</Kbd> <Kbd>Delete</Kbd></dt>
                  <dd>Remove the selection, or the last-placed bead</dd>
                  <dt className="whitespace-nowrap"><Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> / <Kbd>⌘Z</Kbd></dt>
                  <dd>Undo</dd>
                  <dt className="whitespace-nowrap"><Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd> / <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd></dt>
                  <dd>Redo</dd>
                  <dt className="whitespace-nowrap"><Kbd>M</Kbd></dt>
                  <dd>Toggle mirror mode</dd>
                  <dt className="whitespace-nowrap">Drag</dt>
                  <dd>Rearrange a bead or a selected run</dd>
                </dl>
                <p className="mt-2 text-gray-500">
                  In mirror mode, Backspace removes the bead and its mirror, and
                  drag isn&apos;t mirrored.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Palette */}
      <div className="bg-gray-50 p-4 rounded-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Palette</h2>
          {generating && (
            <span className="text-sm text-purple-600 flex items-center gap-1">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating artwork…
            </span>
          )}
        </div>
        {replacing && (
          <div className="mb-3 flex flex-wrap items-center gap-3 bg-purple-100 border border-purple-300 text-purple-900 rounded-lg px-3 py-2 text-sm">
            <Replace className="w-4 h-4 shrink-0" />
            <span className="flex-1 min-w-0">
              Replacing all {replacingCount} <strong>{replacing.name}</strong> on the strand —
              pick a replacement from the palette below, or press Esc / Cancel.
            </span>
            <button
              onClick={() => setReplacingId(null)}
              className="px-2 py-1 bg-white border border-purple-300 rounded-md hover:bg-purple-50"
            >
              Cancel
            </button>
          </div>
        )}
        {workingSet.length > 0 && (
          <div className="mb-4 bg-purple-50/70 border border-purple-200 rounded-lg p-3">
            {pinned.length > 0 && (
              <div className="flex justify-end mb-2">
                <button
                  onClick={() => updatePinned(() => [])}
                  className="text-xs text-purple-700/70 hover:text-purple-900"
                >
                  Unpin all
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {workingSet.map(paletteCard)}
            </div>
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-2">
          <SearchField
            value={paletteSearch}
            onChange={setPaletteSearch}
            className="flex-1 min-w-48"
          />
          <BeadFilters
            categories={categoryOptions}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
            familyFilter={familyFilter}
            sizeFilter={sizeFilter}
            onFamilyChange={setFamilyFilter}
            onSizeChange={setSizeFilter}
          />
        </div>
        {palette.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            {workingSet.length > 0
              ? "Nothing else matches — clear the search or filters to see more."
              : "Nothing to place yet — import a receipt or add materials from the Inventory page."}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {palette.map(paletteCard)}
          </div>
        )}
      </div>

      {detailMaterial && (
        <MaterialDetailModal
          material={detailMaterial}
          onClose={() => setDetailId(null)}
          onChanged={onMaterialsChanged}
          onError={setError}
        />
      )}
    </div>
  );
}

// Key cap for the shortcut popover.
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-1 py-0.5 rounded border border-gray-300 bg-gray-50 font-mono text-[11px] text-gray-800">
      {children}
    </kbd>
  );
}
