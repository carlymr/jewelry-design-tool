# Jewelry Design Tool

A virtual beading board for strung jewelry design, backed by a real materials inventory. Plan a strand element-by-element — beads, chain, clasps, connectors, cabochons — true to scale, with live length, cost, and stock tracking, using materials imported straight from supplier receipts by Claude.

Built with Next.js, Supabase, and the Anthropic API; deploys to Vercel.

## Features

### Design board (home page)

- **True-to-scale strand layout** with an inch ruler and a target-length marker (bracelet and necklace presets from 6" to 20")
- **Zoom modes**: fit-to-screen (default), 1:1 real size, or manual zoom
- **Pattern building**: click materials from the palette to place them, select a run (click / shift-click), then *Repeat ×N* or *Fill to target* to complete the strand; Backspace removes the last-placed element
- **Direct manipulation**: drag an element (or a selected run) to rearrange the strand, click between elements to move the insertion point, and use arrow keys to move it precisely (Shift+arrows to select, Esc to clear)
- **Beyond beads**: chain (placed by the inch), lobster and toggle clasps, jump rings, connectors, and cabochons each render with their own treatment
- **Live totals**: length vs. target, material cost, and "need X, have Y" warnings when a design overdraws inventory
- **Saved designs** with name and target length, persisted to Supabase

### Element visuals

Every placeable material gets a stored visual spec — shape, dimensions along/across the strand, colors, finish, pattern — generated once by Claude and rendered as SVG (beads as filled gemstone silhouettes, metal components as open link-and-wire shapes):

- Receipt-imported beads get **photo-informed** visuals during extraction (color and finish read from the product images on the receipt)
- Everything else (CSV imports, hand-entered items, legacy inventory) is backfilled **from the material name** the first time the design board loads
- A regenerate button on each palette entry re-derives any spec that looks off
- A **camera button** (palette and Inventory) accepts a close-up photo of the actual material and re-derives the spec from what the photo shows — the most accurate option

### Inventory

- Searchable, sortable, paginated table with bead swatches, inline stock editing, and **color family / size filters**
- **Receipt import**: upload a receipt image or PDF; Claude extracts line items — applying discounts, splitting assortments into per-variant entries, estimating bead counts from strand lengths — into an editable preview before importing
- **CSV import/export** compatible with the original artifact tool (`Name, Category, Cost Per Unit, Unit, In Stock`)

### Pricing & listing

- **Cost breakdown from actual designs**: pick a saved design and its exact bead composition (plus manually-added extras like clasps and wire) becomes the materials cost — no re-entry
- **Pricing calculator**: labor hours × hourly rate, overhead %, and markup % produce total cost, selling price, and profit; business-wide rates persist across designs
- **Etsy listing generator**: Claude drafts an SEO title, description, and tags from the real composition, length, and price — fully editable, with copy/download, and saved with the design

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com/dashboard).
2. In the SQL Editor, run migrations `0001` through `0005` in order — **do not run `0006` yet** (see below).
3. From **Project Settings → API**, copy the project URL and publishable key.

> **`0006_user_scoping_lockdown.sql` comes last, after everything else works**: sign in once, backfill any legacy rows to your user id (instructions in the file), then run it — it removes anonymous access. Its `SET NOT NULL` fails loudly if legacy rows were missed, so running it early errors rather than stranding data.
>
> Full first-time order: migrations `0001`–`0005` → env vars → Google sign-in config → run the app and sign in → backfill → `0006`.

### Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** (type: Web application) with the authorized redirect URI `https://<your-project-ref>.supabase.co/auth/v1/callback`.
2. In Supabase → **Authentication → Providers → Google**, enable the provider and paste the client ID and secret.
3. In Supabase → **Authentication → URL Configuration**, set the Site URL to your production URL and add `http://localhost:3000` to the additional redirect URLs for local dev.

### 2. Environment variables

```bash
cp .env.example .env.local
```

| Variable | Where it's used |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser — inventory and design reads/writes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser — same (`sb_publishable_...`; legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` works as a fallback) |
| `ANTHROPIC_API_KEY` | Server only — receipt processing, visual generation, and listing generation routes |

### 3. Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Requires Node 24 (`.nvmrc`).

## Deploy to Vercel

Import the repo at [vercel.com/new](https://vercel.com/new) (or `vercel` from the CLI), add the three environment variables, and deploy — Next.js is auto-detected.

After the first deploy, set the **Site URL** (and redirect URL) in Supabase → **Authentication → URL Configuration** to the assigned Vercel URL — Google sign-in silently fails in production until this matches.

**Note:** receipt files are uploaded directly to a private Supabase Storage bucket (`receipts`) rather than through the API route, sidestepping Vercel's ~4.5MB request-body cap. The route downloads the file server-side, processes it, and deletes it. Files up to 20MB are supported; large photos are downscaled client-side.

## Architecture

```
app/
  page.tsx                     # design board (home)
  inventory/page.tsx           # inventory + receipt import
  pricing/page.tsx             # pricing calculator + listing generator
  api/process-receipt/route.ts # receipt extraction via Claude (+ photo-informed visuals)
  api/generate-visuals/route.ts# name-only visual generation (batch fallback)
  api/generate-listing/route.ts# Etsy listing draft from a design's composition
  api/analyze-photo/route.ts   # photo-accurate visual spec for one material
components/
  DesignBoard.tsx              # strand, ruler, palette, pattern tools, totals
  BeadSwatch.tsx               # SVG renderer for beads + strand components
  InventoryTable.tsx           # table, filters, pagination, CSV import/export
  ReceiptImport.tsx            # upload, extraction preview, import to DB
  PhotoVisualButton.tsx        # camera button: photo → visual spec
  PricingStudio.tsx            # design costs, extras, labor/markup, listing
lib/
  bead-visual.ts               # visual spec schema + color/size helpers
  photo-upload.ts              # shared downscale + transient-upload helpers
  designs.ts / materials.ts    # Supabase CRUD
supabase/migrations/           # schema (materials, receipts bucket, designs)
```

Receipt extraction and visual generation both use the Anthropic structured outputs API (`client.messages.parse` with Zod schemas), so results arrive as validated JSON.
