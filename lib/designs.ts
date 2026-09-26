import { getSupabase } from "./supabase";
import { getUserId } from "./auth";
import { deleteAllDesignPhotos } from "./design-photos";
import type { Design, NewDesign } from "./types";

export async function listDesigns(): Promise<Design[]> {
  const { data, error } = await getSupabase()
    .from("designs")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createDesign(design: NewDesign): Promise<Design> {
  // Stamp the owner client-side until the 0006 lockdown gives user_id a
  // DB-side default of auth.uid().
  const user_id = await getUserId();
  const { data, error } = await getSupabase()
    .from("designs")
    .insert({ ...design, user_id })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateDesign(
  id: string,
  fields: Partial<NewDesign>
): Promise<Design> {
  const { data, error } = await getSupabase()
    .from("designs")
    .update(fields)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteDesign(id: string): Promise<void> {
  const { error } = await getSupabase().from("designs").delete().eq("id", id);
  if (error) throw new Error(error.message);
  // The row is gone either way; leftover photos are only wasted storage, so a
  // cleanup failure shouldn't report the delete as failed.
  await deleteAllDesignPhotos(id).catch(() => {});
}
