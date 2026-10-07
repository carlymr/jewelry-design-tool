"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ExternalLink, X } from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import PhotoVisualButton from "@/components/PhotoVisualButton";
import { updateMaterial } from "@/lib/materials";
import { getOrder, receiptUrl } from "@/lib/orders";
import { generateVisualForName } from "@/lib/visuals";
import {
  DRILL_TYPES,
  DRILL_LABELS,
  CAB_OUTLINES,
  CAB_OUTLINE_LABELS,
  fmtMm,
  formatSizeMm,
  hasOutline,
  type DrillType,
  type CabOutline,
} from "@/lib/bead-visual";
import { isGeneric } from "@/lib/generic-catalog";
import { CATEGORIES, type Material, type Order } from "@/lib/types";

// The one place a material's details are viewed and edited — opened from the
// inventory table's pencil and the palette's details button, so the two
// surfaces can't drift apart (GRA-35).

/** Where a material came from: order header, listing line, receipt link.
 * Rendered inside the detail modal and as the inventory table's inline peek. */
export function SourcePanel({
  material,
  order,
  onError,
}: {
  material: Material;
  order: Order | undefined;
  onError: (message: string) => void;
}) {
  const src = material.source;

  const openReceipt = async (path: string, page: number | null) => {
    try {
      window.open(await receiptUrl(path, page), "_blank", "noopener");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not open receipt");
    }
  };

  return (
    <div className="text-xs text-gray-600 bg-purple-50/60 border border-purple-100 rounded-md px-3 py-2 space-y-1">
      {order && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium text-gray-800">
            {order.platform}
            {order.seller ? ` · ${order.seller}` : ""}
          </span>
          <span>order {order.order_number}</span>
          {order.order_date && <span>· {order.order_date}</span>}
          {order.total != null && <span>· ${Number(order.total).toFixed(2)} total</span>}
          {order.receipt_path && (
            <button
              onClick={() => openReceipt(order.receipt_path!, src?.page ?? null)}
              className="inline-flex items-center gap-1 text-purple-700 hover:underline"
            >
              <ExternalLink className="w-3 h-3" /> View receipt
              {src?.page ? ` (p. ${src.page})` : ""}
            </button>
          )}
        </div>
      )}
      {src && (
        <>
          <div className="text-gray-700">{src.listing_title}</div>
          {src.variation && <div className="font-mono text-gray-800">{src.variation}</div>}
          <div>${src.line_price.toFixed(2)} paid for this line</div>
        </>
      )}
    </div>
  );
}

// Numeric fields stay raw text while editing — binding a parsed number back to
// the input eats in-progress entries like "0." before the decimals are typed.
interface Draft {
  name: string;
  category: string;
  unit_cost: string;
  unit_type: string;
  quantity: string;
  /** Cabochons only; "" = not recorded. */
  drill: DrillType | "";
  /** Cabochons and bezel settings; "" = not recorded (drawn as oval). */
  outline: CabOutline | "";
  /** Size in mm (GRA-46): along the stringing hole and across it. Raw text
   * like the other numeric fields; "" when the row has no visual yet. */
  length_mm: string;
  width_mm: string;
}

/** A stored mm value as input text — same trimming as the caption above it. */
const mmText = (n: number | undefined) => (n == null ? "" : fmtMm(n));

/** Field labels for the two axes, by what the shape stores in them. */
function sizeLabels(shape: string | undefined): { length: string; width: string } {
  switch (shape) {
    case "cabochon":
      return { length: "Length (mm)", width: "Width (mm)" };
    case "bezel":
      return { length: "Recess length (mm)", width: "Recess width (mm)" };
    case "chain":
      return { length: "Per element (mm)", width: "Link width (mm)" };
    default:
      return { length: "Along strand (mm)", width: "Across (mm)" };
  }
}

interface Props {
  material: Material;
  onClose: () => void;
  onChanged: () => Promise<void>;
  /** Post-save warnings (e.g. a failed visual refresh) go to the parent's
   * error banner, since the modal is gone by then. */
  onError: (message: string) => void;
}

const fieldClass =
  "w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-purple-500 focus:border-purple-500 disabled:bg-gray-100";

export default function MaterialDetailModal({ material, onClose, onChanged, onError }: Props) {
  const [form, setForm] = useState<Draft>({
    name: material.name,
    category: material.category,
    unit_cost: String(material.unit_cost),
    unit_type: material.unit_type,
    quantity: String(material.quantity),
    drill: material.visual?.drill ?? "",
    outline: material.visual?.outline ?? "",
    length_mm: mmText(material.visual?.length_mm),
    width_mm: mmText(material.visual?.width_mm),
  });
  const [regenVisual, setRegenVisual] = useState(false);
  const regenTouched = useRef(false);
  const drillTouched = useRef(false);
  const outlineTouched = useRef(false);
  const sizeTouched = useRef(false);
  const shape = material.visual?.shape;
  // A chain element is always a 1-inch segment — the strand's stock counting
  // depends on it — so only the link width is editable.
  const fixedLength = shape === "chain";
  const labels = sizeLabels(shape);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generic = isGeneric(material);

  // Provenance: the modal fetches its own order so either surface can open it
  // without carrying an orders map around.
  const [order, setOrder] = useState<Order | undefined>(undefined);
  useEffect(() => {
    if (!material.order_id) return;
    let stale = false;
    getOrder(material.order_id)
      .then((o) => {
        if (!stale && o) setOrder(o);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [material.order_id]);

  const setDraft = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));

  // A rename usually means the visual (derived from the name) is wrong too, so
  // renaming auto-checks the regenerate box — until the user toggles it herself.
  const handleName = (value: string) => {
    setDraft({ name: value });
    if (!regenTouched.current) setRegenVisual(value.trim() !== material.name);
  };

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      const name = form.name.trim();
      if (!name) throw new Error("Material name is required");
      const unit_cost = parseFloat(form.unit_cost);
      if (Number.isNaN(unit_cost) || unit_cost < 0) {
        throw new Error("Cost must be a non-negative number");
      }
      // Generics carry no stock: leave their placeholder quantity alone.
      const quantity = generic ? null : parseFloat(form.quantity);
      if (quantity !== null && (Number.isNaN(quantity) || quantity < 0)) {
        throw new Error("Stock must be a non-negative number");
      }
      // Size (GRA-46): only validated when the owner edited it, so a row with
      // an odd stored value can still have its other fields saved. Checked
      // before anything is written so a rejected size leaves the row untouched.
      const prior = material.visual;
      let size: { length_mm: number; width_mm: number } | null = null;
      if (sizeTouched.current && prior) {
        const length_mm = fixedLength ? prior.length_mm : parseFloat(form.length_mm);
        const width_mm = parseFloat(form.width_mm);
        if (!(length_mm > 0) || !(width_mm > 0)) {
          throw new Error("Size must be a positive number of millimeters on both axes");
        }
        size = { length_mm, width_mm };
      }
      await updateMaterial(material.id, {
        name,
        category: form.category,
        unit_cost,
        unit_type: form.unit_type.trim() || "piece",
        ...(quantity === null ? {} : { quantity }),
      });
      const drill: DrillType | null = form.drill || null;
      const outline: CabOutline | null = form.outline || null;
      let regenError: string | null = null;
      let visualWritten = false;
      if (regenVisual) {
        try {
          const visual = await generateVisualForName(material.id, name);
          if (visual) {
            // drill only belongs on cabochons and outline on cabochons and
            // bezels; a value the user actually set outranks the model's
            // guess, an untouched select doesn't. Same for a typed size, but
            // only if the shape didn't change — the numbers were entered
            // against the old shape's axes (and a chain's fixed 25.4 must not
            // follow it onto a bead).
            const next = {
              ...visual,
              ...(size && prior && visual.shape === prior.shape ? size : {}),
              drill:
                visual.shape !== "cabochon" ? null : drillTouched.current ? drill : visual.drill,
              outline: !hasOutline(visual)
                ? null
                : outlineTouched.current
                  ? outline
                  : visual.outline ?? null,
            };
            await updateMaterial(material.id, { visual: next });
            visualWritten = true;
          }
        } catch (e) {
          regenError = e instanceof Error ? e.message : "unknown error";
        }
      }
      // A drill/outline/size change must land even if the regen failed or returned nothing.
      if (!visualWritten && prior) {
        const drillChanged = prior.shape === "cabochon" && drill !== (prior.drill ?? null);
        const outlineChanged = hasOutline(prior) && outline !== (prior.outline ?? null);
        const sizeChanged =
          size !== null &&
          (size.length_mm !== prior.length_mm || size.width_mm !== prior.width_mm);
        if (drillChanged || outlineChanged || sizeChanged) {
          await updateMaterial(material.id, {
            visual: {
              ...prior,
              ...(sizeChanged && size ? size : {}),
              drill: drillChanged ? drill : prior.drill ?? null,
              outline: outlineChanged ? outline : prior.outline ?? null,
            },
          });
        }
      }
      await onChanged();
      onClose();
      if (regenError) {
        onError(`Changes saved, but the visual refresh failed: ${regenError}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${material.name}`}
      // Keys must not leak to the surface underneath (the board's bead
      // hotkeys especially), and the backdrop deliberately doesn't
      // click-to-close — a stray click shouldn't discard edits.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (busy) return;
        if (e.key === "Escape") onClose();
        else if (
          e.key === "Enter" &&
          !(e.target instanceof HTMLSelectElement) &&
          !(e.target instanceof HTMLButtonElement)
        ) {
          handleSave();
        }
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-12 flex justify-center shrink-0">
              <BeadSwatch visual={material.visual} size={44} seed={material.id} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900 leading-snug">
                {material.name}
              </h2>
              {material.visual && (
                <p className="text-xs text-gray-500">{formatSizeMm(material.visual)}</p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="p-1 text-gray-400 hover:text-gray-600 rounded shrink-0"
            title="Close"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-xs text-gray-600">
            Name
            <span className="mt-1 flex items-center gap-1">
              <input
                type="text"
                value={form.name}
                onChange={(e) => handleName(e.target.value)}
                disabled={busy}
                className={fieldClass}
                autoFocus
              />
              <PhotoVisualButton
                material={material}
                onUpdated={onChanged}
                onError={setError}
                className="p-2 text-gray-400 hover:text-purple-600 shrink-0"
              />
            </span>
          </label>
          <label
            className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer"
            title="Regenerates the swatch artwork from the corrected name"
          >
            <input
              type="checkbox"
              checked={regenVisual}
              disabled={busy}
              onChange={(e) => {
                regenTouched.current = true;
                setRegenVisual(e.target.checked);
              }}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            Refresh visual from name
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-gray-600">
              Category
              <select
                value={form.category}
                onChange={(e) => setDraft({ category: e.target.value })}
                disabled={busy}
                className={`${fieldClass} mt-1 bg-white`}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-gray-600">
              Cost per unit ($)
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.unit_cost}
                onChange={(e) => setDraft({ unit_cost: e.target.value })}
                disabled={busy}
                className={`${fieldClass} mt-1`}
              />
            </label>
            <label className="block text-xs text-gray-600">
              Unit
              <input
                type="text"
                value={form.unit_type}
                onChange={(e) => setDraft({ unit_type: e.target.value })}
                disabled={busy}
                className={`${fieldClass} mt-1`}
              />
            </label>
            {generic ? (
              <p className="text-xs text-gray-500 self-end pb-1.5">
                Generic finding — no stock tracked.
              </p>
            ) : (
              <label className="block text-xs text-gray-600">
                In stock
                <input
                  type="number"
                  min="0"
                  value={form.quantity}
                  onChange={(e) => setDraft({ quantity: e.target.value })}
                  disabled={busy}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            )}
            {material.visual && (
              <div className="col-span-2">
                <div className="flex items-end gap-2">
                  <label className="block text-xs text-gray-600 flex-1">
                    {labels.width}
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={form.width_mm}
                      onChange={(e) => {
                        sizeTouched.current = true;
                        setDraft({ width_mm: e.target.value });
                      }}
                      disabled={busy}
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      sizeTouched.current = true;
                      setDraft({ length_mm: form.width_mm, width_mm: form.length_mm });
                    }}
                    disabled={busy || fixedLength}
                    className="p-1.5 mb-0.5 text-gray-400 hover:text-purple-600 disabled:opacity-40 shrink-0"
                    title={`Swap ${labels.width.toLowerCase()} and ${labels.length.toLowerCase()}`}
                    aria-label={`Swap ${labels.width} and ${labels.length}`}
                  >
                    <ArrowLeftRight className="w-4 h-4" />
                  </button>
                  <label className="block text-xs text-gray-600 flex-1">
                    {labels.length}
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={form.length_mm}
                      onChange={(e) => {
                        sizeTouched.current = true;
                        setDraft({ length_mm: e.target.value });
                      }}
                      disabled={busy || fixedLength}
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  {fixedLength
                    ? "A placed chain element is always a 1-inch segment; only the link width is drawn."
                    : hasOutline(material.visual)
                      ? "Length is the long axis, which hangs vertically."
                      : "“Along strand” is the direction the string passes through. If the bead is drawn turned the wrong way, swap the two."}
                </p>
              </div>
            )}
            {material.visual?.shape === "cabochon" && (
              <label className="block text-xs text-gray-600">
                Drill
                <select
                  value={form.drill}
                  onChange={(e) => {
                    drillTouched.current = true;
                    setDraft({ drill: e.target.value as DrillType | "" });
                  }}
                  disabled={busy}
                  className={`${fieldClass} mt-1 bg-white`}
                >
                  <option value="">Not recorded</option>
                  {DRILL_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {DRILL_LABELS[d]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {hasOutline(material.visual) && (
              <label className="block text-xs text-gray-600">
                {material.visual?.shape === "bezel" ? "Recess shape" : "Face shape"}
                <select
                  value={form.outline}
                  onChange={(e) => {
                    outlineTouched.current = true;
                    setDraft({ outline: e.target.value as CabOutline | "" });
                  }}
                  disabled={busy}
                  className={`${fieldClass} mt-1 bg-white`}
                >
                  <option value="">Not recorded (oval)</option>
                  {CAB_OUTLINES.map((o) => (
                    <option key={o} value={o}>
                      {CAB_OUTLINE_LABELS[o]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {(material.source || material.order_id) && (
            <SourcePanel material={material} order={order} onError={setError} />
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy}
              className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
