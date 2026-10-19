import { useEffect, useState } from "react";
import { getUserId } from "./auth";
import { getSupabase } from "./supabase";
import { extensionForMediaType, prepareImage } from "./photo-upload";
import type { Material } from "./types";

// Face photos for cabochons (GRA-15), kept in the owner-scoped material-faces
// bucket at {user_id}/{material_id}/{uuid}.{ext} (migration 0016). The board
// draws them clipped to the stone's outline, so they're the real pattern of
// the stone rather than the generated approximation.

export const MATERIAL_FACES_BUCKET = "material-faces";

// Signed URLs last an hour (see materialFaceUrls); refresh before they lapse
// so a board or inventory left open keeps its photos.
const URL_REFRESH_MS = 50 * 60 * 1000;

/** Upload a face photo for a material; returns its storage path. The caller
 * writes the path to materials.face_path. */
export async function uploadMaterialFace(materialId: string, file: File): Promise<string> {
  const userId = await getUserId();
  if (!userId) throw new Error("Sign in to upload photos.");
  const { blob, mediaType } = await prepareImage(file);
  const path = `${userId}/${materialId}/${crypto.randomUUID()}.${extensionForMediaType(mediaType)}`;
  const { error } = await getSupabase()
    .storage.from(MATERIAL_FACES_BUCKET)
    .upload(path, blob, { contentType: mediaType });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

/** Short-lived display URLs, keyed by path. Missing objects are left out. */
export async function materialFaceUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await getSupabase()
    .storage.from(MATERIAL_FACES_BUCKET)
    .createSignedUrls(paths, 60 * 60);
  if (error) throw new Error(error.message);
  const urls: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) urls[item.path] = item.signedUrl;
  }
  return urls;
}

export async function deleteMaterialFaces(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await getSupabase().storage.from(MATERIAL_FACES_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}

/** The display URL for a material's face photo, when it has one and it has
 * loaded. Null means draw the visual's generated face instead. */
export function faceUrlOf(
  material: Pick<Material, "face_path"> | null | undefined,
  urls: Record<string, string>
): string | null {
  return material?.face_path ? urls[material.face_path] ?? null : null;
}

/** Signed URLs for the face photos among `paths`, refetched when the set of
 * paths changes and on a timer before they expire. Failures leave the faces
 * out rather than blocking the page. */
export function useFaceUrls(paths: (string | null | undefined)[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = [...new Set(paths.filter((p): p is string => !!p))].sort().join("\n");
  useEffect(() => {
    const wanted = key ? key.split("\n") : [];
    if (wanted.length === 0) {
      setUrls({});
      return;
    }
    let stale = false;
    const load = () => {
      materialFaceUrls(wanted)
        .then((next) => {
          if (!stale) setUrls(next);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, URL_REFRESH_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [key]);
  return urls;
}
