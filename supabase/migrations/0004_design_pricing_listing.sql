-- Per-design pricing inputs and generated Etsy listing (see lib/types.ts:
-- DesignPricing / DesignListing). Business-wide settings (hourly rate,
-- overhead, markup, style guidelines) live in localStorage, not here.
alter table public.designs add column if not exists pricing jsonb;
alter table public.designs add column if not exists listing jsonb;
