"use client";

import { useCallback, useEffect, useState } from "react";
import { listMaterials } from "./materials";
import type { Material } from "./types";

/** Load the materials list on mount; both pages share this. */
export function useMaterials() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setLoadError("");
      setMaterials(await listMaterials());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load materials");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { materials, loading, loadError, refresh };
}
