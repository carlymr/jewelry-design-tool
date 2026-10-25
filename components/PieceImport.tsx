"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MaterialDetailModal from "@/components/MaterialDetail";
import type { Design, Material } from "@/lib/types";
import type { BeadVisual } from "@/lib/bead-visual";
import { GENERIC_CATALOG, isGeneric } from "@/lib/generic-catalog";
import { isLot } from "@/lib/lots";
import { genericsForIdentify, inventoryForIdentify, lotsForIdentify } from "@/lib/identify";
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

// The photo import (GRA-12): photos and an optional description in, a reviewed
// plan out, and a design created from it. The happy case is a piece whose
// materials are all in the inventory already, so matched materials are the
// main content and anything new is called out for the owner to decide.

interface Props {
  materials: Material[];
  onClose: () => void;
  onImported: (design: Design, notice: string | null) => void;
  onMaterialsChanged: () => Promise<void>;
}

const PHOTO_TIPS =
  "One flat photo of the whole strand with a ruler in the same plane works best. Close-ups are optional and help with small or similar beads.";

const sizeLabel = (v: BeadVisual | null | undefined) =>
  v ? `${v.length_mm} × ${v.width_mm} mm` : null;

export default function PieceImport({ materials, onClose, onImported, onMaterialsChanged }: Props) {
  const [step, setStep] = useState<"capture" | "review">("capture");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<ReviewPlan | null>(null);
  const [lengthText, setLengthText] = useState("");
  // The material whose detail view is open, by id so it re-reads after a save.
  const [viewingId, setViewingId] = useState<string | null>(null);
  // Materials created for the current plan, kept across a failed save so a
  // retry reuses them. Cleared whenever a new identification replaces the plan.
  const resolved = useRef<ResolvedMap>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog on each step. Escape closes it when no save or
  // identification is running and no detail view is open (that view handles
  // its own Escape).
  useEffect(() => {
    panelRef.current?.focus();
  }, [step]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy && !viewingId) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, viewingId, onClose]);

  // Object URLs are made in the effect, not during render, so strict mode's
  // mount-unmount-mount doesn't revoke URLs that are still on screen.
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const lots = useMemo(() => materials.filter((m) => isLot(m)), [materials]);
  const inventory = useMemo(
    () => materials.filter((m) => !isLot(m) && !isGeneric(m)),
    [materials]
  );
  const byId = useMemo(() => new Map(materials.map((m) => [m.id, m])), [materials]);
  const genericByKey = useMemo(() => new Map(GENERIC_CATALOG.map((e) => [e.key, e])), []);
  const viewing = viewingId ? byId.get(viewingId) ?? null : null;

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

  const lengthIn = parseFloat(lengthText);
  const lengthOk = Number.isFinite(lengthIn) && lengthIn > 0 && lengthIn < 100;

  // Matched and catalog materials are the happy path; everything else is new
  // and needs a decision before the design can be created.
  const existing = plan?.materials.filter((m) => m.matchId || m.genericKey) ?? [];
  const fresh = plan?.materials.filter((m) => !m.matchId && !m.genericKey) ?? [];
  const unresolved = (plan?.materials ?? []).filter((m) => !m.removed && !isResolvable(m));
  const canCreate = !!plan && unresolved.length === 0 && lengthOk && !busy;

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
          <div className="space-y-6 p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <p className="text-sm text-gray-700">
                {plan.strand.length} elements · {existing.length} from your inventory
                {fresh.length > 0 && (
                  <span className="font-medium text-amber-800"> · {fresh.length} new</span>
                )}
              </p>
              <label className="text-sm text-gray-700">
                Length (inches)
                <input
                  type="number"
                  step="0.25"
                  value={lengthText}
                  onChange={(e) => setLengthText(e.target.value)}
                  aria-invalid={!lengthOk}
                  className={`ml-2 w-24 rounded-md border px-2 py-1 ${
                    lengthOk ? "border-gray-300" : "border-red-400"
                  }`}
                />
              </label>
            </div>

            {fresh.length === 0 && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">
                Every material on this piece is already in your inventory.
              </p>
            )}

            {existing.length > 0 && (
              <section aria-labelledby="matched-heading" className="space-y-2">
                <h3 id="matched-heading" className="text-sm font-semibold text-gray-900">
                  From your inventory
                </h3>
                {existing.map((m) => (
                  <MatchedRow
                    key={m.ref}
                    material={m}
                    row={m.matchId ? byId.get(m.matchId) ?? null : null}
                    genericName={m.genericKey ? genericByKey.get(m.genericKey)?.name : undefined}
                    inventory={inventory}
                    onView={setViewingId}
                    onChange={(change) => updateMaterial(m.ref, change)}
                  />
                ))}
              </section>
            )}

            {fresh.length > 0 && (
              <section aria-labelledby="new-heading" className="space-y-2">
                <h3 id="new-heading" className="text-sm font-semibold text-amber-900">
                  Not in your inventory yet
                </h3>
                <p className="text-xs text-gray-600">
                  These are created when you confirm. Check each one, or pick the existing material it is.
                </p>
                {fresh.map((m) => (
                  <NewRow
                    key={m.ref}
                    material={m}
                    lots={lots}
                    lotRow={m.lotId ? byId.get(m.lotId) ?? null : null}
                    inventory={inventory}
                    onView={setViewingId}
                    onChange={(change) => updateMaterial(m.ref, change)}
                  />
                ))}
              </section>
            )}

            {unresolved.length > 0 && (
              <p className="text-sm text-amber-800">
                {unresolved.length} material{unresolved.length === 1 ? "" : "s"} need a pick from your
                inventory before the design can be created.
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

      {viewing && (
        <MaterialDetailModal
          material={viewing}
          onClose={() => setViewingId(null)}
          onChanged={onMaterialsChanged}
          onError={setError}
        />
      )}
    </div>
  );
}

function RemoveToggle({
  removed,
  onChange,
}: {
  removed: boolean;
  onChange: (change: Partial<ReviewMaterial>) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange({ removed: !removed })}
      className="text-xs text-gray-600 underline hover:text-gray-900"
    >
      {removed ? "Restore" : "Leave out of this design"}
    </button>
  );
}

/** A material the owner already has. Name, category and size are shown so the
 * match can be checked at a glance; "View details" opens the inventory row. */
function MatchedRow({
  material: m,
  row,
  genericName,
  inventory,
  onView,
  onChange,
}: {
  material: ReviewMaterial;
  row: Material | null;
  genericName: string | undefined;
  inventory: Material[];
  onView: (id: string) => void;
  onChange: (change: Partial<ReviewMaterial>) => void;
}) {
  const [picking, setPicking] = useState(false);
  const color = row?.visual?.color ?? "#d1d5db";
  const title = row?.name ?? genericName ?? m.name;
  const detail = row
    ? [row.category, sizeLabel(row.visual)].filter(Boolean).join(" · ")
    : "Catalog finding";

  return (
    <div
      className={`rounded-md border p-3 ${
        m.removed ? "border-dashed border-gray-300 opacity-60" : "border-gray-200"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-block h-5 w-5 shrink-0 rounded-full border border-gray-300"
          style={{ backgroundColor: color }}
        />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-medium text-gray-900 ${m.removed ? "line-through" : ""}`}>
            {title}
          </p>
          <p className="text-xs text-gray-500">{detail}</p>
        </div>
        {row && (
          <button
            type="button"
            onClick={() => onView(row.id)}
            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-800 hover:bg-gray-50"
          >
            View details
          </button>
        )}
        {!m.genericKey && (
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            className="text-xs text-gray-700 underline"
          >
            {picking ? "Close" : "Change"}
          </button>
        )}
        <RemoveToggle removed={m.removed} onChange={onChange} />
      </div>

      {picking && (
        <ExistingPicker
          inventory={inventory}
          onChoose={(id) => {
            onChange({ matchId: id, lotId: null, genericKey: null });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** A material the inventory doesn't have yet: created on confirm, unless the
 * owner picks an existing row or takes it from a lot. */
function NewRow({
  material: m,
  lots,
  lotRow,
  inventory,
  onView,
  onChange,
}: {
  material: ReviewMaterial;
  lots: Material[];
  lotRow: Material | null;
  inventory: Material[];
  onView: (id: string) => void;
  onChange: (change: Partial<ReviewMaterial>) => void;
}) {
  const [picking, setPicking] = useState(false);
  const color = m.visual?.color ?? "#d1d5db";

  return (
    <div
      className={`rounded-md border p-3 ${
        m.removed ? "border-dashed border-gray-300 opacity-60" : "border-amber-300 bg-amber-50/40"
      }`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="inline-block h-5 w-5 shrink-0 rounded-full border border-gray-300"
          style={{ backgroundColor: color }}
        />
        <input
          value={m.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          aria-label="Material name"
        />
        <span className="text-xs text-gray-600">
          {m.kind}
          {sizeLabel(m.visual) ? ` · ${sizeLabel(m.visual)}` : ""}
          {m.confidence === "low" ? " · check this" : ""}
        </span>
        <RemoveToggle removed={m.removed} onChange={onChange} />
      </div>

      {!m.removed && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-gray-700">
          {lots.length > 0 && (
            <select
              value={m.lotId ?? ""}
              onChange={(e) => onChange({ lotId: e.target.value || null })}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
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
          {lotRow && (
            <button
              type="button"
              onClick={() => onView(lotRow.id)}
              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-800 hover:bg-gray-50"
            >
              View lot
            </button>
          )}
          <button
            type="button"
            onClick={() => setPicking((p) => !p)}
            className="text-xs text-gray-700 underline"
          >
            {picking ? "Close" : "Use an existing material instead"}
          </button>
          {!m.visual && (
            <span className="text-amber-800">No visual yet: pick an existing material.</span>
          )}
        </div>
      )}

      {picking && (
        <ExistingPicker
          inventory={inventory}
          onChoose={(id) => {
            onChange({ matchId: id, lotId: null, genericKey: null });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

function ExistingPicker({
  inventory,
  onChoose,
}: {
  inventory: Material[];
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return inventory.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, inventory]);

  return (
    <div className="mt-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your inventory"
        aria-label="Search your inventory"
        autoFocus
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
      />
      {query.trim() && (
        <ul className="mt-1 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
          {results.length === 0 && <li className="px-2 py-1 text-xs text-gray-500">No matches</li>}
          {results.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => onChoose(x.id)}
                className="flex w-full items-center justify-between px-2 py-1 text-left text-sm hover:bg-gray-50"
              >
                <span>{x.name}</span>
                <span className="text-xs text-gray-500">{x.category}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
