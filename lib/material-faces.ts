import { useEffect, useState } from "react";
import { ownedPhotoUrls, removeOwnedPhotos, uploadOwnedPhoto } from "./photo-upload";
import type { Material } from "./types";

// Face photos for cabochons (GRA-15), kept in the owner-scoped material-faces
// bucket at {user_id}/{material_id}/{uuid}.{ext} (migration 0016). The board
// draws them clipped to the stone's outline, so they're the real pattern of
// the stone rather than the generated approximation.

export const MATERIAL_FACES_BUCKET = "material-faces";

// Signed URLs last an hour (see ownedPhotoUrls); refresh before they lapse
// so a board or inventory left open keeps its photos.
const URL_REFRESH_MS = 50 * 60 * 1000;

/** A face photo ready to draw: its display URL and how far to turn it. */
export interface FaceImage {
  href: string;
  rotation: number;
}

export const FACE_ROTATIONS = [0, 90, 180, 270] as const;

/** The next orientation in the 90° cycle a Rotate button steps through. */
export const nextFaceRotation = (rotation: number) =>
  FACE_ROTATIONS[(FACE_ROTATIONS.indexOf(rotation as (typeof FACE_ROTATIONS)[number]) + 1) % 4];

/** Upload a face photo for a material; returns its storage path. The caller
 * writes the path to materials.face_path. */
export const uploadMaterialFace = (materialId: string, file: File) =>
  uploadOwnedPhoto(MATERIAL_FACES_BUCKET, materialId, file);

/** Short-lived display URLs, keyed by path. Missing objects are left out. */
export const materialFaceUrls = (paths: string[]) => ownedPhotoUrls(MATERIAL_FACES_BUCKET, paths);

export const deleteMaterialFaces = (paths: string[]) =>
  removeOwnedPhotos(MATERIAL_FACES_BUCKET, paths);

/** The face photo to draw for a material, when it has one and it has loaded.
 * Null means draw the visual's generated face instead. */
export function faceUrlOf(
  material: Pick<Material, "face_path" | "face_rotation"> | null | undefined,
  urls: Record<string, string>
): FaceImage | null {
  if (!material?.face_path) return null;
  const href = urls[material.face_path];
  return href ? { href, rotation: material.face_rotation ?? 0 } : null;
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
