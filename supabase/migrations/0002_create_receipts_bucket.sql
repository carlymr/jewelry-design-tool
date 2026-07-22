-- Private bucket for receipt uploads. Files are transient: the client uploads,
-- the process-receipt API route downloads and then deletes them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  20971520, -- 20MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

-- Permissive policies for now (single-user tool, consistent with materials RLS).
-- Tighten when auth is added.
drop policy if exists "Anon can upload receipts" on storage.objects;
create policy "Anon can upload receipts"
  on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'receipts');

drop policy if exists "Anon can read receipts" on storage.objects;
create policy "Anon can read receipts"
  on storage.objects for select to anon, authenticated
  using (bucket_id = 'receipts');

drop policy if exists "Anon can delete receipts" on storage.objects;
create policy "Anon can delete receipts"
  on storage.objects for delete to anon, authenticated
  using (bucket_id = 'receipts');
