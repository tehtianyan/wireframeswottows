-- Two names for one role is one name too many.
--
-- `profiles.global_role` admitted BOTH 'admin' and 'platform_admin', and the
-- two were not interchangeable:
--
--   requirePlatformAdmin   accepted 'admin' OR 'platform_admin'
--   canManageParticipants  accepted 'admin' only
--
-- while the admin page's per-user dropdown offered "Platform admin" as a third
-- option. So an administrator could hand somebody a role that opened /admin and
-- then refused them every participant action on it — a role that half works,
-- reachable in two clicks, with nothing to explain the refusal.
--
-- The fix is to have ONE name. 'admin' is the name the create-user form already
-- used, the name the participant check already honoured, and the only one in use
-- on either database (dev: one row; production: none).
--
-- There is no verification block at the end on purpose: the constraint below IS
-- the assertion. If any row were left outside the set the ALTER would fail and
-- the runner would not record the file.

update public.profiles
   set global_role = 'admin'
 where global_role = 'platform_admin';

alter table public.profiles drop constraint if exists profiles_global_role_check;

alter table public.profiles
  add constraint profiles_global_role_check
  check (global_role in ('user', 'admin'));
