"use client";

import { useCallback, useEffect, useState } from "react";
import InventoryTable from "@/components/InventoryTable";
import ReceiptImport from "@/components/ReceiptImport";
import { listMaterials } from "@/lib/materials";
import type { Material } from "@/lib/types";

export default function Home() {
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
    <main className="max-w-6xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Jewelry Design Tool</h1>
        <p className="text-gray-600">
          Materials inventory with AI-powered receipt import
        </p>
      </div>

      {loadError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{loadError}</p>
        </div>
      )}

      <div className="space-y-6">
        <InventoryTable
          materials={materials}
          loading={loading}
          onChanged={refresh}
        />
        <ReceiptImport onImported={refresh} />
      </div>
    </main>
  );
}
