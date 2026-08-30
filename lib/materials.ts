import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
import type { Material, MaterialSource, NewMaterial } from "./types";

export async function listMaterials(): Promise<Material[]> {
  const { data, error } = await getSupabase()
    .from("materials")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function addMaterials(materials: NewMaterial[]): Promise<Material[]> {
  // Stamp the owner client-side until the 0006 lockdown gives user_id a
  // DB-side default of auth.uid().
  const user_id = await getUserId();
  const { data, error } = await getSupabase()
    .from("materials")
    .insert(materials.map((m) => ({ ...m, user_id })))
    .select();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateMaterial(
  id: string,
  fields: Partial<NewMaterial>
): Promise<Material> {
  const { data, error } = await getSupabase()
    .from("materials")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteMaterial(id: string): Promise<void> {
  const { error } = await getSupabase().from("materials").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Import receipt line items, matching existing rows by name so a re-upload
 * (or the from-scratch re-import) updates in place instead of duplicating —
 * saved designs reference materials by id, so ids must survive.
 *
 * Match rules: a row with no order, or from this same order, is the same
 * stock — its count is replaced by the receipt's. A row from a different
 * order is a genuine re-order — the count is added. Provenance always
 * follows the latest receipt. Returns how many rows went each way. */
export async function importMaterials(
  rows: NewMaterial[],
  orderId: string
): Promise<{ inserted: number; updated: number }> {
  // Candidates: same name (any order), or anything already from this order
  // — a re-upload of the same receipt matches on the listing it came from,
  // which is stable even when the model words the name slightly differently.
  const names = rows.map((r) => r.name);
  const { data: existing, error } = await getSupabase()
    .from("materials")
    .select("id, name, quantity, order_id, visual, source")
    .or(`name.in.(${names.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(",")}),order_id.eq.${orderId}`);
  if (error) throw new Error(error.message);
  const rowsExisting = (existing ?? []) as Pick<
    Material,
    "id" | "name" | "quantity" | "order_id" | "visual" | "source"
  >[];
  const byName = new Map(rowsExisting.map((m) => [m.name.toLowerCase(), m]));
  const listingKey = (src: MaterialSource | null | undefined) =>
    src ? `${src.listing_title}\u0000${src.variation ?? ""}` : null;
  const byListing = new Map(
    rowsExisting
      .filter((m) => m.order_id === orderId && listingKey(m.source))
      .map((m) => [listingKey(m.source)!, m])
  );

  const inserts: NewMaterial[] = [];
  let updated = 0;
  const claimed = new Set<string>();
  for (const row of rows) {
    const key = listingKey(row.source);
    let match = (key && byListing.get(key)) || byName.get(row.name.toLowerCase());
    // Assortments split several rows out of one listing; once a row claims a
    // match the next variant must not update the same record.
    if (match && claimed.has(match.id)) match = undefined;
    if (match) claimed.add(match.id);
    if (!match) {
      inserts.push({ ...row, order_id: orderId });
      continue;
    }
    const sameStock = !match.order_id || match.order_id === orderId;
    const quantity = sameStock ? row.quantity : Number(match.quantity) + row.quantity;
    const { error: updErr } = await getSupabase()
      .from("materials")
      .update({
        name: row.name,
        category: row.category,
        unit_cost: row.unit_cost,
        unit_type: row.unit_type,
        quantity,
        order_id: orderId,
        source: row.source ?? null,
        // Keep a visual the user may have refined (photo, drill) over a
        // freshly extracted one.
        ...(match.visual ? {} : { visual: row.visual ?? null }),
      })
      .eq("id", match.id);
    if (updErr) throw new Error(updErr.message);
    updated += 1;
  }
  if (inserts.length > 0) await addMaterials(inserts);
  return { inserted: inserts.length, updated };
}
