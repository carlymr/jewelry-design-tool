import { getUserId } from "./auth";
import {
  listOwnedFolder,
  ownedPhotoUrls,
  removeOwnedPhotos,
  uploadOwnedPhoto,
} from "./photo-upload";

// Photos of a finished piece (GRA-38), kept in the owner-scoped design-photos
// bucket at {user_id}/{design_id}/{uuid}.{ext} (migration 0013). Unlike the
// transient receipts flow these stay: generate-listing reads them by path
// with the caller's token, and they're the images the Etsy listing will use.

export const DESIGN_PHOTOS_BUCKET = "design-photos";

/** Upload one photo for a design; returns its storage path. The caller adds
 * the path to designs.photo_paths. */
export const uploadDesignPhoto = (designId: string, file: File) =>
  uploadOwnedPhoto(DESIGN_PHOTOS_BUCKET, designId, file);

/** Short-lived display URLs, keyed by path. Missing objects are left out. */
export const designPhotoUrls = (paths: string[]) => ownedPhotoUrls(DESIGN_PHOTOS_BUCKET, paths);

export const deleteDesignPhotos = (paths: string[]) =>
  removeOwnedPhotos(DESIGN_PHOTOS_BUCKET, paths);

/** Every photo stored under a design's folder, including any orphaned by an
 * interrupted upload, so deleting a design leaves nothing behind. */
export async function deleteAllDesignPhotos(designId: string): Promise<void> {
  const userId = await getUserId();
  if (!userId) return;
  await deleteDesignPhotos(await listOwnedFolder(DESIGN_PHOTOS_BUCKET, `${userId}/${designId}`));
}
