-- ============================================================
-- SECURITY: any workshop member could promote themselves to facilitator
--
-- Found while building the admin/IAM screens, and CONFIRMED EXPLOITABLE on the
-- development project as a real participant account, through PostgREST, with
-- nothing but the publishable key:
--
--   update workshop_members set role='facilitator' where user_id = me   -> SUCCEEDED
--   delete from workshop_members where user_id = <the facilitator>       -> SUCCEEDED
--
-- Both were reverted immediately. The cause is these four policies, all of
-- which authorise on MEMBERSHIP rather than on ROLE:
--
--   UPDATE to authenticated USING is_workshop_member(workshop_id)
--   DELETE to authenticated USING is_workshop_member(workshop_id)
--   INSERT to authenticated WITH CHECK (is_workshop_member(...) OR is_workspace_member(...))
--
-- "Is a member of this workshop" is the wrong question for a write that
-- CHANGES who the members are and what they may do. A participant who promoted
-- themselves would gain review decisions, report publishing, Merge and Fix and
-- the whole facilitator surface.
--
-- This was reachable in practice, not merely in theory: src/lib/participants.ts
-- updates and deletes workshop_members DIRECTLY through PostgREST, so these
-- policies were the only thing standing in front of it. The UI only showed
-- those controls to a facilitator, which is an affordance, not a boundary.
--
-- THE FIX IS TO REMOVE THE WRITE PATH, NOT TO NARROW IT.
--
-- Tightening the policies to "facilitators only" would have closed this
-- instance while leaving membership writable from the browser, so the next
-- rule anyone wants (don't remove the last facilitator; an invite must also
-- grant workspace access; stamp an audit row) would have to be expressed as
-- SQL policy rather than as code — and anything a policy cannot say would
-- simply go unenforced.
--
-- So writes to workshop_members are now GO-ONLY, like every other mutation in
-- the product. Go connects as `postgres` (rolbypassrls) and is unaffected;
-- pkg/handlers/participants.go enforces the role check, the last-facilitator
-- guard and the audit trail in one place. CLAUDE.md: "Go is the trust
-- boundary." This brings membership back inside it.
--
-- SELECT is deliberately kept: public.workshop_roster is a security_invoker
-- view the Participants panel reads directly, and a member seeing who else is
-- in the room is the intended behaviour.
-- ============================================================

drop policy if exists "Workshop members can add workshop members" on public.workshop_members;
drop policy if exists "Workshop members can update workshop members" on public.workshop_members;
drop policy if exists "Workshop members can delete workshop members" on public.workshop_members;

-- Drop by discovered name as well: Postgres keeps a policy's ORIGINAL name
-- across table renames, and these predate the generic-engine rename, so the
-- literal names above are not guaranteed to match what is actually there.
do $$
declare p record;
begin
  for p in
    select policyname, cmd from pg_policies
    where schemaname = 'public' and tablename = 'workshop_members'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy %I on public.workshop_members', p.policyname);
  end loop;
end $$;

-- With RLS enabled and no write policy, PostgREST refuses every client write.
-- Asserted rather than assumed, because "I dropped the policies" and "no client
-- can write" are different claims.
do $$
declare n int;
begin
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename = 'workshop_members'
    and cmd in ('INSERT', 'UPDATE', 'DELETE');
  if n <> 0 then
    raise exception 'workshop_members still has % client write policy/policies', n;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.workshop_members'::regclass) then
    raise exception 'workshop_members has RLS disabled, so dropping policies changes nothing';
  end if;
end $$;

comment on table public.workshop_members is
  'Workshop membership and role. WRITES ARE GO-ONLY: RLS carries a SELECT policy and no write policy on purpose, because authorising a membership change needs a role check, a last-facilitator guard and an audit row — see pkg/handlers/participants.go. Do not add an INSERT/UPDATE/DELETE policy here.';

-- ------------------------------------------------------------
-- Archiving a workshop (App Spec: Draft -> ... -> Completed -> Archived)
--
-- `archived` was already legal in the status CHECK and had no way to be
-- reached. Archiving freezes the workshop read-only and keeps it listed, so its
-- reports and knowledge stay available — the decision being that archiving is
-- for finishing with a workshop, not for hiding it from organisational memory.
--
-- The timestamps are columns rather than inferred from audit_events, because
-- "when was this archived, and by whom" is shown on the workshop itself and
-- should not depend on the audit table still holding that row.
-- ------------------------------------------------------------

alter table public.workshops
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id);

-- Same attribution rule as every other decision in the system.
alter table public.workshops drop constraint if exists workshops_archive_attribution_check;
alter table public.workshops add constraint workshops_archive_attribution_check
  check (archived_at is null or archived_by is not null);

-- And the pair cannot drift from the status: an archived workshop names when it
-- happened, and a live one carries no archive stamp.
alter table public.workshops drop constraint if exists workshops_archived_status_check;
alter table public.workshops add constraint workshops_archived_status_check
  check ((status = 'archived') = (archived_at is not null));

comment on column public.workshops.archived_at is
  'Set when the workshop is archived (read-only). Kept in step with status by workshops_archived_status_check.';
