-- Final lockdown for per-user scoping (GRA-14). Apply ONLY after every
-- legacy row has been assigned an owner. The full rollout sequence is:
--
--   1. Drop the transition ownership freeze so the backfill can run:
--        drop trigger if exists materials_freeze_user_id on public.materials;
--        drop trigger if exists designs_freeze_user_id on public.designs;
--        drop function if exists public.prevent_user_id_change();
--   2. Backfill:
--        update public.materials set user_id = '<owner-uid>' where user_id is null;
--        update public.designs   set user_id = '<owner-uid>' where user_id is null;
--   3. Apply this file.
--
-- Safety: the SET NOT NULL below fails loudly if any legacy rows were left
-- unbackfilled, so applying this early cannot silently strand data.
drop trigger if exists materials_freeze_user_id on public.materials;
drop trigger if exists designs_freeze_user_id on public.designs;
drop function if exists public.prevent_user_id_change();

alter table public.materials alter column user_id set default auth.uid();
alter table public.designs alter column user_id set default auth.uid();
alter table public.materials alter column user_id set not null;
alter table public.designs alter column user_id set not null;

drop policy if exists "Read own or legacy materials" on public.materials;
drop policy if exists "Insert own materials" on public.materials;
drop policy if exists "Update own or legacy materials" on public.materials;
drop policy if exists "Delete own or legacy materials" on public.materials;
create policy "Own materials"
  on public.materials
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Read own or legacy designs" on public.designs;
drop policy if exists "Insert own designs" on public.designs;
drop policy if exists "Update own or legacy designs" on public.designs;
drop policy if exists "Delete own or legacy designs" on public.designs;
create policy "Own designs"
  on public.designs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Receipts bucket: signed-in users only (uploads stay transient; paths are
-- unguessable UUIDs — per-owner path scoping is a possible follow-up).
drop policy if exists "Anon can upload receipts" on storage.objects;
drop policy if exists "Users can upload receipts" on storage.objects;
create policy "Users can upload receipts"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts');

drop policy if exists "Anon can read receipts" on storage.objects;
drop policy if exists "Users can read receipts" on storage.objects;
create policy "Users can read receipts"
  on storage.objects for select to authenticated
  using (bucket_id = 'receipts');

drop policy if exists "Anon can delete receipts" on storage.objects;
drop policy if exists "Users can delete receipts" on storage.objects;
create policy "Users can delete receipts"
  on storage.objects for delete to authenticated
  using (bucket_id = 'receipts');
