"use client";

import { useRef, useState } from "react";
import { Camera, RefreshCw } from "lucide-react";
import { apiHeaders } from "@/lib/auth";
import { updateMaterial } from "@/lib/materials";
import { uploadPhoto } from "@/lib/photo-upload";
import type { Material } from "@/lib/types";

interface Props {
  material: Pick<Material, "id" | "name">;
  onUpdated: () => Promise<void>;
  /** Errors surface in the parent's existing error area. */
  onError: (message: string) => void;
  className?: string;
}

/** Camera button: photograph the actual material and let Claude derive a
 * photo-accurate visual spec from it. Used in the inventory table and the
 * design board palette. */
export default function PhotoVisualButton({
  material,
  onUpdated,
  onError,
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const analyze = async (file: File) => {
    setBusy(true);
    onError("");
    try {
      const { path, mediaType } = await uploadPhoto(file);
      const res = await fetch("/api/analyze-photo", {
        method: "POST",
        headers: await apiHeaders(),
        body: JSON.stringify({ path, mediaType, material_name: material.name }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      await updateMaterial(material.id, { visual: result.visual });
      await onUpdated();
    } catch (e) {
      // Errors land in a banner shared across rows, so name the material.
      const reason = e instanceof Error ? e.message : "Failed to analyze the photo";
      onError(`"${material.name}": ${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) analyze(file);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className={className ?? "p-1 text-gray-300 hover:text-purple-600 shrink-0"}
        title={busy ? "Analyzing photo… (can take up to a minute)" : "Upload a photo for accurate artwork"}
        aria-label={busy ? "Analyzing photo" : "Upload a photo for accurate artwork"}
        aria-busy={busy}
      >
        {busy ? (
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-600" />
        ) : (
          <Camera className="w-3.5 h-3.5" />
        )}
      </button>
    </>
  );
}
