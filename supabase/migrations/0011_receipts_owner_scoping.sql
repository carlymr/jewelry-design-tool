-- Owner-scoped transient uploads (GRA-18). The `receipts` bucket policies
-- from 0006 let any signed-in user read or delete any object in the bucket,
-- so a user who guessed another's upload UUID during the seconds it exists
-- could touch it. Clients now upload to `{auth.uid()}/{uuid}.{ext}` and every
-- policy checks the first path segment against the caller, mirroring the
-- `receipt-archive` policies in 0007.
--
-- DEPLOYMENT ORDER: deploy the code FIRST, then apply this file. The 0006
-- policies already permit the new prefixed paths (they only check
-- bucket_id), so there is no dual-path window: once the new client is live
-- every upload is prefixed, and the API routes accept only the prefixed
-- form. Applying this file before the code ships would break uploads from
-- the old client, whose flat `{uuid}.{ext}` paths have no owner folder.

drop policy if exists "Users can upload receipts" on storage.objects;
create policy "Users can upload receipts"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can read receipts" on storage.objects;
create policy "Users can read receipts"
  on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete receipts" on storage.objects;
create policy "Users can delete receipts"
  on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
