import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
import type { Material, MaterialSource, NewMaterial } from "./types";
import type { GenericEntry } from "./generic-catalog";

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

/** The caller's row for a generic catalog entry, seeding it on first use
 * (GRA-17). RLS scopes the lookup to the caller, and the partial unique
 * index on (user_id, generic_key) means a race between two placements ends
 * in one insert failing — that loser just re-reads the winner's row. */
export async function ensureGenericMaterial(entry: GenericEntry): Promise<Material> {
  const db = getSupabase();
  const existing = await db
    .from("materials")
    .select("*")
    .eq("generic_key", entry.key)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return existing.data;

  const [inserted] = await addMaterials([
    {
      name: entry.name,
      category: entry.category,
      unit_cost: entry.unit_cost,
      unit_type: entry.unit_type,
      quantity: 0,
      supplier: "",
      visual: entry.visual,
      generic_key: entry.key,
    },
  ]).then(
    (rows) => rows,
    async (e: unknown) => {
      // 23505 = unique_violation: someone (a double-click) got there first.
      if (e instanceof Error && /duplicate key|23505/.test(e.message)) {
        const again = await db
          .from("materials")
          .select("*")
          .eq("generic_key", entry.key)
          .maybeSingle();
        if (again.error) throw new Error(again.error.message);
        if (again.data) return [again.data as Material];
      }
      throw e;
    }
  );
  if (!inserted) throw new Error("Could not create the generic material");
  return inserted;
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
  const [byNameRes, byOrderRes] = await Promise.all([
    db.from("materials").select(select).in("name", names),
    orderId
      ? db.from("materials").select(select).eq("order_id", orderId)
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
