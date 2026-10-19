-- Face photos for cabochons (GRA-15).
--
-- `face_path` is an object in the `material-faces` bucket: a close-up of the
-- stone itself, drawn clipped to the cabochon's outline on the board so its
-- real banding, matrix and chatoyancy show instead of a generated pattern.
-- Kept, not transient, and separate from `visual` so a refresh-from-name
-- (which rewrites visual) never drops it.
--
-- Additive only: the old client ignores the column, and the default covers
-- its inserts. Paths are {user_id}/{material_id}/{uuid}.{ext}; every policy
-- checks the first path segment against the caller, like `design-photos`
-- (0013).

alter table public.materials
  add column if not exists face_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'material-faces',
  'material-faces',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "Own material faces select" on storage.objects;
create policy "Own material faces select"
  on storage.objects for select to authenticated
  using (bucket_id = 'material-faces' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Own material faces insert" on storage.objects;
create policy "Own material faces insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'material-faces' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Own material faces delete" on storage.objects;
create policy "Own material faces delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'material-faces' and (storage.foldername(name))[1] = auth.uid()::text);
