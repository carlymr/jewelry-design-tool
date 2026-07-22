"use client";

import { useCallback, useEffect, useState } from "react";
import DesignBoard from "@/components/DesignBoard";
import { listMaterials } from "@/lib/materials";
import type { Material } from "@/lib/types";

export default function DesignPage() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setLoadError("");
      setMaterials(await listMaterials());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load materials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
