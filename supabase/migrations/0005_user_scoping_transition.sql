-- Transition step for per-user scoping (GRA-14). Adds an owner column but
-- keeps legacy (null-owner) rows accessible to the anon-key client, so the
-- already-deployed app keeps working unchanged until 0006 locks things down
-- after the legacy rows are backfilled to their owner.
alter table public.materials add column if not exists user_id uuid references auth.users (id);
alter table public.designs add column if not exists user_id uuid references auth.users (id);
create index if not exists materials_user_idx on public.materials (user_id);
create index if not exists designs_user_idx on public.designs (user_id);

-- Freeze ownership for the whole transition window. RLS with-check clauses
-- only see the NEW row, so a policy alone can't stop a signed-in user from
-- claiming legacy rows (null -> their uid) or releasing their own rows
-- (uid -> null). Dropped again by 0006, whose strict policies make any
-- transfer impossible.
create or replace function public.prevent_user_id_change()
returns trigger as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot be changed';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists materials_freeze_user_id on public.materials;
create trigger materials_freeze_user_id
  before update on public.materials
  for each row execute function public.prevent_user_id_change();

drop trigger if exists designs_freeze_user_id on public.designs;
create trigger designs_freeze_user_id
  before update on public.designs
  for each row execute function public.prevent_user_id_change();

-- Reads/updates/deletes cover own rows plus legacy rows (the anon client's
-- status quo). Inserts must be self-owned; only the anon client may still
-- create ownerless rows, matching the deployed build until auth ships.
drop policy if exists "Allow all access to materials" on public.materials;
drop policy if exists "Own or legacy materials" on public.materials;
drop policy if exists "Read own or legacy materials" on public.materials;
drop policy if exists "Insert own materials" on public.materials;
drop policy if exists "Update own or legacy materials" on public.materials;
drop policy if exists "Delete own or legacy materials" on public.materials;
create policy "Read own or legacy materials"
  on public.materials for select
  using (user_id is null or user_id = auth.uid());
create policy "Insert own materials"
  on public.materials for insert
  with check ((auth.uid() is null and user_id is null) or user_id = auth.uid());
create policy "Update own or legacy materials"
  on public.materials for update
  using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());
create policy "Delete own or legacy materials"
  on public.materials for delete
  using (user_id is null or user_id = auth.uid());

drop policy if exists "Allow all access to designs" on public.designs;
drop policy if exists "Own or legacy designs" on public.designs;
drop policy if exists "Read own or legacy designs" on public.designs;
drop policy if exists "Insert own designs" on public.designs;
drop policy if exists "Update own or legacy designs" on public.designs;
drop policy if exists "Delete own or legacy designs" on public.designs;
create policy "Read own or legacy designs"
  on public.designs for select
  using (user_id is null or user_id = auth.uid());
create policy "Insert own designs"
  on public.designs for insert
  with check ((auth.uid() is null and user_id is null) or user_id = auth.uid());
create policy "Update own or legacy designs"
  on public.designs for update
  using (user_id is null or user_id = auth.uid())
  with check (user_id is null or user_id = auth.uid());
create policy "Delete own or legacy designs"
  on public.designs for delete
  using (user_id is null or user_id = auth.uid());
