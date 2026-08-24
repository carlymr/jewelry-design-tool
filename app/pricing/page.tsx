"use client";

import PricingStudio from "@/components/PricingStudio";
import { useMaterials } from "@/lib/useMaterials";

export default function PricingPage() {
  const { materials, loading, loadError } = useMaterials();

  return (
    <main className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          Pricing &amp; Listing
        </h1>
        <p className="text-gray-600">
          Price a saved design from its actual materials and generate an Etsy
          listing
        </p>
      </div>

      {loadError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{loadError}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading inventory…</div>
      ) : (
        <PricingStudio materials={materials} />
      )}
    </main>
  );
}
