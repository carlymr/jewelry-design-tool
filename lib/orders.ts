import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
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
 * imported before (re-uploading a receipt must not create a twin). */
export async function upsertOrder(order: NewOrder): Promise<Order> {
  const user_id = await getUserId();
  const { data, error } = await getSupabase()
    .from("orders")
    .upsert(
      { ...order, user_id, updated_at: new Date().toISOString() },
      { onConflict: "user_id,platform,order_number" }
    )
    .select()
    .single();
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
  const ext = mediaType === "application/pdf" ? "pdf" : mediaType.split("/")[1];
  const path = `${user_id}/${orderId}.${ext}`;
  const { error } = await getSupabase()
    .storage.from(RECEIPT_ARCHIVE_BUCKET)
    .upload(path, file, { contentType: mediaType, upsert: true });
  if (error) throw new Error(`Receipt archive failed: ${error.message}`);
  return path;
}

/** Short-lived URL for viewing an archived receipt. */
export async function receiptUrl(path: string): Promise<string> {
  const { data, error } = await getSupabase()
    .storage.from(RECEIPT_ARCHIVE_BUCKET)
    .createSignedUrl(path, 60 * 10);
  if (error || !data) throw new Error(error?.message ?? "Could not open receipt");
  return data.signedUrl;
}
