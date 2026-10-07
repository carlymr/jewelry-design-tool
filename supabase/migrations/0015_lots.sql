-- Lots (GRA-36): a receipt line whose contents can't be itemized from the
-- receipt — a pound of mixed jaspers, a carat-weight parcel of uncounted
-- cabochons, a "random assortment" strand. Guessing variants or a count
-- silently breaks stock and pricing, so such a line is imported as one
-- `materials` row flagged `is_lot`, carrying the order provenance like any
-- other import but never offered on the board. Later, once the bag has been
-- opened and sorted, the owner specifies materials OUT of it ("this lot had
-- 10 × 8 mm picture jasper rounds"): ordinary rows whose `lot_id` points at
-- the lot and whose `lot_cost` is the slice of the lot's price they took.
-- The lot's price minus the sum of its items' `lot_cost` is what remains
-- unallocated — most of a mixed bag never gets itemized, and that's fine.
--
-- Lots stay `materials` rows (rather than a table of their own) so the
-- receipt import, re-upload matching, order provenance, source panel and
-- detail modal all apply to them unchanged. A lot's own quantity/unit/
-- unit_cost describe the parcel as sold (300 carat @ $0.15, or 1 lot @ $20),
-- so quantity × unit_cost is always the lot's price.
--
-- Additive only: the old client ignores the columns and the defaults cover
-- its inserts, so this can be applied before or after the code deploys.

alter table public.materials
  add column if not exists is_lot boolean not null default false,
  add column if not exists lot_id uuid references public.materials (id) on delete set null,
  add column if not exists lot_cost numeric(10, 2);

create index if not exists materials_lot_id_idx on public.materials (lot_id);

-- The FK only proves the lot row exists; RLS hides other users' rows but
-- shouldn't be the only thing stopping a cross-user reference (same idea as
-- materials_check_order_owner in 0008). The target must also actually be a
-- lot, and a row can't be its own lot.
create or replace function public.check_material_lot()
returns trigger language plpgsql as $$
begin
  if new.lot_id is not null then
    if new.lot_id = new.id then
      raise exception 'a material cannot be specified from itself';
    end if;
    if not exists (
      select 1 from public.materials l
      where l.id = new.lot_id and l.user_id = new.user_id and l.is_lot
    ) then
      raise exception 'lot % does not belong to this user or is not a lot', new.lot_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists materials_check_lot on public.materials;
create trigger materials_check_lot
  before insert or update of lot_id, user_id on public.materials
  for each row execute function public.check_material_lot();
