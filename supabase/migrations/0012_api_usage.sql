-- Per-user rate limiting for the AI routes (GRA-18). Each call to
-- process-receipt / generate-visuals / generate-listing / analyze-photo
-- spends Anthropic budget, so the routes record every call here and refuse
-- once a rolling-hour count is exceeded (limits live in lib/rate-limit.ts).
--
-- The table is reachable ONLY through record_ai_call(): RLS is on with no
-- policies and the function is security definer, so a user cannot read,
-- forge, or reset their own counter. The routes fail open if this function
-- is missing or the call errors, so this file can be applied before or
-- after the code ships.

create table if not exists public.api_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  route text not null,
  created_at timestamptz not null default now()
);
create index if not exists api_usage_user_id_created_at_idx
  on public.api_usage (user_id, created_at);

alter table public.api_usage enable row level security;
-- No policies, and no direct grants either: the function below is the only door.
revoke all on table public.api_usage from anon, authenticated;

-- Records one call for the caller, prunes their rows older than an hour, and
-- returns the caller's counts for the last hour: {"total": n, "route": n}.
create or replace function public.record_ai_call(p_route text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_total integer;
  v_route integer;
begin
  if v_user is null then
    raise exception 'record_ai_call requires an authenticated caller';
  end if;
  if p_route is null or length(p_route) = 0 or length(p_route) > 64 then
    raise exception 'record_ai_call: invalid route';
  end if;

  insert into public.api_usage (user_id, route) values (v_user, p_route);

  delete from public.api_usage
    where user_id = v_user and created_at < now() - interval '1 hour';

  select count(*), count(*) filter (where route = p_route)
    into v_total, v_route
    from public.api_usage
    where user_id = v_user and created_at >= now() - interval '1 hour';

  return jsonb_build_object('total', v_total, 'route', v_route);
end;
$$;

revoke all on function public.record_ai_call(text) from public;
grant execute on function public.record_ai_call(text) to authenticated;
