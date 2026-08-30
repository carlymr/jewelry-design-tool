"use client";

import { Search, X } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** Search box with a magnifier and an × that clears it — shared by the
 * palette and the inventory table so both behave identically. */
export default function SearchField({ value, onChange, placeholder, className = "" }: Props) {
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
      <input
        type="text"
        placeholder={placeholder ?? "Search materials…"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pl-10 pr-8 py-2 border border-gray-300 rounded-md text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1 rounded"
          aria-label="Clear search"
          title="Clear search"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
