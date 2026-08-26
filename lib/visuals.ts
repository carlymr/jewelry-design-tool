import { apiHeaders } from "./auth";
import type { BeadVisual } from "./bead-visual";

/** Derive a visual spec from a material's name via the generate-visuals route. */
export async function generateVisualForName(
  id: string,
  name: string
): Promise<BeadVisual | null> {
  const res = await fetch("/api/generate-visuals", {
    method: "POST",
    headers: await apiHeaders(),
    body: JSON.stringify({ materials: [{ id, name }] }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
  return (result.visuals?.[0]?.visual as BeadVisual | undefined) ?? null;
}
