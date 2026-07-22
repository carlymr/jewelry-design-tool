-- Materials inventory table
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Other',
  unit_cost numeric(12, 4) not null default 0,
  quantity numeric(12, 2) not null default 0,
  unit_type text not null default 'piece',
  supplier text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists materials_name_idx on public.materials using gin (to_tsvector('english', name));
create index if not exists materials_category_idx on public.materials (category);

-- Keep updated_at current
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists materials_set_updated_at on public.materials;
create trigger materials_set_updated_at
  before update on public.materials
  for each row execute function public.set_updated_at();

-- RLS: enabled with permissive anon access for now (single-user tool).
-- Tighten these policies when auth is added.
alter table public.materials enable row level security;

drop policy if exists "Allow all access to materials" on public.materials;
create policy "Allow all access to materials"
  on public.materials
  for all
  using (true)
  with check (true);
