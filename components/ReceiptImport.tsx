"use client";

import { CATEGORIES } from "@/lib/types";

import { useRef, useState } from "react";
import { Upload, Eye, Trash2 } from "lucide-react";
import BeadSwatch from "@/components/BeadSwatch";
import { apiHeaders } from "@/lib/auth";
import { importMaterials, matchImportRows } from "@/lib/materials";
import { archiveReceipt, findOrder, updateOrder, upsertOrder } from "@/lib/orders";
import { uploadForProcessing } from "@/lib/photo-upload";
import type { ExtractedItem, ExtractedOrder } from "@/lib/types";

interface Props {
  onImported: () => Promise<void>;
}

const EMPTY_ORDER: ExtractedOrder = {
  platform: "",
  seller: "",
  order_number: "",
  order_date: null,
  total: null,
};

export default function ReceiptImport({ onImported }: Props) {
  const [processing, setProcessing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [order, setOrder] = useState<ExtractedOrder | null>(null);
  // One status slot: the model's extraction note, then the import summary.
  const [message, setMessage] = useState<string | null>(null);
  // Which existing material each preview line would update (by index).
  const [matches, setMatches] = useState<(string | null)[]>([]);
  // The processed upload is kept so it can be archived with the order at
  // import — the processed one, since it's the version in an accepted format.
  const fileRef = useRef<{ blob: Blob; mediaType: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const patchOrder = (fields: Partial<ExtractedOrder>) =>
    setOrder({ ...(order ?? EMPTY_ORDER), ...fields });

  const processReceipt = async (file: File) => {
    setProcessing(true);
    setError("");
    setItems([]);
    setOrder(null);
    setMessage(null);
    setMatches([]);

    try {
      // Validate/downscale/upload directly to Supabase Storage, then hand
      // the API route only the path.
      const { path, mediaType, blob } = await uploadForProcessing(file, { allowPdf: true });
      fileRef.current = { blob, mediaType };

      const response = await fetch("/api/process-receipt", {
        method: "POST",
        headers: await apiHeaders(),
        body: JSON.stringify({ path, mediaType }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `Request failed (${response.status})`);
      }

      const extracted: ExtractedItem[] = result.items ?? [];
      setItems(extracted);
      setOrder(result.order ?? null);
      setMessage(
        result.notes ??
          (extracted.length === 0 ? "No jewelry materials were found on this receipt." : null)
      );
      // Preview what a re-upload will update, so surprises show before Import.
      try {
        const existing =
          result.order?.platform && result.order?.order_number
            ? await findOrder(result.order.platform, result.order.order_number)
            : null;
        const found = await matchImportRows(extracted, existing?.id ?? null);
        setMatches(found.map((m) => m?.name ?? null));
      } catch {
        setMatches([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process receipt");
    } finally {
      setProcessing(false);
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
    setMatches(matches.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, fields: Partial<ExtractedItem>) => {
    setItems(items.map((item, i) => (i === index ? { ...item, ...fields } : item)));
  };

  const importItems = async () => {
    setImporting(true);
    setError("");
    try {
      // The order row comes first so every material can point at it; the
      // receipt file is archived under it afterwards (a failed archive
      // shouldn't lose the import — the order just has no file link).
      const orderRow = await upsertOrder({
        platform: order?.platform?.trim() || "Unknown",
        seller: order?.seller?.trim() ?? "",
        order_number:
          order?.order_number?.trim() || `receipt-${new Date().toISOString().slice(0, 10)}`,
        order_date: order?.order_date || null,
        total: order?.total ?? null,
      });
      const result = await importMaterials(
        items.map((item) => ({
          name: item.name,
          category: item.category,
          unit_cost: item.unit_cost,
          quantity: item.estimated_units,
          unit_type: item.unit_type,
          supplier: order?.seller ?? "",
          visual: item.visual ?? null,
          source: item.source,
        })),
        orderRow.id
      );
      let archiveNote = "";
      const upload = fileRef.current;
      if (upload) {
        try {
          const path = await archiveReceipt(orderRow.id, upload.blob, upload.mediaType);
          await updateOrder(orderRow.id, { receipt_path: path });
        } catch (e) {
          archiveNote = ` Receipt file wasn't archived: ${e instanceof Error ? e.message : "unknown error"}.`;
        }
      }
      await onImported();
      setMessage(
        `Imported ${result.inserted} new and updated ${result.updated} existing material${
          result.updated === 1 ? "" : "s"
        } from ${orderRow.platform}${orderRow.seller ? ` / ${orderRow.seller}` : ""} order ${orderRow.order_number}.${archiveNote}`
      );
      setItems([]);
      setOrder(null);
      setMatches([]);
      fileRef.current = null;
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
              PNG, JPG, WebP, or PDF up to 20MB — large photos are compressed
              automatically
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
                <div className="grid grid-cols-2 gap-2 text-xs bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <label className="flex flex-col gap-0.5 text-gray-500">
                    Platform
                    <input
                      type="text"
                      value={order?.platform ?? ""}
                      onChange={(e) => patchOrder({ platform: e.target.value })}
                      className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-gray-500">
                    Seller
                    <input
                      type="text"
                      value={order?.seller ?? ""}
                      onChange={(e) => patchOrder({ seller: e.target.value })}
                      className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-gray-500">
                    Order #
                    <input
                      type="text"
                      value={order?.order_number ?? ""}
                      onChange={(e) => patchOrder({ order_number: e.target.value })}
                      placeholder="blank = one order per day"
                      title="Materials are grouped by platform + order number; leave blank and today's date is used"
                      className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </label>
                  <label className="flex flex-col gap-0.5 text-gray-500">
                    Date
                    <input
                      type="date"
                      value={order?.order_date ?? ""}
                      onChange={(e) => patchOrder({ order_date: e.target.value || null })}
                      className="px-2 py-1 border border-gray-300 rounded text-sm text-gray-900"
                    />
                  </label>
                </div>
                {items.map((item, index) => (
                  <div
                    key={index}
                    className="border border-gray-200 rounded-lg p-3 text-sm"
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex items-center gap-2 min-w-0">
                        {item.visual && (
                          <span className="shrink-0">
                            <BeadSwatch
                              visual={item.visual}
                              size={24}
                              seed={item.name}
                            />
                          </span>
                        )}
                        <div className="font-medium text-gray-900">
                          {item.name}
                          {matches[index] && (
                            <span
                              className="ml-2 inline-block align-middle text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800"
                              title={`Updates existing: ${matches[index]}`}
                            >
                              updates existing
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => removeItem(index)}
                        className="text-red-500 hover:text-red-700 p-1"
                        title="Remove from import"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="text-gray-500 mt-1 flex items-center gap-1 flex-wrap">
                      <select
                        value={item.category}
                        onChange={(e) => updateItem(index, { category: e.target.value })}
                        aria-label="Category"
                        className="px-1 py-0.5 border border-gray-300 rounded text-xs bg-white"
                      >
                        {CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <span>
                        • {item.quantity_purchased} • ${item.total_price.toFixed(2)} total
                      </span>
                    </div>
                    {item.source?.variation && (
                      <div className="text-xs text-gray-400 mt-0.5 truncate" title={item.source.listing_title}>
                        {item.source.variation}
                      </div>
                    )}
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

                {message && <p className="text-xs text-gray-500 italic">{message}</p>}

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
                  <p>{message ?? "Extracted materials will appear here after processing"}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
