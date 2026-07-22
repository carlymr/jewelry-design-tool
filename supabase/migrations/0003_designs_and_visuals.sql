-- Bead visual specs (generated once by Claude, rendered forever)
alter table public.materials add column if not exists visual jsonb;

-- Saved strand designs. `beads` is an ordered jsonb array of {material_id}.
create table if not exists public.designs (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled design',
  target_length_mm numeric(8, 2) not null default 177.8,
  beads jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists designs_set_updated_at on public.designs;
create trigger designs_set_updated_at
  before update on public.designs
  for each row execute function public.set_updated_at();

-- RLS: permissive like materials (single-user tool, no auth yet).
alter table public.designs enable row level security;

drop policy if exists "Allow all access to designs" on public.designs;
create policy "Allow all access to designs"
  on public.designs
  for all
  using (true)
  with check (true);
