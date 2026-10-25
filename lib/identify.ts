import { z } from "zod";
import { BeadVisualSchema, normalizeOrientation, type BeadVisual } from "./bead-visual";
import { isGeneric, GENERIC_CATALOG } from "./generic-catalog";
import { isLot } from "./lots";
import type { Material } from "./types";

// Identify a finished piece from photos (GRA-12). Shared by the route
// (app/api/identify-piece) and the import UI, so the request and response
// shapes live here.

export const IDENTIFY_MAX_PHOTOS = 4;

export const IDENTIFY_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export const IdentifyRequestSchema = z.object({
  photos: z
    .array(
      z.object({
        path: z.string().min(1).max(200),
        mediaType: z.enum(IDENTIFY_MEDIA_TYPES),
      })
    )
    .min(1)
    .max(IDENTIFY_MAX_PHOTOS),
  description: z.string().max(300).nullable(),
  inventory: z
    .array(
      z.object({
        id: z.string().max(64),
        name: z.string().max(300),
        category: z.string().max(60),
        size: z.string().max(80).nullable(),
      })
    )
    .max(2000),
  lots: z
    .array(
      z.object({
        id: z.string().max(64),
        name: z.string().max(300),
        listing_title: z.string().max(500).nullable(),
      })
    )
    .max(200),
  generics: z
    .array(z.object({ key: z.string().max(120), name: z.string().max(200) }))
    .max(300),
});

export type IdentifyRequest = z.infer<typeof IdentifyRequestSchema>;

// The model's answer. Kept free of length limits so the structured-output
// schema stays simple; the sanitizer below enforces the real constraints.
export const IdentifyResponseSchema = z.object({
  materials: z.array(
    z.object({
      ref: z.string(),
      kind: z.enum(["bead", "stone", "hardware"]),
      name: z.string(),
      matched_material_id: z.string().nullable(),
      lot_id: z.string().nullable(),
      generic_key: z.string().nullable(),
      visual: BeadVisualSchema.nullable(),
      confidence: z.enum(["high", "medium", "low"]),
    })
  ),
  strand: z.array(z.object({ ref: z.string() })),
  strand_length_in: z.number().nullable(),
});

export type IdentifyMaterial = z.infer<typeof IdentifyResponseSchema>["materials"][number];

export interface IdentifyResult {
  materials: (Omit<IdentifyMaterial, "visual"> & { visual: BeadVisual | null })[];
  /** Refs in order from one end of the strand to the other. */
  strand: string[];
  strand_length_in: number | null;
  /** Strand entries that named no material, dropped by the sanitizer. */
  dropped_refs: number;
}

/** Check every id the model returns against the lists it was given. Anything
 * unknown is cleared, so a hallucinated id can never reach the database. Every
 * material keeps its visual: the review can use it to create a match as a new
 * material, and resolveMaterials ignores it when a match or catalog entry is
 * set. */
export function sanitizeIdentification(
  raw: z.infer<typeof IdentifyResponseSchema>,
  known: { inventoryIds: Set<string>; lotIds: Set<string>; genericKeys: Set<string> }
): IdentifyResult {
  const materials = raw.materials.map((m) => {
    const matched = m.matched_material_id && known.inventoryIds.has(m.matched_material_id)
      ? m.matched_material_id
      : null;
    const generic = m.generic_key && known.genericKeys.has(m.generic_key) ? m.generic_key : null;
    const lot = !matched && !generic && m.lot_id && known.lotIds.has(m.lot_id) ? m.lot_id : null;
    return {
      ...m,
      matched_material_id: matched,
      generic_key: generic,
      lot_id: lot,
      visual: m.visual ? normalizeOrientation(m.visual) : null,
    };
  });

  const refs = new Set(materials.map((m) => m.ref));
  const strand = raw.strand.map((s) => s.ref).filter((ref) => refs.has(ref));
  const strand_length_in =
    raw.strand_length_in && raw.strand_length_in > 0 && raw.strand_length_in < 100
      ? raw.strand_length_in
      : null;

  return {
    materials,
    strand,
    strand_length_in,
    dropped_refs: raw.strand.length - strand.length,
  };
}

/** The owner's placeable inventory, in the compact form the model reads.
 * Lots and generic findings are sent separately, so they are left out here. */
export function inventoryForIdentify(materials: Material[]): IdentifyRequest["inventory"] {
  return materials
    .filter((m) => !isLot(m) && !isGeneric(m))
    .map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      size: m.visual
        ? `${m.visual.length_mm} x ${m.visual.width_mm} mm, ${m.visual.shape}`
        : null,
    }));
}

export function lotsForIdentify(materials: Material[]): IdentifyRequest["lots"] {
  return materials
    .filter((m) => isLot(m))
    .map((m) => ({ id: m.id, name: m.name, listing_title: m.source?.listing_title ?? null }));
}

export const genericsForIdentify = (): IdentifyRequest["generics"] =>
  GENERIC_CATALOG.map((e) => ({ key: e.key, name: e.name }));
