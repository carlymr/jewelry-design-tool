-- Orientation of a cabochon's face photo (GRA-15 follow-up).
--
-- `face_rotation` turns the photo clockwise in 90° steps before it is fit to
-- the stone's outline, so a stone photographed long-axis-vertical can be
-- drawn along the board's long axis. Additive: the default covers existing
-- rows and the old client ignores the column.

alter table public.materials
  add column if not exists face_rotation smallint not null default 0;

alter table public.materials drop constraint if exists materials_face_rotation_check;
alter table public.materials
  add constraint materials_face_rotation_check
  check (face_rotation in (0, 90, 180, 270));
