# Jewelry Design Tool

Materials inventory and AI-powered receipt processing for strung jewelry design. Built with Next.js, Supabase, and the Anthropic API; deploys to Vercel.

This is the foundation extracted from the original artifact-based jewelry business tool — just the inventory management and receipt import, backed by a real database instead of localStorage.

## Features

- **Materials inventory** — searchable, sortable table with add / stock editing / delete, stored in Supabase
- **Receipt import** — upload a receipt image or PDF; Claude extracts line items (applying discounts, estimating bead counts from strand lengths) into a preview you can adjust before importing
- **CSV import/export** — same column format as the original tool (`Name, Category, Cost Per Unit, Unit, In Stock`), so old exports import cleanly

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com/dashboard).
2. In the SQL Editor, run the contents of `supabase/migrations/0001_create_materials.sql`.
3. From **Project Settings → API**, copy the project URL and anon key.

> The migration enables RLS with a permissive anon policy — fine for a single-user tool. Tighten the policies when auth is added.

### 2. Environment variables

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Where it's used |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser — inventory reads/writes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser — inventory reads/writes (`sb_publishable_...`; the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` works as a fallback) |
| `ANTHROPIC_API_KEY` | Server only — receipt processing API route |

### 3. Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

```bash
npm i -g vercel   # if needed
vercel
```

Or import the repo at [vercel.com/new](https://vercel.com/new). Either way, add the three environment variables from `.env.example` in the Vercel project settings (all environments), then deploy. Next.js is auto-detected; no extra configuration is needed.

**Note:** receipt files are uploaded directly to a private Supabase Storage bucket (`receipts`) rather than through the API route, sidestepping Vercel's ~4.5MB request-body cap. The route downloads the file server-side, processes it, and deletes it. Files up to 20MB are supported; large photos are downscaled client-side to save tokens.

## Architecture

```
app/
  page.tsx                     # main page: inventory + receipt import
  api/process-receipt/route.ts # server route calling Claude (claude-opus-4-8)
components/
  InventoryTable.tsx           # table, search/sort, add form, CSV import/export
  ReceiptImport.tsx            # upload, extraction preview, import to DB
lib/
  supabase.ts                  # lazy browser client
  materials.ts                 # CRUD against the materials table
  types.ts                     # shared types
supabase/migrations/           # schema
```

Receipt extraction uses the Anthropic structured outputs API (`client.messages.parse` with a Zod schema), so results arrive as validated JSON — no text-format parsing.
