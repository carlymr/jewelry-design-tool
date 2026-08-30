"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Upload,
  Download,
  Database,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Check,
  X,
  Info,
  ExternalLink,
} from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import BeadFilters from "@/components/BeadFilters";
import SearchField from "@/components/SearchField";
import PhotoVisualButton from "@/components/PhotoVisualButton";
import { addMaterials, deleteMaterial, updateMaterial } from "@/lib/materials";
import { listOrders, receiptUrl } from "@/lib/orders";
import { generateVisualForName } from "@/lib/visuals";
import {
  colorFamilyOf,
  sizeBucketOf,
  DRILL_TYPES,
  DRILL_LABELS,
  CAB_OUTLINES,
  CAB_OUTLINE_LABELS,
  hasOutline,
  type DrillType,
  type CabOutline,
} from "@/lib/bead-visual";
import {
  CATEGORIES,
  presentCategories,
  type Material,
  type NewMaterial,
  type Order,
} from "@/lib/types";

type SortKey = "name" | "category" | "unit_cost" | "quantity";

const PAGE_SIZE = 25;

const EMPTY_FORM: NewMaterial = {
  name: "",
  category: "Beads",
  unit_cost: 0,
  quantity: 0,
  unit_type: "piece",
  supplier: "",
};

// Numeric fields stay raw text while editing — binding a parsed number back to
// the input eats in-progress entries like "0." before the decimals are typed.
interface EditDraft {
  name: string;
  category: string;
  unit_cost: string;
  unit_type: string;
  quantity: string;
  /** Cabochons only; "" = not recorded. */
  drill: DrillType | "";
  /** Cabochons and bezel settings; "" = not recorded (drawn as oval). */
  outline: CabOutline | "";
}

interface Props {
  materials: Material[];
  loading: boolean;
  onChanged: () => Promise<void>;
}

export default function InventoryTable({ materials, loading, onChanged }: Props) {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [familyFilter, setFamilyFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [page, setPage] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<NewMaterial>(EMPTY_FORM);
  const [edit, setEdit] = useState<{ material: Material; form: EditDraft } | null>(null);
  const [regenVisual, setRegenVisual] = useState(false);
  const regenTouched = useRef(false);
  const drillTouched = useRef(false);
  const outlineTouched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);
  // Provenance: which row's source panel is open, and the orders to show in it.
  const [sourceOpenId, setSourceOpenId] = useState<string | null>(null);
  const [orders, setOrders] = useState<Map<string, Order>>(new Map());
  // Orders only change when materials start pointing at new ones, so key the
  // fetch off the set of referenced order ids — not every stock edit.
  const orderIdsKey = useMemo(
    () => Array.from(new Set(materials.map((m) => m.order_id).filter(Boolean))).sort().join(","),
    [materials]
  );
  useEffect(() => {
    let stale = false;
    listOrders()
      .then((rows) => {
        if (!stale) setOrders(new Map(rows.map((o) => [o.id, o])));
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [orderIdsKey]);

  const openReceipt = async (path: string, page: number | null) => {
    try {
      window.open(await receiptUrl(path, page), "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open receipt");
    }
  };

  // Only offer types the inventory actually holds, so no choice comes back empty.
  const categoryOptions = useMemo(() => presentCategories(materials), [materials]);

  const sorted = useMemo(() => {
    const term = searchTerm.toLowerCase();
    const filtered = materials
      .filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.category.toLowerCase().includes(term) ||
          m.supplier.toLowerCase().includes(term)
      )
      .filter((m) => !categoryFilter || m.category === categoryFilter)
      .filter((m) => !familyFilter || colorFamilyOf(m.visual) === familyFilter)
      .filter((m) => !sizeFilter || sizeBucketOf(m.visual) === sizeFilter);
    return [...filtered].sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [materials, searchTerm, categoryFilter, familyFilter, sizeFilter, sortBy, sortOrder]);

  useEffect(() => {
    setPage(0);
  }, [searchTerm, categoryFilter, familyFilter, sizeFilter]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(key);
      setSortOrder("asc");
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortBy === key ? (sortOrder === "asc" ? " ↑" : " ↓") : "";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = () =>
    run(async () => {
      if (!addForm.name.trim()) throw new Error("Material name is required");
      await addMaterials([{ ...addForm, name: addForm.name.trim() }]);
      setAddForm(EMPTY_FORM);
      setShowAddForm(false);
    });

  const handleStockChange = (id: string, value: string) => {
    const quantity = parseFloat(value);
    if (Number.isNaN(quantity) || quantity < 0) return;
    run(() => updateMaterial(id, { quantity }).then(() => undefined));
  };

  const handleDelete = (material: Material) => {
    if (!confirm(`Delete "${material.name}" from inventory?`)) return;
    run(() => deleteMaterial(material.id));
  };

  const startEdit = (material: Material) => {
    setEdit({
      material,
      form: {
        name: material.name,
        category: material.category,
        unit_cost: String(material.unit_cost),
        unit_type: material.unit_type,
        quantity: String(material.quantity),
        drill: material.visual?.drill ?? "",
        outline: material.visual?.outline ?? "",
      },
    });
    setRegenVisual(false);
    regenTouched.current = false;
    drillTouched.current = false;
    outlineTouched.current = false;
    setError("");
  };

  const setDraft = (patch: Partial<EditDraft>) =>
    setEdit((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  // A rename usually means the visual (derived from the name) is wrong too, so
  // renaming auto-checks the regenerate box — until the user toggles it herself.
  const handleEditName = (value: string) => {
    setDraft({ name: value });
    if (edit && !regenTouched.current) {
      setRegenVisual(value.trim() !== edit.material.name);
    }
  };

  const handleSaveEdit = () =>
    run(async () => {
      if (!edit) return;
      const name = edit.form.name.trim();
      if (!name) throw new Error("Material name is required");
      const unit_cost = parseFloat(edit.form.unit_cost);
      if (Number.isNaN(unit_cost) || unit_cost < 0) {
        throw new Error("Cost must be a non-negative number");
      }
      const quantity = parseFloat(edit.form.quantity);
      if (Number.isNaN(quantity) || quantity < 0) {
        throw new Error("Stock must be a non-negative number");
      }
      await updateMaterial(edit.material.id, {
        name,
        category: edit.form.category,
        unit_cost,
        unit_type: edit.form.unit_type.trim() || "piece",
        quantity,
      });
      const drill: DrillType | null = edit.form.drill || null;
      const outline: CabOutline | null = edit.form.outline || null;
      let regenError: string | null = null;
      let visualWritten = false;
      if (regenVisual) {
        try {
          const visual = await generateVisualForName(edit.material.id, name);
          if (visual) {
            // drill only belongs on cabochons and outline on cabochons and
            // bezels; a value the user actually set outranks the model's
            // guess, an untouched select doesn't.
            const next = {
              ...visual,
              drill:
                visual.shape !== "cabochon" ? null : drillTouched.current ? drill : visual.drill,
              outline: !hasOutline(visual)
                ? null
                : outlineTouched.current
                  ? outline
                  : visual.outline ?? null,
            };
            await updateMaterial(edit.material.id, { visual: next });
            visualWritten = true;
          }
        } catch (e) {
          regenError = e instanceof Error ? e.message : "unknown error";
        }
      }
      // A drill/outline change must land even if the regen failed or returned nothing.
      const prior = edit.material.visual;
      if (!visualWritten && prior) {
        const drillChanged = prior.shape === "cabochon" && drill !== (prior.drill ?? null);
        const outlineChanged = hasOutline(prior) && outline !== (prior.outline ?? null);
        if (drillChanged || outlineChanged) {
          await updateMaterial(edit.material.id, {
            visual: {
              ...prior,
              drill: drillChanged ? drill : prior.drill ?? null,
              outline: outlineChanged ? outline : prior.outline ?? null,
            },
          });
        }
      }
      setEdit(null);
      if (regenError) {
        throw new Error(`Changes saved, but the visual refresh failed: ${regenError}`);
      }
    });

  // Leading =, +, -, @ would execute as formulas if the export is opened in
  // Excel/Sheets; prefix with ' to neutralize (standard CSV-injection guard).
  const csvField = (s: string) => {
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  // CSV format kept compatible with the original tool's exports:
  // Name, Category, Cost Per Unit, Unit, In Stock
  const downloadCSV = () => {
    if (materials.length === 0) return;
    const rows = [
      ["Name", "Category", "Cost Per Unit", "Unit", "In Stock"].join(","),
      ...materials.map((m) =>
        [
          csvField(m.name),
          csvField(m.category),
          m.unit_cost,
          csvField(m.unit_type),
          m.quantity,
        ].join(",")
      ),
    ];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "jewelry-materials.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const uploadCSV = (file: File) =>
    run(async () => {
      const text = await file.text();
      const lines = text.split("\n").filter((line) => line.trim());
      if (lines.length < 2) {
        throw new Error("CSV must have a header row and at least one data row");
      }
      const newMaterials: NewMaterial[] = [];
      for (const line of lines.slice(1)) {
        const values = parseCSVLine(line);
        if (values.length < 3 || !values[0]) continue;
        newMaterials.push({
          name: values[0],
          category: values[1] || "Other",
          unit_cost: parseFloat(values[2]) || 0,
          unit_type: values[3] || "piece",
          quantity: parseFloat(values[4]) || 0,
          supplier: "",
        });
      }
      if (newMaterials.length === 0) {
        throw new Error("No valid rows found in the CSV");
      }
      await addMaterials(newMaterials);
    });

  return (
    <div className="bg-gray-50 p-3 sm:p-6 rounded-lg">
      <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
        <h2 className="text-xl font-semibold">Materials Inventory</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={downloadCSV}
            disabled={materials.length === 0 || busy}
            className="flex items-center px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
            aria-label="Export CSV"
            title="Export CSV"
          >
            <Download className="w-4 h-4 sm:mr-1" />
            <span className="hidden sm:inline">Export CSV</span>
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={busy}
            className="flex items-center px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
            aria-label="Import CSV"
            title="Import CSV"
          >
            <Upload className="w-4 h-4 sm:mr-1" />
            <span className="hidden sm:inline">Import CSV</span>
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadCSV(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
            aria-label="Add material"
            title="Add material"
          >
            <Plus className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Add Material</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {showAddForm && (
        <div className="mb-4 p-4 bg-white border border-purple-200 rounded-lg grid grid-cols-1 md:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder="Material name"
            value={addForm.name}
            onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
            className="md:col-span-2 px-3 py-2 border border-gray-300 rounded-md text-sm"
            autoFocus
          />
          <select
            value={addForm.category}
            onChange={(e) => setAddForm({ ...addForm, category: e.target.value })}
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="Cost per unit"
            value={addForm.unit_cost || ""}
            onChange={(e) =>
              setAddForm({ ...addForm, unit_cost: parseFloat(e.target.value) || 0 })
            }
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <input
            type="number"
            step="1"
            min="0"
            placeholder="In stock"
            value={addForm.quantity || ""}
            onChange={(e) =>
              setAddForm({ ...addForm, quantity: parseFloat(e.target.value) || 0 })
            }
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <button
            onClick={handleAdd}
            disabled={busy}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 text-sm"
          >
            {busy ? "Saving..." : "Save"}
          </button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <SearchField value={searchTerm} onChange={setSearchTerm} className="flex-1 min-w-56" />
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

      <div className="bg-gray-100 border-b-2 border-gray-200 p-3 rounded-t-lg hidden md:grid grid-cols-12 gap-3 text-sm font-medium text-gray-700">
        <button
          className="col-span-4 text-left cursor-pointer hover:text-purple-600"
          onClick={() => toggleSort("name")}
        >
          Material Name{sortIndicator("name")}
        </button>
        <button
          className="col-span-2 text-left cursor-pointer hover:text-purple-600"
          onClick={() => toggleSort("category")}
        >
          Category{sortIndicator("category")}
        </button>
        <button
          className="col-span-1 text-left cursor-pointer hover:text-purple-600"
          onClick={() => toggleSort("unit_cost")}
        >
          Cost / Unit{sortIndicator("unit_cost")}
        </button>
        <div className="col-span-1">Unit</div>
        <button
          className="col-span-2 text-left cursor-pointer hover:text-purple-600"
          onClick={() => toggleSort("quantity")}
        >
          In Stock{sortIndicator("quantity")}
        </button>
        <div className="col-span-2 text-center">Actions</div>
      </div>

      <div className="md:hidden mb-2 flex items-center gap-2 text-xs text-gray-600">
        <label htmlFor="inventory-sort">Sort by</label>
        <select
          id="inventory-sort"
          value={`${sortBy}:${sortOrder}`}
          onChange={(e) => {
            const [key, order] = e.target.value.split(":") as [SortKey, "asc" | "desc"];
            setSortBy(key);
            setSortOrder(order);
          }}
          className="px-2 py-1 border border-gray-300 rounded bg-white"
        >
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="category:asc">Category A–Z</option>
          <option value="category:desc">Category Z–A</option>
          <option value="unit_cost:asc">Cost ↑</option>
          <option value="unit_cost:desc">Cost ↓</option>
          <option value="quantity:asc">Stock ↑</option>
          <option value="quantity:desc">Stock ↓</option>
        </select>
      </div>

      <div className="bg-white border md:border-t-0 rounded-lg md:rounded-t-none">
        {paged.map((material) =>
          edit?.material.id === material.id ? (
            <div
              key={material.id}
              className="p-3 border-b border-purple-200 bg-purple-50/50 last:border-b-0"
              onKeyDown={(e) => {
                if (busy) return;
                if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) {
                  handleSaveEdit();
                } else if (e.key === "Escape") {
                  setEdit(null);
                }
              }}
            >
              <div className="grid grid-cols-12 gap-x-3 gap-y-2 items-center">
                <div className="col-span-12 md:col-span-4 flex items-center gap-2 min-w-0">
                  <span className="w-6 flex justify-center shrink-0">
                    {material.visual && (
                      <BeadSwatch visual={material.visual} size={22} seed={material.id} />
                    )}
                  </span>
                  <input
                    type="text"
                    value={edit.form.name}
                    onChange={(e) => handleEditName(e.target.value)}
                    disabled={busy}
                    aria-label="Material name"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-purple-500 focus:border-purple-500 disabled:bg-gray-100"
                    autoFocus
                  />
                </div>
                <div className="col-span-6 md:col-span-2">
                  <select
                    value={edit.form.category}
                    onChange={(e) => setDraft({ category: e.target.value })}
                    disabled={busy}
                    aria-label="Category"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-6 md:col-span-1">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={edit.form.unit_cost}
                    onChange={(e) => setDraft({ unit_cost: e.target.value })}
                    disabled={busy}
                    aria-label="Cost per unit"
                    placeholder="Cost"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100"
                  />
                </div>
                <div className="col-span-4 md:col-span-1">
                  <input
                    type="text"
                    value={edit.form.unit_type}
                    onChange={(e) => setDraft({ unit_type: e.target.value })}
                    disabled={busy}
                    aria-label="Unit"
                    placeholder="Unit"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100"
                  />
                </div>
                <div className="col-span-4 md:col-span-2">
                  <input
                    type="number"
                    min="0"
                    value={edit.form.quantity}
                    onChange={(e) => setDraft({ quantity: e.target.value })}
                    disabled={busy}
                    aria-label="In stock"
                    placeholder="Stock"
                    className="w-full px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100"
                  />
                </div>
                <div className="col-span-4 md:col-span-2 flex justify-end md:justify-center items-center gap-1">
                  <button
                    onClick={handleSaveEdit}
                    disabled={busy}
                    className="text-green-600 hover:text-green-700 hover:bg-green-50 p-2 md:p-1 rounded disabled:opacity-40"
                    title="Save changes"
                    aria-label="Save changes"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEdit(null)}
                    disabled={busy}
                    className="text-gray-500 hover:text-gray-700 hover:bg-gray-100 p-2 md:p-1 rounded disabled:opacity-40"
                    title="Cancel"
                    aria-label="Cancel edit"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <label
                className="mt-2 ml-8 inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer"
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
                {busy && <span className="text-purple-600 font-medium">— Saving…</span>}
              </label>
              {edit.material.visual?.shape === "cabochon" && (
                <label className="mt-2 ml-4 inline-flex items-center gap-1.5 text-xs text-gray-600">
                  Drill
                  <select
                    value={edit.form.drill}
                    onChange={(e) => {
                      drillTouched.current = true;
                      setDraft({ drill: e.target.value as DrillType | "" });
                    }}
                    disabled={busy}
                    aria-label="Drill type"
                    className="px-2 py-1 text-xs border border-gray-300 rounded disabled:bg-gray-100"
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
              {hasOutline(edit.material.visual) && (
                <label className="mt-2 ml-4 inline-flex items-center gap-1.5 text-xs text-gray-600">
                  Shape
                  <select
                    value={edit.form.outline}
                    onChange={(e) => {
                      outlineTouched.current = true;
                      setDraft({ outline: e.target.value as CabOutline | "" });
                    }}
                    disabled={busy}
                    aria-label={edit.material.visual?.shape === "bezel" ? "Recess shape" : "Face shape"}
                    className="px-2 py-1 text-xs border border-gray-300 rounded disabled:bg-gray-100"
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
          ) : (
            <div
              key={material.id}
              className="grid grid-cols-12 gap-x-3 gap-y-1 p-3 border-b border-gray-100 hover:bg-gray-50 last:border-b-0 items-center"
            >
              <div className="col-span-12 md:col-span-4 text-sm text-gray-900 flex items-center gap-2 min-w-0">
                <span className="w-6 flex justify-center shrink-0">
                  {material.visual && (
                    <BeadSwatch visual={material.visual} size={22} seed={material.id} />
                  )}
                </span>
                <span className="min-w-0 wrap-break-word leading-snug">{material.name}</span>
              </div>
              <div className="col-span-4 md:col-span-2 text-xs md:text-sm text-gray-600">
                {material.category}
              </div>
              <div className="col-span-4 md:col-span-1 text-xs md:text-sm text-gray-900">
                ${material.unit_cost.toFixed(2)}
                <span className="md:hidden text-gray-500">/{material.unit_type}</span>
              </div>
              <div className="hidden md:block col-span-1 text-sm text-gray-600">
                {material.unit_type}
              </div>
              <div className="col-span-4 md:col-span-2 flex items-center gap-1">
                <span className="md:hidden text-xs text-gray-500">Stock</span>
                <input
                  // Remount when quantity changes elsewhere (row editing) — an
                  // uncontrolled input would otherwise show, and write back, a
                  // stale defaultValue on the next blur.
                  key={material.quantity}
                  type="number"
                  min="0"
                  defaultValue={material.quantity}
                  onBlur={(e) => {
                    if (parseFloat(e.target.value) !== material.quantity) {
                      handleStockChange(material.id, e.target.value);
                    }
                  }}
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:ring-purple-500 focus:border-purple-500"
                />
              </div>
              <div className="col-span-12 md:col-span-2 flex justify-end md:justify-center items-center gap-1">
                {(material.source || material.order_id) && (
                  <button
                    onClick={() =>
                      setSourceOpenId(sourceOpenId === material.id ? null : material.id)
                    }
                    className={`p-2 md:p-1 rounded hover:text-purple-600 ${
                      sourceOpenId === material.id ? "text-purple-600" : "text-gray-500"
                    }`}
                    title="Where this came from"
                    aria-label="Show source"
                    aria-expanded={sourceOpenId === material.id}
                  >
                    <Info className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => startEdit(material)}
                  disabled={busy || edit !== null}
                  className="text-gray-500 hover:text-purple-600 p-2 md:p-1 rounded disabled:opacity-40 disabled:hover:text-gray-500"
                  title="Edit material"
                  aria-label="Edit material"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <PhotoVisualButton
                  material={material}
                  onUpdated={onChanged}
                  onError={setError}
                  className="text-gray-500 hover:text-purple-600 p-2 md:p-1 rounded"
                />
                <span aria-hidden className="w-px h-4 bg-gray-200" />
                <button
                  onClick={() => handleDelete(material)}
                  disabled={busy}
                  className="text-red-500 hover:text-red-700 hover:bg-red-50 p-2 md:p-1 rounded"
                  title="Delete material"
                  aria-label="Delete material"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {sourceOpenId === material.id && (
                <SourcePanel
                  material={material}
                  order={material.order_id ? orders.get(material.order_id) : undefined}
                  onOpenReceipt={openReceipt}
                />
              )}
            </div>
          )
        )}

        {!loading && sorted.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <Database className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="mb-2">
              {materials.length === 0
                ? "No materials in inventory yet."
                : "No materials match your search."}
            </p>
            <p className="text-sm">
              Add materials manually, import from a receipt below, or upload a CSV.
            </p>
            <p className="text-xs mt-2 text-gray-400">
              CSV format: Name, Category, Cost Per Unit, Unit, In Stock
            </p>
          </div>
        )}

        {loading && (
          <div className="text-center py-8 text-gray-500">Loading inventory…</div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
        <span>
          Showing{" "}
          {sorted.length === 0
            ? 0
            : `${safePage * PAGE_SIZE + 1}–${Math.min(
                (safePage + 1) * PAGE_SIZE,
                sorted.length
              )}`}{" "}
          of {sorted.length} materials
          {sorted.length !== materials.length && ` (${materials.length} total)`}
        </span>
        {pageCount > 1 && (
          <span className="flex items-center gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="p-1.5 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Previous page"
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            Page {safePage + 1} of {pageCount}
            <button
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
              disabled={safePage >= pageCount - 1}
              className="p-1.5 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function SourcePanel({
  material,
  order,
  onOpenReceipt,
}: {
  material: Material;
  order: Order | undefined;
  onOpenReceipt: (path: string, page: number | null) => void;
}) {
  const src = material.source;
  return (
    <div className="col-span-12 mt-1 text-xs text-gray-600 bg-purple-50/60 border border-purple-100 rounded-md px-3 py-2 space-y-1">
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
              onClick={() => onOpenReceipt(order.receipt_path!, src?.page ?? null)}
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
