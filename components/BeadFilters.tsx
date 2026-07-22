"use client";

import { COLOR_FAMILIES, SIZE_BUCKETS } from "@/lib/bead-visual";

interface Props {
  familyFilter: string;
  sizeFilter: string;
  onFamilyChange: (value: string) => void;
  onSizeChange: (value: string) => void;
}

/** Color-family and size filter dropdowns, shared by the palette and inventory. */
export default function BeadFilters({
  familyFilter,
  sizeFilter,
  onFamilyChange,
  onSizeChange,
}: Props) {
  return (
    <>
      <select
        value={familyFilter}
        onChange={(e) => onFamilyChange(e.target.value)}
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
        onChange={(e) => onSizeChange(e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
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
