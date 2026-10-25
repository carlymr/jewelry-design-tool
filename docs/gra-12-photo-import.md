# GRA-12: create a design from a photo of a finished piece

Status: v1 implemented on `carly/gra-12-upload-designs-from-real-life`, not yet committed. Builds clean. Not yet run in the browser (needs a signed-in session), and migration 0018 is not yet applied to the live project.

## Goal

The owner photographs a finished piece and gets a saved design back, instead of re-entering every bead by hand. The import proposes the materials and strand order from the photo and an optional one-sentence description. The owner corrects it in a review step, and confirming creates any new materials and the design.

## Evaluation (prototype, not in the repo)

Thirteen listings from the StrataAtelier shop were used as test pieces. The seller's MATERIALS list is the ground truth, and the photos are the listing photos. The prototype harness lived in the scratchpad.

| Input | Recall (seller bead and stone lines found) | Precision vs. seller list | Strand length error |
|---|---|---|---|
| Title only | 66% | 97% | no data (7 listings had a length) |
| Title + photo 1 | 97% | 78% | 4% |
| Title + photo 1 + lots | 96% | 78% | 4% |
| Title + all photos | 100% | 80% | 1% |

Findings:

- The title alone finds about two-thirds of the materials. A photo is needed.
- Adding more photos mainly improves length, not material matching.
- Precision against the seller list is a lower bound. The seller lists are coarse and omit most hardware. A manual check of two listings found 19 of 22 extra items were real beads or components, 3 were uncertain, and none were wrong.
- Look-alikes are the weak spot: tiger iron vs. tiger's eye vs. red jasper.
- Lot suggestions were rare (2 of 70 bead and stone elements), and the test pieces mostly don't come from the owner's current lots. Lot linking is untested on real pieces.

## Decisions

- **Input:** an optional one-sentence description, encouraged with a placeholder example, plus one full-strand photo, flat, with a ruler in the same plane. Up to four photos total; close-ups are optional.
- **Scope:** bezels are out of v1.
- **Detail level:** each distinct bead, stone or pendant type is its own material (stone family, shape, size). Hardware that the generic catalog covers (jump rings, crimps, spacer balls, lobster and toggle clasps) is placed from the catalog with no inventory row. Other hardware (bails, ring connectors, chain, wire) becomes a new material on confirm.
- **New materials:** created on confirm with no cost and zero stock, so the owner sets stock before stringing.
- **Lots:** the owner imports a lot first through the receipt flow. In review, an unmatched element can be assigned to an existing lot. That goes through the same path as specifying a material from a lot, so provenance and the lot's remaining value stay correct. The lot's cost slice is left at zero for the owner to fill in later. Suggested lots are ranked by name. Automatic lot flagging in receipt extraction is tracked as GRA-52.
- **Review:** a search-and-swap, not a form. The photo is shown beside the proposed strand. Corrections happen per material (match, new, lot, rename, remove). Element order is fixed in review and corrected on the board.

## Flow

1. **Capture.** The owner enters an optional description, adds one to four photos, and clicks Identify. Each photo goes through the existing transient upload to the receipts bucket.
2. **Identify.** `POST /api/identify-piece` (Claude Opus 5.5) gets the photo paths, the description, a compact inventory list, the unsplit lots and the generic catalog keys. It returns distinct materials and the strand order as references to those materials. Ids and keys are checked against the lists it was given.
3. **Review.** The owner corrects materials and checks the strand order and length.
4. **Save.** Materials are created or resolved in order, then the design is created with status `finished`, and the photos are kept in `design-photos` and attached. The design then opens on the board. A retry after a partial failure reuses the materials already created.

## API contract

Request (`POST /api/identify-piece`, JWT in the Authorization header):

```
{
  photos: [{ path, mediaType }],           // 1–4 transient receipts-bucket uploads, owner's folder only
  description: string | null,              // max 300 chars
  inventory: [{ id, name, category, size }],  // placeable materials, not lots; max 2000
  lots: [{ id, name, listing_title }],     // unsplit lots; max 200
  generics: [{ key, name }]                // generic catalog entries; max 300
}
```

Response:

```
{
  materials: [{
    ref,                                   // short id used in strand
    kind: "bead" | "stone" | "hardware",
    name,
    matched_material_id,                   // an inventory id, or null
    lot_id,                                // a lot id, or null (only for new materials)
    generic_key,                           // a generic catalog key, or null
    visual,                                // BeadVisual for new non-generic items, else null
    confidence: "high" | "medium" | "low"
  }],
  strand: [{ ref }],                       // one end to the other; excludes clasp and chain
  strand_length_in: number | null,
  dropped_refs: number                     // strand refs that didn't resolve to a material
}
```

Server-side checks (`sanitizeIdentification` in `lib/identify.ts`): ids, lot ids and generic keys must come from the request lists, and unknown ones are cleared. New materials get `normalizeOrientation()`. Strand refs with no material are dropped and counted.

## Implementation notes

- **Rate limit:** `identify-piece` is added to `AiRoute` with a 20-per-hour cap. The `record_ai_call` function (migration 0012) only accepts known routes. Migration `0018_identify_piece_route.sql` adds the new one. It has to be applied remotely (see CLAUDE.md). Until then the rate limiter fails open, as designed.
- **No schema changes** beyond that route whitelist. Materials, designs, design photos and lots already have the fields the import needs.
- **Photos:** the transient copy is for identification and is deleted by the route. The kept copy is uploaded to `design-photos` after the design row exists, because the folder is keyed by design id.
- **Known limitations for v1:** no per-element editing in review (order is fixed; correct it on the board). Stock is zero for new materials. The strand is not checked against the ruler; the owner confirms the length.

## Verified so far

- `npm run build` passes (type check included).
- One real identify call on a listing with two photos, the route's prompt and response schema, and the sanitizer: the structured output parsed (34 s), 7 distinct materials, 92 strand elements, no dropped refs, length 18 in.
- Not verified: the browser flow, saving a design, lot linking against real lots, and the rate limit (it fails open until 0018 is applied).

## Open items

- Apply migration 0018 to the live project.
- Browser test with a signed-in session: identify, review, create, and retry after a forced failure.
- Real-piece test: a few pieces the owner knows the sources for, including one lot-derived piece, plus a flat ruler photo. This would settle the lot suggestion rate and the photo guidance.
- Whether the description placeholder should suggest a format.
