-- Transition step for per-user scoping (GRA-14). Adds an owner column but
-- keeps legacy (null-owner) rows accessible to the anon-key client, so the
-- already-deployed app keeps working unchanged until 0006 locks things down
-- after the legacy rows are backfilled to their owner.
alter table public.materials add column if not exists user_id uuid references auth.users (id);
alter table public.designs add column if not exists user_id uuid references auth.users (id);
create index if not exists materials_user_idx on public.materials (user_id);
create index if not exists designs_user_idx on public.designs (user_id);

drop policy if exists "Allow all access to materials" on public.materials;
drop policy if exists "Own or legacy materials" on public.materials;
create policy "Own or legacy materials"
  on public.materials
  for all
  using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());

drop policy if exists "Allow all access to designs" on public.designs;
drop policy if exists "Own or legacy designs" on public.designs;
create policy "Own or legacy designs"
  on public.designs
  for all
  using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());
