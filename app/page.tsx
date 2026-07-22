"use client";

import DesignBoard from "@/components/DesignBoard";
import { useMaterials } from "@/lib/useMaterials";

export default function DesignPage() {
  const { materials, loading, loadError, refresh } = useMaterials();

  return (
    <main className="max-w-screen-2xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Design Board</h1>
        <p className="text-gray-600">
          Lay out a strand from your inventory before stringing
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
        <DesignBoard materials={materials} onMaterialsChanged={refresh} />
      )}
    </main>
  );
}
