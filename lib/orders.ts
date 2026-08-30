import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
import { extensionForMediaType } from "./photo-upload";
import type { NewOrder, Order } from "./types";

export const RECEIPT_ARCHIVE_BUCKET = "receipt-archive";

export async function listOrders(): Promise<Order[]> {
  const { data, error } = await getSupabase()
    .from("orders")
    .select("*")
    .order("order_date", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Create the order for a receipt, or update it if this order number was
 * imported before (re-uploading a receipt must not create a twin). The
 * archived-file link is deliberately not part of this write: it's set only
 * after a successful archive, so a failed re-archive can't blank a good one.
 * user_id is stamped client-side like the other lib/ writers (the DB default
 * would do; this keeps the insert explicit). */
export async function upsertOrder(order: Omit<NewOrder, "receipt_path">): Promise<Order> {
  const user_id = await getUserId();
  const { data, error } = await getSupabase()
    .from("orders")
    .upsert({ ...order, user_id }, { onConflict: "user_id,platform,order_number" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** One order by id, for showing a material's provenance. */
export async function getOrder(id: string): Promise<Order | null> {
  const { data, error } = await getSupabase()
    .from("orders")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** The order previously imported for this platform + order number, if any —
 * lets the import preview show what a re-upload will update. */
export async function findOrder(platform: string, orderNumber: string): Promise<Order | null> {
  const { data, error } = await getSupabase()
    .from("orders")
    .select("*")
    .eq("platform", platform)
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateOrder(id: string, fields: Partial<NewOrder>): Promise<void> {
  const { error } = await getSupabase().from("orders").update(fields).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Archive the receipt file under the owner's folder; returns the path. */
export async function archiveReceipt(orderId: string, file: Blob, mediaType: string) {
  const user_id = await getUserId();
  const path = `${user_id}/${orderId}.${extensionForMediaType(mediaType)}`;
  const { error } = await getSupabase()
    .storage.from(RECEIPT_ARCHIVE_BUCKET)
    .upload(path, file, { contentType: mediaType, upsert: true });
  if (error) throw new Error(`Receipt archive failed: ${error.message}`);
  return path;
}

/** Short-lived URL for viewing an archived receipt, opened at `page` when
 * the viewer honors the PDF fragment. */
export async function receiptUrl(path: string, page?: number | null): Promise<string> {
  const { data, error } = await getSupabase()
    .storage.from(RECEIPT_ARCHIVE_BUCKET)
    .createSignedUrl(path, 60 * 10);
  if (error || !data) throw new Error(error?.message ?? "Could not open receipt");
  return page && path.endsWith(".pdf") ? `${data.signedUrl}#page=${page}` : data.signedUrl;
}
