-- Business-wide pricing/listing settings (hourly rate, overhead, markup,
-- style guidelines, listing templates) move from localStorage into the DB so
-- they follow the account across browsers. One row per user; `pricing` holds
-- the Settings blob from components/PricingStudio.tsx verbatim (values stay
-- strings — they mirror input fields). localStorage remains a local cache and
-- offline fallback; lib/settings.ts is the accessor.
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade
    default auth.uid(),
  pricing jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;

drop policy if exists "Own settings" on public.user_settings;
create policy "Own settings"
  on public.user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
