-- Adds identify-piece (GRA-12) to the routes record_ai_call() accepts. The
-- function body is otherwise unchanged from 0012; re-created here so the
-- migration history shows the change. Before this is applied the route's
-- calls error inside record_ai_call and the route fails open, as designed.

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
  if p_route not in ('process-receipt', 'generate-visuals', 'generate-listing', 'analyze-photo', 'identify-piece') then
    raise exception 'record_ai_call: unknown route %', p_route;
  end if;

  -- Serialize a user's calls so a burst of parallel requests can't each
  -- read the pre-burst count and all slip under the cap.
  perform pg_advisory_xact_lock(hashtext(v_user::text));

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
