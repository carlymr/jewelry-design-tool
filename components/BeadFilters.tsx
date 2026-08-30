"use client";

import { COLOR_FAMILIES, SIZE_BUCKETS } from "@/lib/bead-visual";

interface Props {
  familyFilter: string;
  sizeFilter: string;
  onFamilyChange: (value: string) => void;
  onSizeChange: (value: string) => void;
  /** Categories to offer in the type dropdown; omit to hide it. */
  categories?: string[];
  categoryFilter?: string;
  onCategoryChange?: (value: string) => void;
}

/** Type, color-family and size filter dropdowns, shared by the palette and
 * inventory. The type list is passed in because each surface offers a
 * different slice of the inventory. */
export default function BeadFilters({
  familyFilter,
  sizeFilter,
  onFamilyChange,
  onSizeChange,
  categories,
  categoryFilter = "",
  onCategoryChange,
}: Props) {
  const selectClass =
    "px-3 py-2 border border-gray-300 rounded-md text-sm bg-white";
  return (
    <>
      {categories && onCategoryChange && (
        <select
          value={categoryFilter}
          onChange={(e) => onCategoryChange(e.target.value)}
          className={selectClass}
          aria-label="Filter by type"
        >
          <option value="">All types</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      )}
      <select
        value={familyFilter}
        onChange={(e) => onFamilyChange(e.target.value)}
        className={selectClass}
        aria-label="Filter by color"
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
        onChange={(e) => onSizeChange(e.target.value)}
        className={selectClass}
        aria-label="Filter by size"
      >
        <option value="">All sizes</option>
        {SIZE_BUCKETS.map((b) => (
          <option key={b.key} value={b.key}>
            {b.label}
          </option>
        ))}
      </select>
    </>
  );
}
