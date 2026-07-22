import { getSupabase } from "./supabase";
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
  const { data, error } = await getSupabase()
    .from("designs")
    .insert(design)
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
}
