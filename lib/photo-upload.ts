import { getSupabase } from "./supabase";

// Files go straight to Supabase Storage (bypassing Vercel's ~4.5MB request
// body cap); API routes receive only the storage path and delete the file
// after processing, so the bucket stays empty. The bucket caps files at
// 20MB, which also keeps Anthropic requests under their 32MB limit.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// Images larger than this get downscaled client-side — vision doesn't need
// more resolution, and it saves tokens.
export const IMAGE_DOWNSCALE_THRESHOLD = 3 * 1024 * 1024;

// The formats the API routes (and Anthropic) accept; anything else gets
// re-encoded to JPEG client-side.
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function downscaleImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Most often a format the browser can't decode (e.g. HEIC in Chromium).
    throw new Error("Couldn't read this image — try a JPG, PNG, or WebP.");
  }
  const maxDim = 2000;
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Image compression failed"))),
      "image/jpeg",
      0.85
    );
  });
}

/** Upload a transient blob for AI processing; returns the storage path to
 * hand the API route. Lives in the receipts bucket — same lifecycle: the
 * route deletes the file whether or not processing succeeds. */
export async function uploadTransient(blob: Blob, mediaType: string): Promise<string> {
  const ext = mediaType === "application/pdf" ? "pdf" : mediaType.split("/")[1];
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await getSupabase()
    .storage.from("receipts")
    .upload(path, blob, { contentType: mediaType });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return path;
}

/** Validate, downscale/re-encode if needed, and upload a file for AI
 * processing. The whole size/type/downscale decision tree lives here so the
 * receipt and photo flows can't drift apart. */
export async function uploadForProcessing(
  file: File,
  opts: { allowPdf?: boolean } = {}
): Promise<{ path: string; mediaType: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File is too large (max 20MB).");
  }
  if (opts.allowPdf && file.type === "application/pdf") {
    return { path: await uploadTransient(file, file.type), mediaType: file.type };
  }
  if (!file.type.startsWith("image/")) {
    throw new Error(
      opts.allowPdf
        ? "Upload an image (PNG, JPG, WebP) or PDF."
        : "Upload a photo (PNG, JPG, WebP)."
    );
  }
  let blob: Blob = file;
  let mediaType = file.type;
  if (file.size > IMAGE_DOWNSCALE_THRESHOLD || !ACCEPTED_IMAGE_TYPES.has(file.type)) {
    blob = await downscaleImage(file);
    mediaType = "image/jpeg";
  }
  return { path: await uploadTransient(blob, mediaType), mediaType };
}

/** Photo-only upload (camera buttons). */
export const uploadPhoto = (file: File) => uploadForProcessing(file);
