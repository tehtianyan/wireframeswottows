-- ============================================================
-- An archived workshop is READ-ONLY, enforced by the database
--
-- Archiving freezes a workshop and keeps it listed, so its reports and its
-- knowledge stay available. "Frozen" has to mean frozen, or the badge is
-- decoration: CLAUDE.md's working agreement is to "enforce traceability
-- constraints at the DB level, not just the UI", and the same reasoning applies
-- to a lifecycle state that other states are built on.
--
-- A trigger rather than a check in each handler, because the handlers are not
-- the only writer: the generic object handlers, the weights routes, the AI
-- accept path, "Merge and Fix" and the report builder all mutate these tables,
-- and a rule spread across all of them is a rule that will be missed in the
-- next one. One trigger function covers every path, including the ones nobody
-- has written yet.
--
-- UNARCHIVING is the escape hatch, so this is reversible rather than a
-- one-way door — which is why archiving does not need a confirmation ritual.
-- ============================================================

create or replace function public.refuse_if_workshop_archived()
returns trigger
language plpgsql
as $$
declare
  target uuid;
  archived boolean;
begin
  -- On delete the row is OLD; otherwise NEW. Both carry workshop_id, which is
  -- why every table this guards has that column.
  if tg_op = 'DELETE' then
    target := old.workshop_id;
  else
    target := new.workshop_id;
  end if;

  if target is null then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  select w.status = 'archived' into archived
  from public.workshops w where w.id = target;

  if archived then
    raise exception 'workshop_archived'
      using hint = 'This workshop is archived and read-only. Un-archive it to make changes.';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

comment on function public.refuse_if_workshop_archived() is
  'Refuses any write to a row belonging to an archived workshop. Attached to every workshop-scoped content table; see 20261003120000.';

-- Attached by loop rather than by hand, so a table added later is one line in
-- this list and cannot be half-covered.
do $$
declare t text;
begin
  foreach t in array array[
    'factors', 'syntheses', 'synthesis_factors', 'factor_relationships',
    'insights', 'insight_syntheses', 'insight_factor_relationships',
    'recommendations', 'recommendation_insights',
    'weights', 'votes', 'activities', 'comments', 'actions',
    'board_cleanup_runs', 'board_cleanup_changes'
  ]
  loop
    -- Skip anything not present, so the migration does not depend on every
    -- table in the list having survived every rename.
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'workshop_id'
    ) then
      execute format('drop trigger if exists %I on public.%I', t || '_not_archived', t);
      execute format(
        'create trigger %I before insert or update or delete on public.%I
         for each row execute function public.refuse_if_workshop_archived()',
        t || '_not_archived', t);
    end if;
  end loop;
end $$;

-- Reports are deliberately NOT in that list.
--
-- A published report is already immutable by its own trigger, and archiving a
-- workshop must not prevent a finished report from being read or exported —
-- that is the whole point of keeping an archived workshop listed. Creating a
-- NEW report in an archived workshop is refused in Go instead, where the
-- message can say why.

-- ------------------------------------------------------------
-- Proof that the guard actually bites, rather than trusting the loop above.
-- ------------------------------------------------------------

do $$
declare
  ws uuid;
  prior text;
  blocked boolean := false;
begin
  select id, status into ws, prior from public.workshops
  where exists (select 1 from public.factors f where f.workshop_id = workshops.id)
  limit 1;
  if ws is null then
    raise notice 'no workshop with factors to test the guard against; skipping';
    return;
  end if;

  update public.workshops set status = 'archived', archived_at = now(),
         archived_by = (select created_by from public.workshops where id = ws)
  where id = ws;

  begin
    update public.factors set title = title where workshop_id = ws;
  exception when others then
    blocked := true;
  end;

  update public.workshops set status = prior, archived_at = null, archived_by = null where id = ws;

  if not blocked then
    raise exception 'the archive guard did NOT refuse a write to an archived workshop';
  end if;
end $$;
