"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Design, Material } from "@/lib/types";
import { GENERIC_CATALOG, isGeneric } from "@/lib/generic-catalog";
import { isLot } from "@/lib/lots";
import {
  genericsForIdentify,
  inventoryForIdentify,
  lotsForIdentify,
} from "@/lib/identify";
import {
  createImportedDesign,
  identifyPhotos,
  isResolvable,
  planFromResult,
  resolveMaterials,
  type ResolvedMap,
  type ReviewMaterial,
  type ReviewPlan,
} from "@/lib/piece-import";

// The photo import (GRA-12): photos and an optional description in, a
// reviewed plan out, and a design created from it. The plan is the owner's to
// correct before anything is written.

interface Props {
  materials: Material[];
  onClose: () => void;
  onImported: (design: Design, notice: string | null) => void;
}

const PHOTO_TIPS =
  "One flat photo of the whole strand with a ruler in the same plane works best. Close-ups are optional and help with small or similar beads.";

export default function PieceImport({ materials, onClose, onImported }: Props) {
  const [step, setStep] = useState<"capture" | "review">("capture");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [lengthText, setLengthText] = useState("");
  // Materials created for the current plan, kept across a failed save so a
  // retry reuses them. Cleared whenever a new identification replaces the plan.
  const resolved = useRef<ResolvedMap>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog on each step, and Escape closes it when no
  // save or identification is running.
  useEffect(() => {
    panelRef.current?.focus();
  }, [step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // Object URLs are made in the effect, not during render, so strict mode's
  // mount-unmount-mount doesn't revoke URLs that are still on screen.
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const lots = useMemo(() => materials.filter((m) => isLot(m)), [materials]);
  const byId = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const genericByKey = useMemo(
    () => new Map(GENERIC_CATALOG.map((e) => [e.key, e])),
    []
  );

  const identify = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await identifyPhotos(
        files,
        description.trim() || null,
        inventoryForIdentify(materials),
        lotsForIdentify(materials),
        genericsForIdentify()
      );
      const next = planFromResult(result, description.trim() || null);
      resolved.current.clear();
      setPlan(next);
      setLengthText(String(next.lengthIn));
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not identify the piece.");
    } finally {
      setBusy(false);
    }
  };

  const updateMaterial = (ref: string, change: Partial<ReviewMaterial>) =>
    setPlan((p) =>
      p && {
        ...p,
        materials: p.materials.map((m) => (m.ref === ref ? { ...m, ...change } : m)),
      }
    );

  // Swatch colour for a material, from its visual or its catalog entry.
  const colorFor = (m: ReviewMaterial): string | undefined => {
    if (m.matchId) return byId.get(m.matchId)?.visual?.color;
    if (m.genericKey) return genericByKey.get(m.genericKey)?.visual.color;
    return m.visual?.color;
  };

  const activeMaterials = plan?.materials.filter((m) => !m.removed) ?? [];
  const unresolved = activeMaterials.filter((m) => !isResolvable(m));
  const lengthIn = parseFloat(lengthText);
  const lengthOk = Number.isFinite(lengthIn) && lengthIn > 0 && lengthIn < 100;
  const canCreate = !!plan && unresolved.length === 0 && lengthOk && !busy;

  const assignAllNewToLot = (lotId: string) => {
    if (!plan || !lotId) return;
    setPlan({
      ...plan,
      materials: plan.materials.map((m) =>
        !m.matchId && !m.genericKey && m.visual && !m.removed ? { ...m, lotId } : m
      ),
    });
  };

  const create = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const nextPlan = { ...plan, lengthIn };
      await resolveMaterials(nextPlan, lots, resolved.current);
      const { design, photoError, skipped } = await createImportedDesign(
        nextPlan,
        resolved.current,
        files
      );
      const notes = [
        skipped > 0 ? `${skipped} strand element${skipped === 1 ? "" : "s"} left out` : null,
        photoError ? `Design saved, but its photos failed: ${photoError}` : null,
      ].filter(Boolean);
      onImported(design, notes.length ? notes.join(". ") : null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not create the design.";
      setError(
        resolved.current.size > 0
          ? `${message} Materials already created are kept. Press Create design to try again. Changing a material's choice creates a new one.`
          : `${message} Press Create design to try again.`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="piece-import-title"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-4xl max-h-[90vh] overflow-auto rounded-lg bg-white shadow-xl focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 id="piece-import-title" className="text-lg font-semibold text-gray-900">
            {step === "capture" ? "Create a design from a photo" : "Check the materials"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        {step === "capture" && (
          <div className="space-y-4 p-5">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">
                Describe the piece <span className="text-gray-500">(optional)</span>
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={300}
                placeholder="e.g. 18 inch necklace, 8mm black onyx rounds, gold spacers, a jasper pendant"
                className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </label>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Photos
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []).slice(0, 4);
                    setFiles(picked);
                    e.target.value = "";
                  }}
                  className="mt-1 block text-sm"
                />
              </label>
              <p className="mt-1 text-xs text-gray-500">{PHOTO_TIPS}</p>
              {previews.length > 0 && (
                <div className="mt-2 flex gap-2 overflow-x-auto">
                  {previews.map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={src} src={src} alt="" className="h-24 w-24 rounded object-cover" />
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex justify-end">
              <div className="flex flex-col items-end">
                <button
                  type="button"
                  onClick={identify}
                  disabled={files.length === 0 || busy}
                  className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {busy ? "Identifying…" : "Identify materials"}
                </button>
                {busy && (
                  <p role="status" className="mt-2 text-right text-xs text-gray-600">
                    Identifying your photos. This can take up to a minute.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {step === "review" && plan && (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm text-gray-700">
                Length (inches)
                <input
                  type="number"
                  step="0.25"
                  value={lengthText}
                  onChange={(e) => setLengthText(e.target.value)}
                  className={`ml-2 w-24 rounded-md border px-2 py-1 ${
                    lengthOk ? "border-gray-300" : "border-red-400"
                  }`}
                />
              </label>
              {lots.length > 0 && (
                <label className="text-sm text-gray-700">
                  Take new beads from lot
                  <select
                    value=""
                    onChange={(e) => assignAllNewToLot(e.target.value)}
                    className="ml-2 rounded-md border border-gray-300 px-2 py-1"
                  >
                    <option value="">Choose a lot…</option>
                    {lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="flex gap-4">
              {files.length > 0 && (
                <div className="shrink-0 space-y-2">
                  {previews.map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={src} src={src} alt="" className="h-28 w-28 rounded object-cover" />
                  ))}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="mb-2 text-sm font-medium text-gray-700">
                  Strand, {plan.strand.length} elements
                  {plan.materials.some((m) => m.removed) &&
                    ` (${plan.materials.filter((m) => m.removed).length} material${
                      plan.materials.filter((m) => m.removed).length === 1 ? "" : "s"
                    } removed)`}
                </p>
                <ol className="flex flex-wrap gap-1.5">
                  {plan.strand.map((ref, i) => {
                    const m = plan.materials.find((x) => x.ref === ref);
                    return (
                      <li
                        key={`${ref}-${i}`}
                        title={m?.name ?? ref}
                        aria-label={`Element ${i + 1}: ${m?.name ?? ref}${m?.removed ? ", removed" : ""}`}
                        className={`flex items-center gap-1 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700 ${
                          m?.removed ? "line-through opacity-40" : ""
                        }`}
                      >
                        <span
                          className="inline-block h-3 w-3 rounded-full border border-gray-300"
                          style={{ backgroundColor: (m && colorFor(m)) || "#d1d5db" }}
                        />
                        {i + 1}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700">Materials</p>
              {plan.materials.map((m) => (
                <MaterialRow
                  key={m.ref}
                  material={m}
                  color={colorFor(m)}
                  matchName={m.matchId ? byId.get(m.matchId)?.name : undefined}
                  genericName={m.genericKey ? genericByKey.get(m.genericKey)?.name : undefined}
                  lots={lots}
                  inventory={materials.filter((x) => !isLot(x) && !isGeneric(x))}
                  onChange={(change) => updateMaterial(m.ref, change)}
                />
              ))}
            </div>

            {unresolved.length > 0 && (
              <p className="text-sm text-amber-800">
                {unresolved.length} material{unresolved.length === 1 ? "" : "s"} still need a pick
                from your inventory before the design can be created.
              </p>
            )}
            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => setStep("capture")}
                disabled={busy}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={create}
                disabled={!canCreate}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create design"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MaterialRow({
  material: m,
  color,
  matchName,
  genericName,
  lots,
  inventory,
  onChange,
}: {
  material: ReviewMaterial;
  color: string | undefined;
  matchName: string | undefined;
  genericName: string | undefined;
  lots: Material[];
  inventory: Material[];
  onChange: (change: Partial<ReviewMaterial>) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return inventory.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, inventory]);

  const choose = (id: string) => {
    onChange({ matchId: id, lotId: null, genericKey: null });
    setPicking(false);
    setQuery("");
  };

  if (m.removed) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-gray-300 p-3 text-sm text-gray-500">
        <span className="min-w-0 flex-1 line-through">{m.name}</span>
        <span>Removed from the strand</span>
        <button
          type="button"
          onClick={() => onChange({ removed: false })}
          className="text-xs text-gray-800 underline"
        >
          Restore
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-gray-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-block h-4 w-4 shrink-0 rounded-full border border-gray-300"
          style={{ backgroundColor: color || "#d1d5db" }}
        />
        <input
          value={m.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 rounded-md border border-gray-300 px-2 py-1 text-sm"
          aria-label="Material name"
        />
        <span className="text-xs text-gray-500">{m.kind}</span>
        {m.confidence === "low" && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
            check this
          </span>
        )}
        <button
          type="button"
          onClick={() => onChange({ removed: true })}
          className="text-xs text-gray-600 hover:text-red-700"
        >
          Remove from strand
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-700">
        {m.matchId && (
          <>
            <span>Using your {matchName ?? "material"}</span>
            <button
              type="button"
              onClick={() => onChange({ matchId: null, visual: m.visual })}
              disabled={!m.visual}
              className="text-xs text-gray-600 underline disabled:opacity-40"
              title={m.visual ? "Create this as a new material instead" : "No visual to create from"}
            >
              Create new instead
            </button>
          </>
        )}
        {m.genericKey && <span>Catalog finding: {genericName ?? m.genericKey}</span>}
        {!m.matchId && !m.genericKey && m.visual && (
          <>
            <span>New material</span>
            {lots.length > 0 && (
              <select
                value={m.lotId ?? ""}
                onChange={(e) => onChange({ lotId: e.target.value || null })}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                aria-label="Take from lot"
              >
                <option value="">Not from a lot</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    From {l.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {!m.matchId && !m.genericKey && !m.visual && (
          <span className="text-amber-800">No match and no visual yet</span>
        )}

        {!m.genericKey && (
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            className="text-xs text-gray-700 underline"
          >
            {picking ? "Close" : m.matchId ? "Change match" : "Use an existing material"}
          </button>
        )}
      </div>

      {picking && (
        <div className="mt-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your inventory"
            autoFocus
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
          {query.trim() && (
            <ul className="mt-1 divide-y divide-gray-100 rounded-md border border-gray-200">
              {results.length === 0 && (
                <li className="px-2 py-1 text-xs text-gray-500">No matches</li>
              )}
              {results.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => choose(x.id)}
                    className="w-full px-2 py-1 text-left text-sm hover:bg-gray-50"
                  >
                    {x.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
