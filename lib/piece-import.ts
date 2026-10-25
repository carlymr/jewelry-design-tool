import { apiHeaders } from "./auth";
import type { BeadVisual } from "./bead-visual";
import { GENERIC_CATALOG } from "./generic-catalog";
import { addMaterials, ensureGenericMaterial, specifyFromLot, updateMaterial } from "./materials";
import { createDesign, updateDesign } from "./designs";
import { uploadDesignPhoto } from "./design-photos";
import { uploadForProcessing } from "./photo-upload";
import type { IdentifyMaterial, IdentifyRequest, IdentifyResult } from "./identify";
import type { Design, DesignBead, Material } from "./types";

const MM_PER_INCH = 25.4;

// Client side of the photo import (GRA-12): sends the photos to identify, and
// turns the owner's reviewed plan into materials and a design. Creation is
// ordered so a failure part-way leaves nothing ambiguous behind: each material
// is resolved once, and the caller keeps the resolved ids so a retry reuses
// them instead of creating duplicates.

export type ReviewMaterial = {
  ref: string;
  kind: IdentifyMaterial["kind"];
  name: string;
  confidence: IdentifyMaterial["confidence"];
  /** An owned inventory row this element is (set by the owner or the model). */
  matchId: string | null;
  /** A generic catalog key for hardware the catalog covers. */
  genericKey: string | null;
  /** A lot to take this new material out of, when it is one. */
  lotId: string | null;
  /** The visual for a new material; null when the model gave none. */
  visual: BeadVisual | null;
  removed: boolean;
};

export interface ReviewPlan {
  materials: ReviewMaterial[];
  strand: string[];
  lengthIn: number;
  description: string | null;
}

export const DEFAULT_LENGTH_IN = 7;

/** Materials already created for this plan, keyed by ref. `sig` records the
 * decision that produced the row, so a retry reuses it only when the owner's
 * choice is unchanged. */
export type ResolvedMap = Map<string, { id: string; sig: string }>;

const decisionSignature = (m: ReviewMaterial) =>
  [m.matchId ?? "", m.genericKey ?? "", m.lotId ?? "", m.visual ? "visual" : ""].join("|");

export function planFromResult(result: IdentifyResult, description: string | null): ReviewPlan {
  return {
    materials: result.materials.map((m) => ({
      ref: m.ref,
      kind: m.kind,
      name: m.name,
      confidence: m.confidence,
      matchId: m.matched_material_id,
      genericKey: m.generic_key,
      lotId: m.lot_id,
      visual: m.visual,
      removed: false,
    })),
    strand: result.strand,
    lengthIn: result.strand_length_in ?? DEFAULT_LENGTH_IN,
    description,
  };
}

/** A material is resolvable when it has an owned match, a catalog entry, or a
 * visual to create from. Anything else needs the owner to pick one. */
export const isResolvable = (m: ReviewMaterial) =>
  !!m.matchId || !!m.genericKey || !!m.visual;

export const CATEGORY_FOR_KIND: Record<IdentifyMaterial["kind"], string> = {
  bead: "Beads",
  stone: "Cabochons",
  hardware: "Findings",
};

/** Upload the photos as transient copies and ask for the identification. */
export async function identifyPhotos(
  files: File[],
  description: string | null,
  inventory: IdentifyRequest["inventory"],
  lots: IdentifyRequest["lots"],
  generics: IdentifyRequest["generics"]
): Promise<IdentifyResult> {
  const photos = [];
  for (const file of files) {
    const { path, mediaType } = await uploadForProcessing(file);
    photos.push({ path, mediaType });
  }
  const res = await fetch("/api/identify-piece", {
    method: "POST",
    headers: await apiHeaders(),
    body: JSON.stringify({ photos, description, inventory, lots, generics }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
  return result as IdentifyResult;
}

/** Create or resolve each kept material once. Returns ref → material id, and
 * adds to `resolved` as it goes so a retry skips what already exists. */
export async function resolveMaterials(
  plan: ReviewPlan,
  lotRows: Material[],
  resolved: ResolvedMap
): Promise<void> {
  for (const m of plan.materials) {
    if (m.removed) continue;
    const sig = decisionSignature(m);
    const done = resolved.get(m.ref);
    if (done && done.sig === sig) continue;

    if (m.matchId) {
      resolved.set(m.ref, { id: m.matchId, sig });
      continue;
    }

    if (m.genericKey) {
      const entry = GENERIC_CATALOG.find((e) => e.key === m.genericKey);
      if (!entry) throw new Error(`Unknown catalog item for "${m.name}".`);
      const row = await ensureGenericMaterial(entry);
      resolved.set(m.ref, { id: row.id, sig });
      continue;
    }

    if (!m.visual) throw new Error(`Pick a material for "${m.name}" before creating the design.`);

    const category = CATEGORY_FOR_KIND[m.kind];
    if (m.lotId) {
      const lot = lotRows.find((l) => l.id === m.lotId);
      if (!lot) throw new Error(`The lot for "${m.name}" is no longer in inventory.`);
      // Stock and cost are the owner's to enter later (see the lot panel), so
      // the row starts at zero, the same as a new material without a lot.
      const row = await specifyFromLot(lot, {
        name: m.name,
        category,
        quantity: 0,
        unit_type: "piece",
        lot_cost: 0,
      });
      await updateMaterial(row.id, { visual: m.visual });
      resolved.set(m.ref, { id: row.id, sig });
      continue;
    }

    const [row] = await addMaterials([
      {
        name: m.name,
        category,
        quantity: 0,
        unit_type: "piece",
        unit_cost: 0,
        supplier: "",
        visual: m.visual,
      },
    ]);
    if (!row) throw new Error(`Could not create "${m.name}".`);
    resolved.set(m.ref, { id: row.id, sig });
  }
}

/** The strand as design beads, skipping removed materials and any ref that
 * didn't resolve. Returns the count skipped so the owner can be told. */
export function beadsFromPlan(
  plan: ReviewPlan,
  resolved: ResolvedMap
): { beads: DesignBead[]; skipped: number } {
  const removed = new Set(plan.materials.filter((m) => m.removed).map((m) => m.ref));
  let skipped = 0;
  const beads: DesignBead[] = [];
  for (const ref of plan.strand) {
    const id = resolved.get(ref)?.id;
    if (!id || removed.has(ref)) {
      skipped += 1;
      continue;
    }
    beads.push({ material_id: id });
  }
  return { beads, skipped };
}

export function designNameFor(description: string | null): string {
  const trimmed = description?.trim();
  return trimmed ? trimmed.slice(0, 60) : "Imported piece";
}

/** Create the design from a resolved plan, then keep the photos on it. The
 * design row is created before its photos because the photo folder is keyed by
 * design id. A photo failure leaves the design in place and is reported. */
export async function createImportedDesign(
  plan: ReviewPlan,
  resolved: ResolvedMap,
  photos: File[]
): Promise<{ design: Design; photoError: string | null; skipped: number }> {
  const { beads, skipped } = beadsFromPlan(plan, resolved);
  const design = await createDesign({
    name: designNameFor(plan.description),
    target_length_mm: Math.round(plan.lengthIn * MM_PER_INCH * 100) / 100,
    beads,
    status: "finished",
  });

  let photoError: string | null = null;
  try {
    const paths: string[] = [];
    for (const file of photos) paths.push(await uploadDesignPhoto(design.id, file));
    const saved = await updateDesign(design.id, { photo_paths: paths });
    return { design: saved, photoError, skipped };
  } catch (e) {
    photoError = e instanceof Error ? e.message : "Photos could not be saved.";
    return { design, photoError, skipped };
  }
}
