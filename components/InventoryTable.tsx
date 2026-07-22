"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Upload,
  Download,
  Database,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import { addMaterials, deleteMaterial, updateMaterial } from "@/lib/materials";
import {
  COLOR_FAMILIES,
  SIZE_BUCKETS,
  colorFamilyOf,
  sizeBucketOf,
} from "@/lib/bead-visual";
import { CATEGORIES, type Material, type NewMaterial } from "@/lib/types";

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

interface Props {
  materials: Material[];
  loading: boolean;
  onChanged: () => Promise<void>;
}

export default function InventoryTable({ materials, loading, onChanged }: Props) {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("name");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [familyFilter, setFamilyFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [page, setPage] = useState(0);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<NewMaterial>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const csvInputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => {
    const term = searchTerm.toLowerCase();
    const filtered = materials
      .filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.category.toLowerCase().includes(term) ||
          m.supplier.toLowerCase().includes(term)
      )
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
  }, [materials, searchTerm, familyFilter, sizeFilter, sortBy, sortOrder]);

  useEffect(() => {
    setPage(0);
  }, [searchTerm, familyFilter, sizeFilter]);

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

  // CSV format kept compatible with the original tool's exports:
  // Name, Category, Cost Per Unit, Unit, In Stock
  const downloadCSV = () => {
    if (materials.length === 0) return;
    const rows = [
      ["Name", "Category", "Cost Per Unit", "Unit", "In Stock"].join(","),
      ...materials.map((m) =>
        [
          `"${m.name.replace(/"/g, '""')}"`,
          `"${m.category.replace(/"/g, '""')}"`,
          m.unit_cost,
          `"${m.unit_type.replace(/"/g, '""')}"`,
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
    <div className="bg-gray-50 p-6 rounded-lg">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Materials Inventory</h2>
        <div className="flex space-x-2">
          <button
            onClick={downloadCSV}
            disabled={materials.length === 0 || busy}
            className="flex items-center px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
          >
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={busy}
            className="flex items-center px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
          >
            <Upload className="w-4 h-4 mr-1" />
            Import CSV
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
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Material
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
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search materials..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md"
          />
        </div>
        <select
          value={familyFilter}
          onChange={(e) => setFamilyFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          <option value="">All colors</option>
          {COLOR_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f[0].toUpperCase() + f.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={sizeFilter}
          onChange={(e) => setSizeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
        >
          <option value="">All sizes</option>
          {SIZE_BUCKETS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-gray-100 border-b-2 border-gray-200 p-3 rounded-t-lg grid grid-cols-12 gap-3 text-sm font-medium text-gray-700">
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
          className="col-span-2 text-left cursor-pointer hover:text-purple-600"
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
        <div className="col-span-1 text-center">Actions</div>
      </div>

      <div className="bg-white border border-t-0 rounded-b-lg">
        {paged.map((material) => (
          <div
            key={material.id}
            className="grid grid-cols-12 gap-3 p-3 border-b border-gray-100 hover:bg-gray-50 last:border-b-0 items-center"
          >
            <div className="col-span-4 text-sm text-gray-900 flex items-center gap-2 min-w-0">
              <span className="w-6 flex justify-center shrink-0">
                {material.visual && (
                  <BeadSwatch visual={material.visual} size={22} seed={material.id} />
                )}
              </span>
              <span className="min-w-0 wrap-break-word leading-snug">{material.name}</span>
            </div>
            <div className="col-span-2 text-sm text-gray-600">{material.category}</div>
            <div className="col-span-2 text-sm text-gray-900">
              ${material.unit_cost.toFixed(2)}
            </div>
            <div className="col-span-1 text-sm text-gray-600">{material.unit_type}</div>
            <div className="col-span-2">
              <input
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
            <div className="col-span-1 flex justify-center">
              <button
                onClick={() => handleDelete(material)}
                disabled={busy}
                className="text-red-500 hover:text-red-700 hover:bg-red-50 p-1 rounded"
                title="Delete material"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

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
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            Page {safePage + 1} of {pageCount}
            <button
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
              disabled={safePage >= pageCount - 1}
              className="p-1.5 border border-gray-300 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
