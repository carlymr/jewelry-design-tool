-- Provenance (GRA-30): one `orders` row per receipt, and each material can
-- point at the order it came from plus keep the listing details that
-- identify it (`source` jsonb: listing_title, variation, line_price, page).
-- Receipts are archived in a second, owner-scoped bucket; the `receipts`
-- bucket stays transient (see CLAUDE.md).

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  platform text not null,
  seller text not null default '',
  order_number text not null,
  order_date date,
  total numeric(10, 2),
  receipt_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Re-uploading a receipt updates its order instead of creating a twin.
  unique (user_id, platform, order_number)
);

alter table public.orders enable row level security;
create policy "Own orders"
  on public.orders
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.materials
  add column order_id uuid references public.orders (id) on delete set null,
  add column source jsonb;
create index materials_order_id_idx on public.materials (order_id);

-- Archive bucket: private, paths are {user_id}/{order_id}.{ext}, and every
-- policy checks the first path segment against the caller.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipt-archive',
  'receipt-archive',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
)
on conflict (id) do nothing;

create policy "Own receipt archive select"
  on storage.objects for select to authenticated
  using (bucket_id = 'receipt-archive' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own receipt archive insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'receipt-archive' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own receipt archive update"
  on storage.objects for update to authenticated
  using (bucket_id = 'receipt-archive' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Own receipt archive delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'receipt-archive' and (storage.foldername(name))[1] = auth.uid()::text);
