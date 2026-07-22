"use client";

import InventoryTable from "@/components/InventoryTable";
import ReceiptImport from "@/components/ReceiptImport";
import { useMaterials } from "@/lib/useMaterials";

export default function InventoryPage() {
  const { materials, loading, loadError, refresh } = useMaterials();

  return (
    <main className="max-w-6xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Inventory</h1>
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
        <ReceiptImport onImported={refresh} />
        <InventoryTable
          materials={materials}
          loading={loading}
          onChanged={refresh}
        />
      </div>
    </main>
  );
}
