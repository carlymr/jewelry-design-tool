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

Virtual beading board + materials inventory + AI receipt processing for a strung-jewelry business. Single-user tool (no auth yet). Extracted from an earlier Claude-artifact prototype; the artifact's pricing calculator and Etsy listing generator were intentionally left behind and may be rebuilt later.

The design board (`components/DesignBoard.tsx`, home page) lays out strands true to scale from stored per-bead visual specs (`lib/bead-visual.ts` schema, rendered by `components/BeadSwatch.tsx`). Visuals are generated once and stored in `materials.visual`: the receipt route emits them photo-informed during extraction; `app/api/generate-visuals/route.ts` backfills name-only for everything else (triggered lazily when the board loads). Both routes share the same Zod schema — keep them in sync through `lib/bead-visual.ts`.

Deployed on Vercel (project `jewelry-design-tool`, personal account) from pushes to `main`. Supabase project: `supabase-green-zebra` (`fzoezwgejhcurlwnshcb`), provisioned through the Vercel marketplace.

## Architecture

Two independent data paths:

1. **Inventory + designs CRUD** — browser talks to Supabase directly via `supabase-js` (`lib/materials.ts`, `lib/designs.ts` → `lib/supabase.ts`). No API routes involved; even generated visuals are written by the client after the API route returns them. RLS is enabled but deliberately permissive (single-user); tighten policies when auth is added.

2. **Receipt processing** — three hops, shaped by two hard constraints:
   - Client uploads the file **directly to the private `receipts` Storage bucket** (`components/ReceiptImport.tsx`), because Vercel serverless functions cap request bodies at ~4.5MB. Never route file uploads through an API route.
   - `app/api/process-receipt/route.ts` receives only the storage path, downloads the file, sends it to Claude (`claude-opus-4-8` via `client.messages.parse` with a Zod schema / structured outputs), and **deletes the file in a `finally` block** — receipts are transient, the bucket should stay empty.
   - The route uses the **Storage REST API via `fetch`, not supabase-js** — supabase-js requires a native WebSocket at construction, which breaks on older Node server-side. Keep it that way.

The extraction prompt in the route enforces a naming convention (`[Material/Color] [Item Type] [Size] [Shape/Detail]`, no pack counts) and splits assortment line items into per-variant entries with proportional price allocation. Changes to extraction behavior go in `EXTRACTION_PROMPT` / `ExtractedItemSchema` there; the schema's `.describe()` strings are part of the prompt.

## Conventions and constraints

- **Supabase auth key**: uses the modern publishable key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `sb_publishable_...`); legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is a fallback only because the Vercel integration injects it. Don't reintroduce anon-key-first logic.
- **`lib/supabase.ts` creates the client lazily** so modules can be imported at build time without env vars. Keep new Supabase usage behind `getSupabase()`.
- **Migrations**: SQL files in `supabase/migrations/` are the record, but they are applied to the live project via the Supabase MCP tools (or SQL editor) — there is no CLI migration pipeline. When changing schema, do both: apply remotely and add the numbered file.
- **CSV format** (`Name, Category, Cost Per Unit, Unit, In Stock`) is intentionally compatible with exports from the original artifact tool — don't change the column order.
- **DB naming**: table columns are snake_case (`unit_cost`, `estimated_units`); the API route's extraction schema mirrors this so extracted items map to DB rows without renaming.
- `sample_data/` holds real receipt PDFs for end-to-end testing (the Etsy one is 3.6MB — the case that motivated the storage-upload flow).
