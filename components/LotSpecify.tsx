"use client";

import { useRef, useState } from "react";
import { PackagePlus, X } from "lucide-react";
import { specifyFromLot, updateMaterial } from "@/lib/materials";
import { generateVisualForName } from "@/lib/visuals";
import { lotAllocation, lotPrice, toCents } from "@/lib/lots";
import { CATEGORIES, PLACEABLE_CATEGORIES, type Material } from "@/lib/types";

// Lots (GRA-36). A lot row is a bag of unsorted stock; this file holds the
// two surfaces that turn it into inventory: the panel that shows what has
// been specified out of it so far (inventory row expansion and the detail
// modal), and the modal that specifies one more material from it.

const money = (n: number) => `$${n.toFixed(2)}`;

/** What a lot cost, how much of that its specified items have claimed, and
 * the items themselves. */
export function LotPanel({
  lot,
  items,
  onSpecify,
}: {
  lot: Material;
  /** Rows with `lot_id === lot.id` (any extra rows are ignored). */
  items: Material[];
  /** Offered as a button when the surface can open the specify modal. */
  onSpecify?: () => void;
}) {
  const alloc = lotAllocation(lot, items);
  const own = items.filter((m) => m.lot_id === lot.id);
  return (
    <div className="text-xs text-gray-600 bg-teal-50/60 border border-teal-100 rounded-md px-3 py-2 space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-medium text-gray-800">
          Lot · {Number(lot.quantity)} {lot.unit_type} for {money(alloc.price)}
        </span>
        <span>
          · {money(alloc.allocated)} allocated to {own.length} material{own.length === 1 ? "" : "s"}
        </span>
        <span className={alloc.over ? "text-red-600 font-medium" : ""}>
          · {alloc.over ? `over-allocated by ${money(alloc.allocated - alloc.price)}` : `${money(alloc.remaining)} unallocated`}
        </span>
        {onSpecify && (
          <button
            onClick={onSpecify}
            className="ml-auto inline-flex items-center gap-1 text-teal-700 hover:underline"
          >
            <PackagePlus className="w-3 h-3" /> Specify a material
          </button>
        )}
      </div>
      {own.length > 0 && (
        <ul className="text-gray-700 space-y-0.5">
          {own.map((m) => (
            <li key={m.id} className="flex justify-between gap-2">
              <span className="min-w-0 truncate">
                {m.name}
                <span className="text-gray-500">
                  {" "}
                  · {Number(m.quantity)} {m.unit_type}
                </span>
              </span>
              <span className="shrink-0">{money(Number(m.lot_cost ?? 0))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const fieldClass =
  "w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-purple-500 focus:border-purple-500 disabled:bg-gray-100";

interface Draft {
  name: string;
  category: string;
  quantity: string;
  unit_type: string;
  /** How much of the lot, in the lot's own unit, this material took. */
  share: string;
  /** The slice of the lot's price, in dollars. */
  cost: string;
}

interface Props {
  lot: Material;
  /** The lot's already-specified rows, for the running allocation. */
  items: Material[];
  onClose: () => void;
  /** After each successful save (the modal may stay open for another). */
  onCreated: () => Promise<void>;
  /** Post-save warnings (a failed visual) go to the parent's banner. */
  onError: (message: string) => void;
}

/** Specify one material out of a lot: what it is, how many, and what slice
 * of the lot's price it takes. The slice defaults to a proportional share
 * when the lot was sold in the same unit (10 of 400 pieces → 10/400 of the
 * price); for a weight lot the owner enters the weight the pieces account
 * for, or the dollars directly. Nothing forces the lot to be fully
 * allocated — most of a mixed bag never is. */
export default function LotSpecifyModal({ lot, items, onClose, onCreated, onError }: Props) {
  const emptyDraft = (): Draft => ({
    name: "",
    category: PLACEABLE_CATEGORIES.has(lot.category) ? lot.category : "Beads",
    quantity: "1",
    unit_type: "piece",
    share: "",
    cost: "",
  });
  const [form, setForm] = useState<Draft>(emptyDraft);
  const [withVisual, setWithVisual] = useState(true);
  // "Touched" means the owner typed a value that's still there: clearing a
  // field hands it back to the derivation.
  const shareTouched = useRef(false);
  const costTouched = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState(0);

  const unitCost = Number(lot.unit_cost);
  const alloc = lotAllocation(lot, items);
  const unitsMatch = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const sameUnit = unitsMatch(lot.unit_type, form.unit_type);
  const quantity = parseFloat(form.quantity);
  const cost = parseFloat(form.cost);
  const perUnit = quantity > 0 && cost >= 0 ? cost / quantity : NaN;

  const setDraft = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));

  // Share → cost is the derivation; a cost the owner typed wins over it, and
  // an emptied share empties the derived cost rather than leaving a stale one.
  const setShare = (share: string) => {
    const n = parseFloat(share);
    setDraft({
      share,
      ...(costTouched.current ? {} : { cost: Number.isNaN(n) ? "" : toCents(n * unitCost).toFixed(2) }),
    });
  };
  const handleShare = (value: string) => {
    shareTouched.current = value.trim() !== "";
    setShare(value);
  };
  const handleCost = (value: string) => {
    costTouched.current = value.trim() !== "";
    setDraft({ cost: value });
  };
  const handleQuantity = (value: string) => {
    setDraft({ quantity: value });
    if (sameUnit && !shareTouched.current) setShare(value);
  };
  const handleUnit = (value: string) => {
    setDraft({ unit_type: value });
    // Entering or leaving the lot's unit re-derives (or clears) the share.
    if (!shareTouched.current) setShare(unitsMatch(lot.unit_type, value) ? form.quantity : "");
  };

  const save = async (another: boolean) => {
    setBusy(true);
    setError("");
    try {
      const name = form.name.trim();
      if (!name) throw new Error("Material name is required");
      if (Number.isNaN(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive number");
      }
      if (Number.isNaN(cost) || cost < 0) {
        throw new Error("Enter the cost this material takes from the lot (0 is fine)");
      }
      const row = await specifyFromLot(lot, {
        name,
        category: form.category,
        quantity,
        unit_type: form.unit_type.trim() || "piece",
        lot_cost: cost,
      });
      let visualError: string | null = null;
      if (withVisual) {
        try {
          const visual = await generateVisualForName(row.id, name);
          if (visual) await updateMaterial(row.id, { visual });
        } catch (e) {
          visualError = e instanceof Error ? e.message : "unknown error";
        }
      }
      await onCreated();
      if (visualError) onError(`Added ${name}, but the visual failed: ${visualError}`);
      if (another) {
        setAdded((n) => n + 1);
        shareTouched.current = false;
        costTouched.current = false;
        setForm(emptyDraft());
        setBusy(false);
        nameRef.current?.focus();
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the material");
      setBusy(false);
    }
  };

  // Lots sold as "1 lot" have no meaningful share unit; only the dollars apply.
  const showShare = lot.unit_type.trim().toLowerCase() !== "lot";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Specify a material from ${lot.name}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (busy) return;
        if (e.key === "Escape") onClose();
        else if (
          e.key === "Enter" &&
          !(e.target instanceof HTMLSelectElement) &&
          !(e.target instanceof HTMLButtonElement)
        ) {
          save(false);
        }
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-base font-semibold text-gray-900 leading-snug">
            Specify a material from this lot
          </h2>
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
        <p className="text-xs text-gray-600 mb-3">
          {lot.name} · {Number(lot.quantity)} {lot.unit_type} for {money(lotPrice(lot))} ·{" "}
          {money(alloc.remaining)} still unallocated
          {added > 0 && ` · ${added} added so far`}
        </p>

        <div className="space-y-3">
          <label className="block text-xs text-gray-600">
            Name
            <input
              type="text"
              value={form.name}
              onChange={(e) => setDraft({ name: e.target.value })}
              placeholder="Picture Jasper Beads 8mm Round"
              disabled={busy}
              className={`${fieldClass} mt-1`}
              ref={nameRef}
              autoFocus
            />
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
            <span className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-gray-600">
                Quantity
                <input
                  type="number"
                  min="0"
                  value={form.quantity}
                  onChange={(e) => handleQuantity(e.target.value)}
                  disabled={busy}
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="block text-xs text-gray-600">
                Unit
                <input
                  type="text"
                  value={form.unit_type}
                  onChange={(e) => handleUnit(e.target.value)}
                  disabled={busy}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            </span>
            {showShare && (
              <label className="block text-xs text-gray-600">
                Share of lot ({lot.unit_type})
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.share}
                  onChange={(e) => handleShare(e.target.value)}
                  placeholder={sameUnit ? form.quantity : "e.g. 43"}
                  disabled={busy}
                  className={`${fieldClass} mt-1`}
                />
              </label>
            )}
            <label className="block text-xs text-gray-600">
              Cost from the lot ($)
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.cost}
                onChange={(e) => handleCost(e.target.value)}
                disabled={busy}
                className={`${fieldClass} mt-1`}
              />
            </label>
          </div>
          {showShare && (
            <p className="text-xs text-gray-500 -mt-1">
              The lot is priced at {money(unitCost)} per {lot.unit_type}.{" "}
              {sameUnit
                ? "The share follows the quantity, and the cost follows the share, until you type over them."
                : `Enter the ${lot.unit_type} these pieces account for and the cost fills in — or type the cost directly.`}
            </p>
          )}
          <p className="text-xs text-gray-500">
            {Number.isNaN(perUnit)
              ? "Cost per unit follows from the cost and quantity."
              : `${money(perUnit)} per ${form.unit_type.trim() || "piece"}`}
            {!Number.isNaN(cost) && cost > alloc.remaining + 0.005 && (
              <span className="text-amber-700">
                {" "}
                — more than the {money(alloc.remaining)} left unallocated
              </span>
            )}
          </p>
          <label
            className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer"
            title="Draws the swatch from the name so it can go on the board right away"
          >
            <input
              type="checkbox"
              checked={withVisual}
              disabled={busy}
              onChange={(e) => setWithVisual(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            Generate visual from name
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={busy}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              {added > 0 ? "Done" : "Cancel"}
            </button>
            <button
              onClick={() => save(true)}
              disabled={busy}
              className="px-4 py-2 text-sm border border-purple-300 text-purple-700 rounded-lg hover:bg-purple-50 disabled:opacity-40"
              title="Save this one and keep the form open for the next"
            >
              Save &amp; add another
            </button>
            <button
              onClick={() => save(false)}
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
