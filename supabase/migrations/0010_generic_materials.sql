-- Generic components (GRA-17): the jump rings, crimps, spacer balls and
-- clasps a maker buys in mixed kits and never counts. They stay real
-- `materials` rows so designs, pricing, replace/mirror mode and the palette
-- keep a single id space — but instead of being imported they are seeded on
-- first use from the built-in catalog in lib/generic-catalog.ts, one row per
-- user per catalog entry. `generic_key` holds that entry's key (null = an
-- ordinary inventory row). Generics carry no stock: `quantity` is stored as
-- 0 and the UI ignores it for them.
alter table public.materials
  add column if not exists generic_key text;

-- One seeded row per user per catalog entry. Not a partial index: the
-- client seeds with `on conflict (user_id, generic_key)`, which can only
-- infer a full unique index; ordinary rows are unaffected because NULL
-- generic_keys never collide.
create unique index if not exists materials_user_generic_key_idx
  on public.materials (user_id, generic_key);
