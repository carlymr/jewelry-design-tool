import { getSupabase } from "./supabase";
import type { Material, NewMaterial } from "./types";

export async function listMaterials(): Promise<Material[]> {
  const { data, error } = await getSupabase()
    .from("materials")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function addMaterials(materials: NewMaterial[]): Promise<Material[]> {
  const { data, error } = await getSupabase()
    .from("materials")
    .insert(materials)
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
