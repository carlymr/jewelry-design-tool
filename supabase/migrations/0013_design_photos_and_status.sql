-- Finished-piece photos and listing status on designs (GRA-38, with the
-- status slice of GRA-43).
--
-- `photo_paths` is an ordered list of objects in the `design-photos` bucket
-- (first = primary). The photos ground listing generation and are kept, not
-- transient: they are also what the Etsy listing will use. `status` tracks a
-- piece from design through sale; `etsy_listing_url` links a listed piece.
--
-- Additive only, so it can be applied before or after the code deploys; the
-- old client ignores the new columns and the defaults cover its inserts.

alter table public.designs
  add column if not exists photo_paths text[] not null default '{}',
  add column if not exists status text not null default 'design',
  add column if not exists etsy_listing_url text;

alter table public.designs drop constraint if exists designs_status_check;
alter table public.designs
  add constraint designs_status_check
  check (status in ('design', 'finished', 'listed', 'sold'));

-- Private, image-only bucket. Paths are {user_id}/{design_id}/{uuid}.{ext},
-- and every policy checks the first path segment against the caller, like
-- `receipt-archive` (0007) and `receipts` (0011).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'design-photos',
  'design-photos',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "Own design photos select" on storage.objects;
create policy "Own design photos select"
  on storage.objects for select to authenticated
  using (bucket_id = 'design-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Own design photos insert" on storage.objects;
create policy "Own design photos insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'design-photos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Own design photos delete" on storage.objects;
create policy "Own design photos delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'design-photos' and (storage.foldername(name))[1] = auth.uid()::text);
