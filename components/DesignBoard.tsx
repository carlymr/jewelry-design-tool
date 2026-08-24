"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Save,
  Trash2,
  RefreshCw,
  Search,
  Repeat,
  ArrowRightToLine,
  Eraser,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import BeadSwatch, { Bead } from "@/components/BeadSwatch";
import BeadFilters from "@/components/BeadFilters";
import PhotoVisualButton from "@/components/PhotoVisualButton";
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
  colorFamilyOf,
  sizeBucketOf,
  type BeadVisual,
} from "@/lib/bead-visual";
import type { Design, DesignBead, Material } from "@/lib/types";

const MM_PER_INCH = 25.4;
// CSS reference pixel: 96px per inch, so this renders beads at ~life size.
const ACTUAL_PX_PER_MM = 96 / MM_PER_INCH;
// Beads without a generated visual still need to advance the strand somehow.
const FALLBACK_BEAD_MM = 6;
const MAX_BEADS = 500;
const LENGTH_PRESETS_IN = [6, 6.5, 7, 7.5, 8, 9, 16, 18, 20];
const VISUALS_BATCH = 60;
// Categories whose items can sit on a strand and belong in the palette.
// Wire/cord/tools stay inventory-only. Anything else with a generated visual
// (e.g. a chain filed under Stringing) is also placeable.
const PLACEABLE_CATEGORIES = new Set(["Beads", "Cabochons", "Findings"]);
// Working-copy draft persisted to localStorage so navigation, reloads, and
// tab closes can't lose unsaved strand work.
const DRAFT_KEY = "design-board-draft";

interface Props {
  materials: Material[];
  onMaterialsChanged: () => Promise<void>;
}

// A cabochon is worn as a pendant: it hangs below the string from a bail and
// advances the strand by only the bail's width, not the stone's size.
const CABOCHON_ADVANCE_MM = 6;
const CABOCHON_BAIL_MM = 4;

const beadLengthMm = (m: Material | undefined) =>
  m?.visual?.shape === "cabochon"
    ? CABOCHON_ADVANCE_MM
    : m?.visual?.length_mm ?? FALLBACK_BEAD_MM;
const beadWidthMm = (m: Material | undefined) =>
  m?.visual?.shape === "cabochon"
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
  const [name, setName] = useState("Untitled design");
  const [targetMm, setTargetMm] = useState(7 * MM_PER_INCH);
  const [beads, setBeads] = useState<DesignBead[]>([]);
  const [dirty, setDirty] = useState(false);

  // --- UI state ---
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(
    null
  );
  const [insertion, setInsertion] = useState(0);
  const [repeatCount, setRepeatCount] = useState(3);
  const [zoomMode, setZoomMode] = useState<"fit" | "custom">("fit");
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
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  // Ids we've already requested a visual for, so partial API results don't
  // retry forever and later-added materials still get picked up.
  const attemptedVisuals = useRef(new Set<string>());

  const materialById = useMemo(
    () => new Map(materials.map((m) => [m.id, m])),
    [materials]
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
          JSON.stringify({ currentId, name, targetMm, beads })
        );
      }
    } catch {
      // Quota/private-mode failures just lose the safety net, nothing else.
    }
  }, [dirty, currentId, name, targetMm, beads, draftKey]);

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

  const regenerateVisual = async (material: Material) => {
    setRegeneratingId(material.id);
    setError("");
    try {
      const res = await fetch("/api/generate-visuals", {
        method: "POST",
        headers: await apiHeaders(),
        body: JSON.stringify({
          materials: [{ id: material.id, name: material.name }],
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      const visual = result.visuals?.[0]?.visual;
      if (visual) {
        await updateMaterial(material.id, { visual });
        await onMaterialsChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to regenerate");
    } finally {
      setRegeneratingId(null);
    }
  };

  // --- palette ---
  const palette = useMemo(() => {
    const term = paletteSearch.toLowerCase();
    return materials
      .filter((m) => PLACEABLE_CATEGORIES.has(m.category) || m.visual)
      .filter((m) => !categoryFilter || m.category === categoryFilter)
      .filter((m) => m.name.toLowerCase().includes(term))
      .filter((m) => !familyFilter || colorFamilyOf(m.visual) === familyFilter)
      .filter((m) => !sizeFilter || sizeBucketOf(m.visual) === sizeFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [materials, paletteSearch, categoryFilter, familyFilter, sizeFilter]);

  // --- derived strand geometry ---
  const strand = useMemo(() => {
    let x = 0;
    const placed = beads.map((b, index) => {
      const material = materialById.get(b.material_id);
      const lengthMm = beadLengthMm(material);
      const bead = { index, material, xMm: x, lengthMm };
      x += lengthMm;
      return bead;
    });
    return { placed, totalMm: x };
  }, [beads, materialById]);

  const totalCost = useMemo(
    () =>
      strand.placed.reduce((sum, p) => sum + (p.material?.unit_cost ?? 0), 0),
    [strand]
  );

  const stockIssues = useMemo(() => {
    const used = new Map<string, number>();
    for (const b of beads) used.set(b.material_id, (used.get(b.material_id) ?? 0) + 1);
    const issues: { name: string; need: number; have: number }[] = [];
    for (const [id, need] of used) {
      const m = materialById.get(id);
      if (m && need > m.quantity) {
        issues.push({ name: m.name, need, have: m.quantity });
      }
    }
    return issues;
  }, [beads, materialById]);

  const range = selection
    ? {
        start: Math.min(selection.anchor, selection.focus),
        end: Math.max(selection.anchor, selection.focus),
      }
    : null;

  // --- editing actions ---
  const mutateBeads = (next: DesignBead[]) => {
    setBeads(next.slice(0, MAX_BEADS));
    setDirty(true);
  };

  const addBead = (materialId: string) => {
    if (beads.length >= MAX_BEADS) return;
    const at = Math.min(insertion, beads.length);
    const next = [...beads];
    next.splice(at, 0, { material_id: materialId });
    mutateBeads(next);
    setInsertion(at + 1);
    setSelection(null);
  };

  const deleteSelection = useCallback(() => {
    if (!range) return;
    const next = beads.filter((_, i) => i < range.start || i > range.end);
    mutateBeads(next);
    setSelection(null);
    setInsertion(range.start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beads, range]);

  const repeatSelection = (times: number) => {
    if (!range || times < 1) return;
    const pattern = beads.slice(range.start, range.end + 1);
    const copies = Array.from({ length: times }, () => pattern.map((b) => ({ ...b })));
    const next = [...beads];
    next.splice(range.end + 1, 0, ...copies.flat());
    mutateBeads(next);
    setInsertion(Math.min(range.end + 1 + pattern.length * times, MAX_BEADS));
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
    const next = [...beads];
    let total = strand.totalMm;
    while (total + patternMm <= targetMm + 0.001 && next.length + pattern.length <= MAX_BEADS) {
      next.push(...pattern.map((b) => ({ ...b })));
      total += patternMm;
    }
    if (next.length === beads.length) return;
    mutateBeads(next);
    setInsertion(next.length);
  };

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
    setInsertion(gapIndexFromClientX(e.clientX));
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
    setDropIndex(gapIndexFromClientX(e.clientX));
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
      moveDraggedTo(gapIndexFromClientX(e.clientX));
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
    if (e.key === "Escape") {
      setSelection(null);
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
    if (at > 0) {
      const next = [...beads];
      next.splice(at - 1, 1);
      mutateBeads(next);
      setInsertion(at - 1);
    }
  };

  // --- design persistence ---
  const loadDesign = (design: Design) => {
    setCurrentId(design.id);
    setName(design.name);
    setTargetMm(Number(design.target_length_mm));
    setBeads(design.beads ?? []);
    setDirty(false);
    setSelection(null);
    setInsertion((design.beads ?? []).length);
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
    setBeads([]);
    setDirty(false);
    setSelection(null);
    setInsertion(0);
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
    ...strand.placed.map((p) =>
      p.material?.visual?.shape === "cabochon"
        ? CABOCHON_BAIL_MM + p.material.visual.length_mm
        : 0
    )
  );
  const rulerHeight = 34;
  const marginLeft = 24;
  const boardMm = Math.max(targetMm, strand.totalMm) + 30;
  const fitPx = Math.min(12, Math.max(0.8, (containerW - marginLeft - 24) / boardMm));
  const pxPerMm = zoomMode === "fit" ? fitPx : customPx;
  const strandHeight = (maxWidthMm + pendantDropMm) * pxPerMm + 16;
  const boardWidth = marginLeft + boardMm * pxPerMm + 24;
  const centerY = 8 + (maxWidthMm * pxPerMm) / 2;

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
  const insertionX =
    marginLeft +
    (insertion >= strand.placed.length
      ? strand.totalMm
      : strand.placed[insertion]?.xMm ?? 0) *
      pxPerMm;

  // Nearest gap between beads for a pointer position (used by strand clicks
  // and drag-drop). Declared here because it needs pxPerMm from above.
  const gapIndexFromClientX = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return beads.length;
    const xMm = (clientX - svg.getBoundingClientRect().left - marginLeft) / pxPerMm;
    let gap = 0;
    for (const p of strand.placed) {
      if (xMm > p.xMm + p.lengthMm / 2) gap = p.index + 1;
    }
    return gap;
  };

  const dropX =
    dropIndex === null
      ? null
      : marginLeft +
        (dropIndex >= strand.placed.length
          ? strand.totalMm
          : strand.placed[dropIndex]?.xMm ?? 0) *
          pxPerMm;

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
            value={targetIn}
            onChange={(e) => {
              setTargetMm(parseFloat(e.target.value) * MM_PER_INCH);
              setDirty(true);
            }}
            className="px-2 py-2 border border-gray-300 rounded-md text-sm bg-white"
          >
            {LENGTH_PRESETS_IN.map((len) => (
              <option key={len} value={len}>
                {len}&quot;
              </option>
            ))}
            {!LENGTH_PRESETS_IN.includes(targetIn) && (
              <option value={targetIn}>{targetIn.toFixed(2)}&quot;</option>
            )}
          </select>
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
        <div className="overflow-x-auto" tabIndex={0} ref={boardRef}>
          <svg
            ref={svgRef}
            width={boardWidth}
            height={strandHeight + rulerHeight}
            onClick={handleBoardClick}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={cancelDrag}
            className="block cursor-default touch-none"
          >
            {/* string */}
            <line
              x1={marginLeft - 12}
              y1={centerY}
              x2={marginLeft + strand.totalMm * pxPerMm + 12}
              y2={centerY}
              stroke="#a8a29e"
              strokeWidth={1.5}
            />

            {/* beads */}
            {strand.placed.map((p) => {
              const visual = p.material?.visual ?? null;
              const widthMm = beadWidthMm(p.material);
              const selected = range && p.index >= range.start && p.index <= range.end;
              if (visual?.shape === "cabochon") {
                // Pendant: a bail ring on the string with the stone hanging
                // below it, long axis vertical.
                const stoneW = visual.width_mm * pxPerMm;
                const stoneL = visual.length_mm * pxPerMm;
                const advancePx = p.lengthMm * pxPerMm;
                const bailR = (CABOCHON_BAIL_MM / 2) * pxPerMm;
                const stoneTop = centerY + bailR * 1.6;
                return (
                  <g
                    key={p.index}
                    transform={`translate(${marginLeft + p.xMm * pxPerMm}, 0)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleBeadClick(p.index, e.shiftKey);
                    }}
                    onPointerDown={(e) => handleBeadPointerDown(p.index, e)}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    {selected && (
                      <rect
                        x={advancePx / 2 - stoneW / 2 - 1.5}
                        y={centerY - bailR - 3}
                        width={stoneW + 3}
                        height={bailR * 2.6 + stoneL + 6}
                        rx={4}
                        fill="#a855f7"
                        opacity={0.25}
                      />
                    )}
                    <circle
                      cx={advancePx / 2}
                      cy={centerY + bailR * 0.6}
                      r={bailR}
                      fill="none"
                      stroke="#9ca3af"
                      strokeWidth={Math.max(1, bailR * 0.35)}
                    />
                    <g
                      transform={`translate(${advancePx / 2 + stoneW / 2}, ${stoneTop}) rotate(90)`}
                    >
                      <Bead
                        visual={visual}
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
                  transform={`translate(${marginLeft + p.xMm * pxPerMm}, ${centerY - (widthMm * pxPerMm) / 2})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBeadClick(p.index, e.shiftKey);
                  }}
                  onPointerDown={(e) => handleBeadPointerDown(p.index, e)}
                  className="cursor-grab active:cursor-grabbing"
                >
                  {selected && (
                    <rect
                      x={-1.5}
                      y={-3}
                      width={p.lengthMm * pxPerMm + 3}
                      height={widthMm * pxPerMm + 6}
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
                        cx={(p.lengthMm * pxPerMm) / 2}
                        cy={(widthMm * pxPerMm) / 2}
                        rx={(p.lengthMm * pxPerMm) / 2}
                        ry={(widthMm * pxPerMm) / 2}
                        fill="#e5e7eb"
                        stroke="#9ca3af"
                        strokeDasharray="3 2"
                      />
                    </g>
                  )}
                </g>
              );
            })}

            {/* insertion caret */}
            <line
              x1={insertionX}
              y1={centerY - (maxWidthMm * pxPerMm) / 2 - 4}
              x2={insertionX}
              y2={centerY + (maxWidthMm * pxPerMm) / 2 + 4}
              stroke="#a855f7"
              strokeWidth={2}
            />

            {/* drop indicator while dragging */}
            {dropX !== null && (
              <line
                x1={dropX}
                y1={centerY - (maxWidthMm * pxPerMm) / 2 - 6}
                x2={dropX}
                y2={centerY + (maxWidthMm * pxPerMm) / 2 + 6}
                stroke="#16a34a"
                strokeWidth={2.5}
              />
            )}

            {/* ruler */}
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
          </svg>
        </div>

        {/* pattern actions + totals */}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <div className="flex items-center gap-1">
            <button
              onClick={() => repeatSelection(repeatCount)}
              disabled={!range}
              className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Repeat the selected beads"
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
              className="w-14 px-2 py-1.5 border border-gray-300 rounded-md"
            />
          </div>
          <button
            onClick={fillToTarget}
            disabled={beads.length === 0}
            className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Repeat the selection (or whole strand) until the target length is reached"
          >
            <ArrowRightToLine className="w-4 h-4 mr-1" />
            Fill to target
          </button>
          <button
            onClick={deleteSelection}
            disabled={!range}
            className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4 mr-1" />
            Remove
          </button>
          <button
            onClick={clearAll}
            disabled={beads.length === 0}
            className="flex items-center px-3 py-1.5 bg-white border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Eraser className="w-4 h-4 mr-1" />
            Clear
          </button>

          <div className="ml-auto flex items-center gap-4 text-gray-700">
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

        <p className="mt-2 text-sm text-gray-500">
          {beads.length === 0 ? (
            <>
              Click a bead in the palette to start the strand. Click a placed
              bead to select it (shift-click for a range), then Repeat or Fill
              to build a pattern.
            </>
          ) : (
            <>
              Drag beads to rearrange · click between beads or use arrow keys to
              move the insertion point (Shift+arrows select, Esc clears) ·
              Backspace removes the last-placed bead.
            </>
          )}
        </p>
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
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search materials…"
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
          >
            <option value="">All types</option>
            {[...PLACEABLE_CATEGORIES].map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <BeadFilters
            familyFilter={familyFilter}
            sizeFilter={sizeFilter}
            onFamilyChange={setFamilyFilter}
            onSizeChange={setSizeFilter}
          />
        </div>
        {palette.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            Nothing to place yet — import a receipt or add materials from the
            Inventory page.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {palette.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2 hover:border-purple-400 group"
              >
                <button
                  onClick={() => addBead(m.id)}
                  className="flex items-center gap-3 flex-1 text-left min-w-0"
                  title="Add to strand"
                >
                  <span className="w-9 flex justify-center shrink-0">
                    <BeadSwatch visual={m.visual} size={32} seed={m.id} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm text-gray-900 leading-snug">
                      {m.name}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {m.quantity} in stock · ${m.unit_cost.toFixed(3)}/ea
                      {m.visual?.shape === "chain" && (
                        <span className="text-purple-600"> · adds 1&quot; per click</span>
                      )}
                    </span>
                  </span>
                  <Plus className="w-4 h-4 text-purple-500 opacity-0 group-hover:opacity-100 shrink-0" />
                </button>
                <PhotoVisualButton
                  material={m}
                  onUpdated={onMaterialsChanged}
                  onError={setError}
                />
                <button
                  onClick={() => regenerateVisual(m)}
                  disabled={regeneratingId === m.id}
                  className="p-1 text-gray-300 hover:text-purple-600 shrink-0"
                  title="Regenerate artwork"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${regeneratingId === m.id ? "animate-spin text-purple-600" : ""}`}
                  />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
