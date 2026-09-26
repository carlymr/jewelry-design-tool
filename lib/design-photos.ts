import { getUserId } from "./auth";
import { getSupabase } from "./supabase";
import { extensionForMediaType, prepareImage } from "./photo-upload";

// Photos of a finished piece (GRA-38), kept in the owner-scoped design-photos
// bucket at {user_id}/{design_id}/{uuid}.{ext} (migration 0013). Unlike the
// transient receipts flow these stay: generate-listing reads them by path
// with the caller's token, and they're the images the Etsy listing will use.

export const DESIGN_PHOTOS_BUCKET = "design-photos";

/** Upload one photo for a design; returns its storage path. The caller adds
 * the path to designs.photo_paths. */
export async function uploadDesignPhoto(designId: string, file: File): Promise<string> {
  const userId = await getUserId();
  if (!userId) throw new Error("Sign in to upload photos.");
  const { blob, mediaType } = await prepareImage(file);
  const path = `${userId}/${designId}/${crypto.randomUUID()}.${extensionForMediaType(mediaType)}`;
  const { error } = await getSupabase()
    .storage.from(DESIGN_PHOTOS_BUCKET)
    .upload(path, blob, { contentType: mediaType });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

/** Short-lived display URLs, keyed by path. Missing objects are left out. */
export async function designPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await getSupabase()
    .storage.from(DESIGN_PHOTOS_BUCKET)
    .createSignedUrls(paths, 60 * 60);
  if (error) throw new Error(error.message);
  const urls: Record<string, string> = {};
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) urls[item.path] = item.signedUrl;
  }
  return urls;
}

export async function deleteDesignPhotos(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await getSupabase().storage.from(DESIGN_PHOTOS_BUCKET).remove(paths);
  if (error) throw new Error(error.message);
}

/** Every photo stored under a design's folder, including any orphaned by an
 * interrupted upload, so deleting a design leaves nothing behind. */
export async function deleteAllDesignPhotos(designId: string): Promise<void> {
  const userId = await getUserId();
  if (!userId) return;
  const folder = `${userId}/${designId}`;
  const { data, error } = await getSupabase()
    .storage.from(DESIGN_PHOTOS_BUCKET)
    .list(folder, { limit: 1000 });
  if (error) throw new Error(error.message);
  await deleteDesignPhotos((data ?? []).map((f) => `${folder}/${f.name}`));
}
