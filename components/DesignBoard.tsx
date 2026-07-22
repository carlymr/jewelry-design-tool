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
import { apiHeaders } from "@/lib/api-token";
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
// Working-copy draft persisted to localStorage so navigation, reloads, and
// tab closes can't lose unsaved strand work.
const DRAFT_KEY = "design-board-draft";

interface Props {
  materials: Material[];
  onMaterialsChanged: () => Promise<void>;
}

const beadLengthMm = (m: Material | undefined) =>
  m?.visual?.length_mm ?? FALLBACK_BEAD_MM;
const beadWidthMm = (m: Material | undefined) =>
  m?.visual?.width_mm ?? FALLBACK_BEAD_MM;

export default function DesignBoard({ materials, onMaterialsChanged }: Props) {
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
  const [paletteSearch, setPaletteSearch] = useState("");
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
      const raw = localStorage.getItem(DRAFT_KEY);
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
        localStorage.removeItem(DRAFT_KEY);
      } else {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ currentId, name, targetMm, beads })
        );
      }
    } catch {
      // Quota/private-mode failures just lose the safety net, nothing else.
    }
  }, [dirty, currentId, name, targetMm, beads]);

  // --- load designs ---
  useEffect(() => {
    listDesigns()
      .then(setDesigns)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load designs"));
  }, []);

  // --- lazy visual generation for beads that never came through a receipt ---
  useEffect(() => {
    const missing = materials.filter(
      (m) => m.category === "Beads" && !m.visual && !attemptedVisuals.current.has(m.id)
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
            headers: apiHeaders(),
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
        headers: apiHeaders(),
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
      .filter((m) => m.category === "Beads" || m.visual)
      .filter((m) => m.name.toLowerCase().includes(term))
      .filter((m) => !familyFilter || colorFamilyOf(m.visual) === familyFilter)
      .filter((m) => !sizeFilter || sizeBucketOf(m.visual) === sizeFilter)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [materials, paletteSearch, familyFilter, sizeFilter]);

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

  const handleBeadClick = (index: number, shiftKey: boolean) => {
    if (shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: index });
    } else {
      setSelection({ anchor: index, focus: index });
    }
    setInsertion(index + 1);
  };

  const handleBoardClick = () => {
    setSelection(null);
    setInsertion(beads.length);
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
  const rulerHeight = 34;
  const marginLeft = 24;
  const boardMm = Math.max(targetMm, strand.totalMm) + 30;
  const fitPx = Math.min(12, Math.max(0.8, (containerW - marginLeft - 24) / boardMm));
  const pxPerMm = zoomMode === "fit" ? fitPx : customPx;
  const strandHeight = maxWidthMm * pxPerMm + 16;
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

  return (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
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
      }}
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
            width={boardWidth}
            height={strandHeight + rulerHeight}
            onClick={handleBoardClick}
            className="block cursor-default"
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
              return (
                <g
                  key={p.index}
                  transform={`translate(${marginLeft + p.xMm * pxPerMm}, ${centerY - (widthMm * pxPerMm) / 2})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBeadClick(p.index, e.shiftKey);
                  }}
                  className="cursor-pointer"
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

        {beads.length === 0 && (
          <p className="mt-2 text-sm text-gray-500">
            Click a bead in the palette to start the strand. Click a placed bead to
            select it (shift-click for a range), then Repeat or Fill to build a
            pattern. Backspace removes the last-placed bead.
          </p>
        )}
      </div>

      {/* Palette */}
      <div className="bg-gray-50 p-4 rounded-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Bead Palette</h2>
          {generating && (
            <span className="text-sm text-purple-600 flex items-center gap-1">
              <RefreshCw className="w-4 h-4 animate-spin" />
              Generating bead artwork…
            </span>
          )}
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search beads…"
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <BeadFilters
            familyFilter={familyFilter}
            sizeFilter={sizeFilter}
            onFamilyChange={setFamilyFilter}
            onSizeChange={setSizeFilter}
          />
        </div>
        {palette.length === 0 ? (
          <p className="text-sm text-gray-500 py-4 text-center">
            No beads in inventory yet — import a receipt or add materials from the
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
                    </span>
                  </span>
                  <Plus className="w-4 h-4 text-purple-500 opacity-0 group-hover:opacity-100 shrink-0" />
                </button>
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
