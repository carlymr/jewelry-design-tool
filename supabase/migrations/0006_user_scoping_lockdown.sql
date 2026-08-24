-- Final lockdown for per-user scoping (GRA-14). Apply ONLY after every
-- legacy row has been assigned an owner, e.g.:
--   update public.materials set user_id = '<owner-uid>' where user_id is null;
--   update public.designs   set user_id = '<owner-uid>' where user_id is null;
-- Until then this migration stays a file; applying it early hides legacy
-- rows from everyone and blocks the anon-key client.
alter table public.materials alter column user_id set default auth.uid();
alter table public.designs alter column user_id set default auth.uid();
alter table public.materials alter column user_id set not null;
alter table public.designs alter column user_id set not null;

drop policy if exists "Own or legacy materials" on public.materials;
create policy "Own materials"
  on public.materials
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Own or legacy designs" on public.designs;
create policy "Own designs"
  on public.designs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Receipts bucket: signed-in users only (uploads stay transient).
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
