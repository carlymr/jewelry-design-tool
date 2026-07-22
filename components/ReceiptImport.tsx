"use client";

import { useRef, useState } from "react";
import { Upload, Eye, Trash2 } from "lucide-react";
import { addMaterials } from "@/lib/materials";
import type { ExtractedItem } from "@/lib/types";

// Vercel serverless functions cap request bodies at ~4.5MB, so we keep the
// base64 payload under 4MB: oversized images get downscaled client-side,
// oversized PDFs are rejected.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

interface Props {
  onImported: () => Promise<void>;
}

async function downscaleImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const maxDim = 2000;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image compression failed"))),
      "image/jpeg",
      0.85
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });
}

export default function ReceiptImport({ onImported }: Props) {
  const [processing, setProcessing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [notes, setNotes] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processReceipt = async (file: File) => {
    setProcessing(true);
    setError("");
    setItems([]);
    setNotes(null);

    try {
      let blob: Blob = file;
      let mediaType = file.type;

      if (file.type === "application/pdf") {
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(
            "PDF is too large (max 3MB). Try exporting a smaller PDF or a photo of the receipt."
          );
        }
      } else if (file.type.startsWith("image/")) {
        if (file.size > MAX_UPLOAD_BYTES) {
          blob = await downscaleImage(file);
          mediaType = "image/jpeg";
        }
      } else {
        throw new Error("Upload an image (PNG, JPG, WebP) or PDF.");
      }

      const data = await blobToBase64(blob);
      const response = await fetch("/api/process-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, mediaType }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `Request failed (${response.status})`);
      }

      setItems(result.items ?? []);
      setNotes(result.notes ?? null);
      if ((result.items ?? []).length === 0 && !result.notes) {
        setNotes("No jewelry materials were found on this receipt.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process receipt");
    } finally {
      setProcessing(false);
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, fields: Partial<ExtractedItem>) => {
    setItems(items.map((item, i) => (i === index ? { ...item, ...fields } : item)));
  };

  const importItems = async () => {
    setImporting(true);
    setError("");
    try {
      await addMaterials(
        items.map((item) => ({
          name: item.name,
          category: item.category,
          unit_cost: item.unit_cost,
          quantity: item.estimated_units,
          unit_type: item.unit_type,
          supplier: "",
        }))
      );
      await onImported();
      setItems([]);
      setNotes(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to import materials");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="bg-gray-50 p-6 rounded-lg">
      <h2 className="text-xl font-semibold mb-4">Import Materials from Receipt</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-lg font-medium mb-3">Upload Receipt</h3>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
            <Upload className="mx-auto h-12 w-12 text-gray-400" />
            <p className="mt-4 text-sm font-medium text-gray-900">
              Upload a receipt image or PDF
            </p>
            <p className="mt-1 text-sm text-gray-500">
              PNG, JPG, WebP, or PDF — large photos are compressed automatically
            </p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,.pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) processReceipt(file);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={processing}
              className="mt-4 inline-flex items-center px-4 py-2 text-sm font-medium rounded-md shadow-sm text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {processing ? "Processing…" : "Choose File"}
            </button>
          </div>

          {error && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}
        </div>

        <div>
          <h3 className="text-lg font-medium mb-3">Extracted Materials</h3>
          <div className="border border-gray-300 rounded-lg p-4 bg-white min-h-64">
            {items.length > 0 ? (
              <div className="space-y-3">
                {items.map((item, index) => (
                  <div
                    key={index}
                    className="border border-gray-200 rounded-lg p-3 text-sm"
                  >
                    <div className="flex justify-between items-start">
                      <div className="font-medium text-gray-900">{item.name}</div>
                      <button
                        onClick={() => removeItem(index)}
                        className="text-red-500 hover:text-red-700 p-1"
                        title="Remove from import"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="text-gray-500 mt-1">
                      {item.category} • {item.quantity_purchased} • $
                      {item.total_price.toFixed(2)} total
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-gray-700">
                      <label className="text-xs text-gray-500">Units:</label>
                      <input
                        type="number"
                        min="0"
                        value={item.estimated_units}
                        onChange={(e) => {
                          const units = parseFloat(e.target.value) || 0;
                          updateItem(index, {
                            estimated_units: units,
                            unit_cost: units > 0 ? item.total_price / units : 0,
                          });
                        }}
                        className="w-20 px-2 py-1 border border-gray-300 rounded"
                      />
                      <span className="text-xs text-gray-500">
                        {item.unit_type} @ ${item.unit_cost.toFixed(4)}/unit
                      </span>
                    </div>
                  </div>
                ))}

                {notes && <p className="text-xs text-gray-500 italic">{notes}</p>}

                <button
                  onClick={importItems}
                  disabled={importing || items.length === 0}
                  className="w-full py-2 px-4 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {importing
                    ? "Importing…"
                    : `Import ${items.length} Material${items.length === 1 ? "" : "s"} to Inventory`}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full min-h-56 text-gray-500">
                <div className="text-center">
                  <Eye className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>{notes ?? "Extracted materials will appear here after processing"}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
