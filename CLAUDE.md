# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev     # dev server (uses .env.local)
npm run build   # production build + type check — run this to verify changes
```

There is no test suite or lint config yet. Node 24 is required (`.nvmrc`); supabase-js breaks on Node < 22.

**Do not run `npm run build` while a dev server is running** — the production build corrupts the dev server's `.next` state, causing `__webpack_modules__[moduleId] is not a function` 500s. If that happens: stop the dev server, `rm -rf .next`, restart.

## What this is

Virtual beading board + materials inventory + AI receipt processing for a strung-jewelry business. Extracted from an earlier Claude-artifact prototype.

Auth is Supabase Google OAuth: `components/AuthGate.tsx` gates the whole app and provides the session via context; `lib/auth.ts` wraps supabase-js auth and builds API-route headers. Materials and designs are scoped per-user (`user_id`). Migration `0005` is the zero-downtime transition (legacy null-owner rows stay visible; a trigger freezes `user_id` so nobody can claim or release rows); `0006` is the lockdown — apply it only after backfilling legacy rows to their owner, per the comments in the file. 0006 also restricts the `receipts` Storage bucket to authenticated users. API routes verify the Supabase JWT via a GoTrue `fetch` (no supabase-js server-side) and accept nothing else.

The pricing calculator and Etsy listing generator were rebuilt from that artifact as `/pricing` (`components/PricingStudio.tsx`): materials cost derives from a saved design's actual beads (plus manually added "extras" like clasps), and `app/api/generate-listing/route.ts` drafts the listing. Per-design inputs and the listing persist on `designs.pricing`/`designs.listing` (jsonb); business-wide rates and style guidelines live in localStorage (`pricing-settings`).

The design board (`components/DesignBoard.tsx`, home page) lays out strands true to scale from stored per-element visual specs (`lib/bead-visual.ts` schema, rendered by `components/BeadSwatch.tsx`). Visuals are generated once and stored in `materials.visual`: the receipt route emits them photo-informed during extraction; `app/api/generate-visuals/route.ts` backfills name-only for everything else (triggered lazily when the board loads, and on demand via `lib/visuals.ts` — the palette's regenerate button and the inventory table's rename-with-refresh edit flow); `app/api/analyze-photo/route.ts` re-derives one material's visual from a user-uploaded close-up (camera buttons in the inventory table and palette — `components/PhotoVisualButton.tsx`, uploading via `lib/photo-upload.ts` through the same transient receipts-bucket flow). All three routes share the same Zod schema — keep them in sync through `lib/bead-visual.ts`.

The board has two layouts: the straight editing line, and an "As worn" view whose geometry lives in `lib/strand-layout.ts` — a closed circle for targets under 12" (`NECKLACE_MIN_MM`), a catenary drape at or above. Both are parameterized by arc length, so elements advance along the curve exactly as on the line, and pointer positions invert to arc length for click/drag. The strand is centered on the curve (midpoint at the drape's lowest point / circle's bottom) because necklaces are built center-out and worn symmetric.

Beyond beads, the schema's `COMPONENT_SHAPES` cover strand components — chain, jump rings, clasps, connectors, cabochons. Component shapes bypass BeadSwatch's filled-silhouette pipeline and draw themselves (`componentElement`); a placed `chain` element always represents a 1-inch segment (`length_mm: 25.4`), which keeps per-element stock counting aligned with chain sold by the inch. Cabochons render as hanging pendants (bail ring on the string, stone below with its long axis vertical) and advance the strand by only `CABOCHON_ADVANCE_MM`, not the stone's size. Placeable categories are Beads/Cabochons/Findings (`PLACEABLE_CATEGORIES` in DesignBoard); the palette additionally shows any other material that already has a visual.

Deployed on Vercel (project `jewelry-design-tool`, personal account) from pushes to `main`. Supabase project: `supabase-green-zebra` (`fzoezwgejhcurlwnshcb`), provisioned through the Vercel marketplace.

## Architecture

Two independent data paths:

1. **Inventory + designs CRUD** — browser talks to Supabase directly via `supabase-js` (`lib/materials.ts`, `lib/designs.ts` → `lib/supabase.ts`). No API routes involved; even generated visuals are written by the client after the API route returns them. RLS scopes rows to `auth.uid()`; inserts stamp `user_id` client-side until the 0006 lockdown adds a DB default.

2. **Receipt processing** — three hops, shaped by two hard constraints:
   - Client uploads the file **directly to the private `receipts` Storage bucket** (`components/ReceiptImport.tsx`), because Vercel serverless functions cap request bodies at ~4.5MB. Never route file uploads through an API route.
   - `app/api/process-receipt/route.ts` receives only the storage path, downloads the file, sends it to Claude (`claude-opus-4-8` via `client.messages.parse` with a Zod schema / structured outputs), and **deletes the file in a `finally` block** — receipts are transient, the bucket should stay empty.
   - The route uses the **Storage REST API via `fetch`, not supabase-js** — supabase-js requires a native WebSocket at construction, which breaks on older Node server-side. Keep it that way.
   - Storage calls run with the **caller's session token, not a service key** — the `receipts` bucket has been authenticated-only RLS since migration 0006, and the routes hold no admin credential. `isAuthorized()` validates the forwarded JWT before it's reused for storage. (`analyze-photo` follows the same pattern; bead-photo uploads reuse the receipts bucket and inherit its RLS and size/type limits.)

The extraction prompt in the route enforces a naming convention (`[Material/Color] [Item Type] [Size] [Shape/Detail]`, no pack counts) and splits assortment line items into per-variant entries with proportional price allocation. Changes to extraction behavior go in `EXTRACTION_PROMPT` / `ExtractedItemSchema` there; the schema's `.describe()` strings are part of the prompt.

## Conventions and constraints

- **Supabase auth key**: uses the modern publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `sb_publishable_...`); legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a fallback only because the Vercel integration injects it. Don't reintroduce anon-key-first logic.
- **`lib/supabase.ts` creates the client lazily** so modules can be imported at build time without env vars. Keep new Supabase usage behind `getSupabase()`.
- **Migrations**: SQL files in `supabase/migrations/` are the record, but they are applied to the live project via the Supabase MCP tools (or SQL editor) — there is no CLI migration pipeline. When changing schema, do both: apply remotely and add the numbered file.
- **CSV format** (`Name, Category, Cost Per Unit, Unit, In Stock`) is intentionally compatible with exports from the original artifact tool — don't change the column order.
- **DB naming**: table columns are snake_case (`unit_cost`, `estimated_units`); the API route's extraction schema mirrors this so extracted items map to DB rows without renaming.
- `sample_data/` holds real receipt PDFs for end-to-end testing (the Etsy one is 3.6MB — the case that motivated the storage-upload flow).
