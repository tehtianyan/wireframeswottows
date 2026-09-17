-- ============================================================
-- Phase 2 — one governance lifecycle for every object type, and the stage
-- config that tells the generic UI what each stage may cite.
--
-- Three concerns:
--   1. Unify the review lifecycle. Phase 1 gave factors
--      draft|submitted|approved|rejected, but syntheses, relationships,
--      insights and recommendations were seeded with a different vocabulary
--      (review|approved|rejected|archived). Two vocabularies would force the
--      generic review mechanism to carry a per-table state map, which is
--      exactly the kind of special-casing this architecture exists to avoid.
--   2. Give every reviewable object the same attribution columns and the same
--      "an approval names its reviewer" constraint that factors already has.
--   3. Declare, in stage config, what each stage's objects may cite. This is
--      what keeps the evidence board generic: it reads `cites` rather than
--      knowing that an insight cites themes and a recommendation cites
--      insights.
-- ============================================================

-- ------------------------------------------------------------
-- 1 + 2. One lifecycle, applied uniformly
-- ------------------------------------------------------------

do $$
declare
  t text;
  old_con text;
  reviewable text[] := array[
    'syntheses', 'factor_relationships', 'insights', 'recommendations'
  ];
begin
  foreach t in array reviewable loop
    -- These tables were renamed by the engine migration, but Postgres keeps a
    -- constraint's ORIGINAL name across a table rename: syntheses still
    -- carries "themes_state_check". Drop by discovered name rather than by an
    -- assumed one, or the old constraint silently survives and rejects the
    -- new vocabulary.
    for old_con in
      select conname from pg_constraint
      where conrelid = format('public.%I', t)::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%state%'
    loop
      execute format('alter table public.%I drop constraint %I', t, old_con);
    end loop;

    -- Attribution columns, matching factors.
    execute format(
      'alter table public.%I
         add column if not exists reviewed_by uuid references public.profiles(id),
         add column if not exists reviewed_at timestamptz,
         add column if not exists review_note text', t);

    -- Migrate the old vocabulary onto the shared one before constraining.
    execute format('update public.%I set state = ''submitted'' where state = ''review''', t);
    execute format(
      'update public.%I set state = ''submitted''
        where state is null
           or state not in (''draft'',''submitted'',''approved'',''rejected'',''archived'')', t);

    execute format(
      'alter table public.%I add constraint %I
         check (state in (''draft'',''submitted'',''approved'',''rejected'',''archived''))',
      t, t || '_state_check');

    -- A decision must name the person who made it. App Spec §12.19: AI never
    -- approves. Enforced in the database, not only in a handler.
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_review_attribution_check');
    execute format(
      'alter table public.%I add constraint %I
         check (state not in (''approved'',''rejected'')
                or (reviewed_by is not null and reviewed_at is not null))',
      t, t || '_review_attribution_check');

    execute format('create index if not exists %I on public.%I (workshop_id, state)',
      'idx_' || t || '_workshop_state', t);
  end loop;
end $$;

-- Factors join the same five-state lifecycle by gaining `archived`; their
-- attribution columns and constraint already exist from Phase 1.
alter table public.factors drop constraint if exists factors_state_check;
alter table public.factors add constraint factors_state_check
  check (state in ('draft', 'submitted', 'approved', 'rejected', 'archived'));

-- ------------------------------------------------------------
-- 3. Stage config: what each stage's objects may cite
--
-- Vocabulary: factor | synthesis | factor_relationship | insight.
-- A `synthesize` stage declares what it groups; `interpret` and `recommend`
-- declare what their objects may cite as evidence. The UI reads these instead
-- of knowing anything about SWOT-TOWS.
-- ------------------------------------------------------------

update public.methodology_stages ms
set config = ms.config || '{"groups":"factor"}'::jsonb
where ms.stage_type = 'synthesize'
  and not (ms.config ? 'groups');

update public.methodology_stages ms
set config = ms.config || '{"cites":["synthesis","factor_relationship"]}'::jsonb
from public.methodologies m
where ms.methodology_id = m.id
  and m.key = 'swot-tows'
  and ms.stage_type = 'interpret'
  and not (ms.config ? 'cites');

update public.methodology_stages ms
set config = ms.config || '{"cites":["insight"]}'::jsonb
where ms.stage_type = 'recommend'
  and not (ms.config ? 'cites');

-- ------------------------------------------------------------
-- 4. Extend the PESTLE proof stub across Phase 2's surface.
--
-- Deliberately shaped so a hardcoded implementation would fail:
--   * PESTLE has NO relate stage, so the relationship matrix must simply not
--     exist for it — there is no TOWS-shaped hole to fill.
--   * Its interpret stage cites ONLY syntheses, proving `cites` genuinely
--     drives the evidence board rather than SWOT-TOWS's pairing being assumed.
-- ------------------------------------------------------------

insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.sequence_number, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('pestle_theme_generation', 'Driver Analysis',  8, 'synthesize', '{"groups":"factor"}'),
    ('pestle_insight',          'Implications',     9, 'interpret',  '{"cites":["synthesis"]}')
  ) as v(key, name, sequence_number, stage_type, config)
where m.key = 'pestle'
  and not exists (
    select 1 from public.methodology_stages s
    where s.methodology_id = m.id and s.key = v.key
  );
