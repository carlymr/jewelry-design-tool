import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
import type { Material, MaterialSource, NewMaterial } from "./types";
import type { GenericEntry } from "./generic-catalog";
import { toCents } from "./lots";

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

/** One material by id — for a surface that holds only a reference to it
 * (the detail modal looking up the lot a row came from). */
export async function getMaterial(id: string): Promise<Material | null> {
  const { data, error } = await getSupabase()
    .from("materials")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** The rows specified out of a lot (GRA-36). */
export async function listLotItems(lotId: string): Promise<Material[]> {
  const { data, error } = await getSupabase()
    .from("materials")
    .select("*")
    .eq("lot_id", lotId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** What the owner found in a lot, as its own inventory row (GRA-36). */
export interface LotItemInput {
  name: string;
  category: string;
  quantity: number;
  unit_type: string;
  /** The slice of the lot's price this item takes; unit_cost derives from it. */
  lot_cost: number;
}

/** Specify a material out of a lot: an ordinary row that inherits the lot's
 * order provenance (same order, same verbatim listing line — that IS where
 * it came from) and points back at the lot, so pricing and the source panel
 * can trace it. unit_cost is the allocated cost spread over the quantity;
 * the visual is left for the caller to fill (lib/visuals.ts) so a failed AI
 * call can't lose the row. */
export async function specifyFromLot(lot: Material, item: LotItemInput): Promise<Material> {
  if (!lot.is_lot) throw new Error("That material is not a lot");
  const lot_cost = toCents(item.lot_cost);
  const [row] = await addMaterials([
    {
      name: item.name,
      category: item.category,
      quantity: item.quantity,
      unit_type: item.unit_type,
      unit_cost: item.quantity > 0 ? lot_cost / item.quantity : 0,
      supplier: lot.supplier,
      order_id: lot.order_id,
      source: lot.source,
      lot_id: lot.id,
      lot_cost,
    },
  ]);
  if (!row) throw new Error("Could not create the material");
  return row;
}

/** The caller's row for a generic catalog entry, seeding it on first use
 * (GRA-17). An upsert on the (user_id, generic_key) unique index — the same
 * idiom as upsertOrder — so two placements racing each other can't create a
 * twin: the loser gets no row back and reads the winner's. RLS scopes the
 * read to the caller. */
export async function ensureGenericMaterial(entry: GenericEntry): Promise<Material> {
  const db = getSupabase();
  const user_id = await getUserId();
  const upserted = await db
    .from("materials")
    .upsert(
      {
        name: entry.name,
        category: entry.category,
        unit_cost: entry.unit_cost,
        unit_type: entry.unit_type,
        quantity: 0,
        supplier: "",
        visual: entry.visual,
        generic_key: entry.key,
        user_id,
      },
      { onConflict: "user_id,generic_key", ignoreDuplicates: true }
    )
    .select()
    .maybeSingle();
  if (upserted.error) throw new Error(upserted.error.message);
  if (upserted.data) return upserted.data;

  const existing = await db
    .from("materials")
    .select("*")
    .eq("generic_key", entry.key)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) throw new Error("Could not create the generic material");
  return existing.data;
}

type Candidate = Pick<Material, "id" | "name" | "quantity" | "order_id" | "visual" | "source">;

const listingKey = (src: MaterialSource | null | undefined) =>
  src ? `${src.listing_title}\u0000${src.variation ?? ""}` : null;

/** Decide which existing row (if any) each incoming line updates.
 *
 * Preference: a row from this same order with the same listing (title +
 * variation) — stable even when the model words a name differently on a
 * re-extraction — choosing the same-named one when an assortment split that
 * listing into several variants; then a row with the same name from any
 * order. Every candidate is claimed at most once, so sibling variants can't
 * pile onto one record. */
export async function matchImportRows(
  rows: Pick<NewMaterial, "name" | "source">[],
  orderId: string | null
): Promise<(Candidate | null)[]> {
  const db = getSupabase();
  const select = "id, name, quantity, order_id, visual, source";
  const names = Array.from(new Set(rows.map((r) => r.name)));
  // Generic rows (GRA-17) share the naming standard with receipt lines but
  // are not inventory; a receipt must never top one up. Rows specified out
  // of a lot (GRA-36) carry the lot's order and listing line, so without
  // this they'd match the lot's own line on a re-upload.
  const base = () => db.from("materials").select(select).is("generic_key", null).is("lot_id", null);
  const [byNameRes, byOrderRes] = await Promise.all([
    base().in("name", names),
    orderId
      ? base().eq("order_id", orderId)
      : Promise.resolve({ data: [] as Candidate[], error: null }),
  ]);
  if (byNameRes.error) throw new Error(byNameRes.error.message);
  if (byOrderRes.error) throw new Error(byOrderRes.error.message);
  const candidates = new Map<string, Candidate>();
  for (const m of [...(byNameRes.data ?? []), ...(byOrderRes.data ?? [])] as Candidate[]) {
    candidates.set(m.id, m);
  }

  const byListing = new Map<string, Candidate[]>();
  const byName = new Map<string, Candidate[]>();
  for (const m of candidates.values()) {
    const key = m.order_id === orderId ? listingKey(m.source) : null;
    if (key) byListing.set(key, [...(byListing.get(key) ?? []), m]);
    const n = m.name.toLowerCase();
    byName.set(n, [...(byName.get(n) ?? []), m]);
  }

  const claimed = new Set<string>();
  const take = (list: Candidate[] | undefined, preferName?: string) => {
    const open = (list ?? []).filter((m) => !claimed.has(m.id));
    if (open.length === 0) return null;
    const named = preferName && open.find((m) => m.name.toLowerCase() === preferName);
    const pick = named || (open.length === 1 ? open[0] : null);
    if (pick) claimed.add(pick.id);
    return pick;
  };
  return rows.map((row) => {
    const lname = row.name.toLowerCase();
    return take(byListing.get(listingKey(row.source) ?? ""), lname) ?? take(byName.get(lname), lname);
  });
}

/** Import receipt line items, updating matched rows in place (see
 * matchImportRows) so ids — and the designs that reference them — survive a
 * re-upload or the from-scratch re-import. A matched row with no order, or
 * from this same order, is the same stock: its count is replaced by the
 * receipt's. A row from a different order is a genuine re-order: the count
 * is added. Provenance always follows the latest receipt. */
export async function importMaterials(
  rows: NewMaterial[],
  orderId: string
): Promise<{ inserted: number; updated: number }> {
  const matches = await matchImportRows(rows, orderId);
  const inserts: NewMaterial[] = [];
  const updates: Promise<void>[] = [];
  rows.forEach((row, i) => {
    const match = matches[i];
    if (!match) {
      inserts.push({ ...row, order_id: orderId });
      return;
    }
    const sameStock = !match.order_id || match.order_id === orderId;
    const quantity = sameStock ? row.quantity : Number(match.quantity) + row.quantity;
    updates.push(
      Promise.resolve(
        getSupabase()
          .from("materials")
          .update({
          name: row.name,
          category: row.category,
          unit_cost: row.unit_cost,
          unit_type: row.unit_type,
          quantity,
          order_id: orderId,
          source: row.source ?? null,
          // Like the visual below, a lot flag the owner set by hand outranks
          // a re-extraction that didn't recognize the line as a lot.
          ...(row.is_lot ? { is_lot: true } : {}),
          // Keep a visual the user may have refined (photo, drill) over a
          // freshly extracted one.
            ...(match.visual ? {} : { visual: row.visual ?? null }),
          })
          .eq("id", match.id)
      ).then(({ error }) => {
        if (error) throw new Error(error.message);
      })
    );
  });
  await Promise.all(updates);
  if (inserts.length > 0) await addMaterials(inserts);
  return { inserted: inserts.length, updated: updates.length };
}
