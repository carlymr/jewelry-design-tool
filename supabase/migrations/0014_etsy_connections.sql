-- Etsy shop connections (GRA-37): one row per user, holding the OAuth tokens
-- the publish route uses to create draft listings.
--
-- The app has no service key, so the API routes read and write this row with
-- the caller's own JWT, which means the browser could read it too. The
-- tokens are therefore stored ENCRYPTED (`tokens` is AES-256-GCM ciphertext
-- of {access_token, refresh_token}, keyed from ETSY_SHARED_SECRET on the
-- server; see lib/etsy-server.ts): the row alone can't act on the shop.
-- Rotating the shared secret invalidates stored tokens, so the user
-- reconnects.

create table if not exists public.etsy_connections (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  etsy_user_id bigint not null,
  shop_id bigint not null,
  tokens text not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists etsy_connections_set_updated_at on public.etsy_connections;
create trigger etsy_connections_set_updated_at
  before update on public.etsy_connections
  for each row execute function public.set_updated_at();

alter table public.etsy_connections enable row level security;
drop policy if exists "Own Etsy connection" on public.etsy_connections;
create policy "Own Etsy connection"
  on public.etsy_connections
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
