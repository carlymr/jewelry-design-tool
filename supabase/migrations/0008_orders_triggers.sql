-- Follow-ups to 0007 raised in review: keep orders.updated_at current like
-- the other tables, and stop a material from pointing at another user's
-- order (the FK only proves the order exists; RLS on orders hides it, but
-- the dangling cross-user reference shouldn't be possible at all).

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create or replace function public.check_material_order_owner()
returns trigger language plpgsql as $$
begin
  if new.order_id is not null and not exists (
    select 1 from public.orders o where o.id = new.order_id and o.user_id = new.user_id
  ) then
    raise exception 'order % does not belong to this user', new.order_id;
  end if;
  return new;
end;
$$;

drop trigger if exists materials_check_order_owner on public.materials;
create trigger materials_check_order_owner
  before insert or update of order_id, user_id on public.materials
  for each row execute function public.check_material_order_owner();
