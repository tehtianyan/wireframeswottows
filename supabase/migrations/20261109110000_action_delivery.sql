-- Deploy 2 of the TOWS change: the tidy-up reaches actions, and the Reporting
-- stage grows a delivery board that exports to Jira.
--
-- THREE STATEMENTS, AND TWO OF THEM ARE CONFIG.
--
--   1. `recommendations.delivery_state` — where an action sits on the
--      delivery board. A column, because it is per-action state.
--   2. `board_cleanup_changes` learns a second subject, so "Deduplicate and
--      Fix" can tidy actions the way it tidies notes.
--   3. The Reporting stage declares a delivery board; a changeset prompt for
--      the relate stage gives the matrix its tidy-up button. Both are jsonb
--      and rows — no methodology gains either without asking.
--
-- THE COLUMN HAS NO CHECK CONSTRAINT, AND THAT IS DELIBERATE. The states are
-- CONFIGURATION — `To Do / In Progress / Done` are three names in the report
-- stage's jsonb, not a vocabulary the platform owns. A CHECK enumerating them
-- would be the fifth hardcoded enum this schema has had to remove
-- (`reports.report_type`, `narratives.narrative_type`, `ai_outputs.output_type`
-- and the factor-category enum were the first four). Go validates the value
-- against the stage's own declared list, which is where the list lives.
--
-- NULL IS A REAL AND USEFUL VALUE: an action nobody has placed yet sits in the
-- FIRST declared state. So there is no backfill, and adding or renaming a
-- state later cannot orphan a row into a column that no longer exists.

-- ------------------------------------------------------------
-- 1. Where an action sits on the delivery board
-- ------------------------------------------------------------

alter table public.recommendations
  add column if not exists delivery_state text;

comment on column public.recommendations.delivery_state is
  'Delivery board column key, validated against the report stage''s configured state list. NULL means the first declared state. Deliberately unconstrained at the database level: the vocabulary is methodology configuration.';

create index if not exists recommendations_delivery_idx
  on public.recommendations (workshop_id, delivery_state);

-- ------------------------------------------------------------
-- 2. The tidy-up learns a second subject
-- ------------------------------------------------------------
--
-- TWO TYPED COLUMNS WITH A FOREIGN KEY EACH, not one polymorphic `object_id`.
--
-- `weights.object_id` carries no FK on purpose, and the cost is stated there:
-- the cascade has to be re-implemented in every handler that deletes an
-- object, and one that forgets leaves orphans. That trade is worth it for
-- weights, which must serve every kind in the registry. It is not worth it
-- here: a CLEANABLE kind is a platform addition, the same cost as a new object
-- kind, so there will never be many — and "exactly one of these two is set"
-- is a thing a CHECK can say, where "object_id points at a real row" is not.
--
-- So deleting an action takes its cleanup history with it, by the database,
-- and no Go handler has to remember.

alter table public.board_cleanup_changes
  alter column factor_id drop not null;

alter table public.board_cleanup_changes
  add column if not exists recommendation_id uuid
    references public.recommendations(id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'board_cleanup_changes_one_subject_check'
  ) then
    alter table public.board_cleanup_changes
      add constraint board_cleanup_changes_one_subject_check
      check ((factor_id is not null)::int + (recommendation_id is not null)::int = 1);
  end if;
end $$;

create index if not exists board_cleanup_changes_recommendation_idx
  on public.board_cleanup_changes (recommendation_id)
  where recommendation_id is not null;

-- `change_type` keeps its three values. An action's "move" changes which
-- initiative holds it rather than which category, which is a different
-- before-state payload for the same kind of edit — the payload has always
-- varied by type, so the vocabulary does not need to grow.

-- An initiative is an object kind like any other, so a report section may list
-- its items. The CHECK predates the kind and would have refused it — the gap
-- contradicts the claim that "a sixth object kind becomes reportable for free".
alter table public.report_section_items
  drop constraint if exists report_section_items_kind_check;
alter table public.report_section_items
  add constraint report_section_items_kind_check check (object_kind in
    ('factor','synthesis','factor_relationship','initiative','insight','recommendation'));

-- ------------------------------------------------------------
-- 3a. The Reporting stage declares a delivery board
-- ------------------------------------------------------------
--
-- Opted into the same way the matrix opted into its axis layout and the
-- capture board into its wall: a key in the stage's own config. The other six
-- methodologies have report stages, declare nothing, and get no board.
--
-- `states[0]` is where an unplaced action sits — stated here so the order of
-- this array is meaningful rather than incidental.
--
-- The names are "To Do", "In Progress" and "Done" because those are the
-- columns the room asked for AND the three statuses in Jira's default
-- workflow, which is what makes the export land without a mapping step. They
-- are still only names in a jsonb array; a methodology that calls them
-- something else exports those words and maps them in Jira's own importer.

update public.methodology_stages ms
   set config = ms.config || jsonb_build_object(
         'delivery', jsonb_build_object(
           'kind',       'recommendation',
           'label',      'Delivery board',
           'item_label', 'Action',
           'group_kind', 'initiative',
           'states', jsonb_build_array(
             jsonb_build_object('key', 'todo',        'name', 'To Do'),
             jsonb_build_object('key', 'in_progress', 'name', 'In Progress'),
             jsonb_build_object('key', 'done',        'name', 'Done')
           ),
           'exports', jsonb_build_array('jira')
         )
       )
 where ms.key = 'reporting'
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- ------------------------------------------------------------
-- 3b. A changeset prompt for the relate stage
-- ------------------------------------------------------------
--
-- WHY A NEW FUNCTION KEY RATHER THAN A SECOND `board_cleanup` ROW:
-- `methodology_ai_prompts` is unique on (methodology_id, function_key), so one
-- methodology cannot hold two prompts under that key — and widening the
-- constraint would make `resolvePrompt`'s stage-then-global fallback ambiguous
-- for every other function.
--
-- Nothing in Go names either key. The tidy-up is offered wherever the
-- methodology has a `changeset` prompt whose stage type matches the stage, so
-- this row IS the opt-in, exactly as `board_cleanup` is for the capture board.
--
-- `applies_to` NAMES WHAT IT EDITS, and Go refuses a changeset prompt that
-- declares nothing. A function that cannot say what it operates on is the same
-- silent no-op as `scope='object'` with an empty `applies_to`, which a CHECK
-- already makes unrepresentable.

insert into public.methodology_ai_prompts
  (methodology_id, function_key, stage_type, name, prompt_template, output_schema,
   prompt_version, output_kind, scope, applies_to)
select m.id, 'action_cleanup', 'relate', 'Deduplicate and Fix',
  'You are tidying the list of actions agreed in the workshop "{{workshop_name}}" (objective: {{workshop_objective}}), run under the {{methodology_name}} methodology.'
  || E'\n\nEach action sits under an initiative — a heading that groups the actions belonging to it. Propose edits so the list reads cleanly to somebody who was not in the room. You may:'
  || E'\n  * "reword" — fix spelling and grammar, and rewrite an action that is vague so it states one thing somebody could actually be asked to do.'
  || E'\n  * "move" — put an action under the initiative it actually belongs to, naming that initiative with the group_key supplied in the context.'
  || E'\n  * "merge" — fold an action into another that asks for the same work. Name the one to remove as object_id and the one to keep as into_object_id.'
  || E'\n\nRules:'
  || E'\n  * For a "reword", always give the new title. Give "description" ONLY if you are changing it — leaving it out keeps the action''s existing description.'
  || E'\n  * Use ONLY the supplied actions, initiatives and their ids. Never invent one.'
  || E'\n  * An action is a piece of work, so keep its title an instruction. Do not turn it into a topic.'
  || E'\n  * Never change what an action ASKS FOR while fixing how it reads. If you cannot tell, leave it alone.'
  || E'\n  * Two actions under different initiatives can be genuine duplicates — the same work written down twice in two quadrants. Those are worth merging. Two that sound similar but ask for different work are not.'
  || E'\n  * Propose nothing for an action that is already clear. A short changeset is a good outcome.'
  || E'\n  * Give at most one change per action. You may, however, reword an action AND merge a duplicate into that same action.'
  || E'\n  * Do not chain merges: an action you merge something into must not itself be merged away.'
  || E'\n  * In "reason", say plainly what was wrong, in one short sentence a facilitator can check at a glance.',
  '{"changes":[{"type":"reword","object_id":"","title":"","description":"","reason":""},{"type":"move","object_id":"","group_key":"","reason":""},{"type":"merge","object_id":"","into_object_id":"","reason":""}]}'::jsonb,
  'v1.0', 'changeset', 'stage', array['recommendation']
from public.methodologies m
where m.key = 'swot-tows'
on conflict (methodology_id, function_key) do update set
  stage_type      = excluded.stage_type,
  name            = excluded.name,
  prompt_template = excluded.prompt_template,
  output_schema   = excluded.output_schema,
  prompt_version  = excluded.prompt_version,
  output_kind     = excluded.output_kind,
  scope           = excluded.scope,
  applies_to      = excluded.applies_to;

-- The capture board's own changeset prompt predates `applies_to` and declares
-- nothing, so Go would now refuse it. Stated rather than defaulted: "a prompt
-- with no subject means factors" is exactly the kind of assumption that makes
-- the next subject silently wrong.
update public.methodology_ai_prompts
   set applies_to = array['factor']
 where function_key = 'board_cleanup'
   and (applies_to is null or cardinality(applies_to) = 0);

-- ------------------------------------------------------------
-- 4. Verify, rather than trust the statements above
-- ------------------------------------------------------------

do $$
declare
  mid uuid;
  cfg jsonb;
  n int;
begin
  select id into mid from public.methodologies where key = 'swot-tows';

  -- The column exists and is unconstrained.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'recommendations'
       and column_name = 'delivery_state'
  ) then
    raise exception 'recommendations.delivery_state was not added';
  end if;
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.recommendations'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%delivery_state%'
  ) then
    raise exception 'delivery_state has a CHECK constraint — the state list is configuration, not a database enum';
  end if;

  -- Exactly one subject per cleanup change, enforced by the database.
  if not exists (
    select 1 from pg_constraint where conname = 'board_cleanup_changes_one_subject_check'
  ) then
    raise exception 'board_cleanup_changes_one_subject_check is missing';
  end if;
  if exists (
    select 1 from public.board_cleanup_changes
     where (factor_id is null) = (recommendation_id is null)
  ) then
    raise exception 'a cleanup change names no subject, or two';
  end if;

  -- The delivery board, with its three states in order.
  select config -> 'delivery' into cfg
    from public.methodology_stages
   where methodology_id = mid and key = 'reporting';
  if cfg is null then
    raise exception 'the reporting stage declares no delivery board';
  end if;
  if cfg ->> 'kind' <> 'recommendation'
     or jsonb_array_length(cfg -> 'states') <> 3
     or cfg -> 'states' -> 0 ->> 'key' <> 'todo'
     or cfg -> 'states' -> 2 ->> 'name' <> 'Done'
     or not (cfg -> 'exports' ? 'jira') then
    raise exception 'the delivery board config is not the shape the handler reads: %', cfg;
  end if;

  -- Every changeset prompt says what it edits, or the feature is a no-op.
  select count(*) into n from public.methodology_ai_prompts
   where output_kind = 'changeset'
     and (applies_to is null or cardinality(applies_to) = 0);
  if n > 0 then
    raise exception '% changeset prompt(s) declare no applies_to', n;
  end if;

  -- The relate stage can now be tidied, and the capture stage still can.
  if not exists (
    select 1 from public.methodology_ai_prompts
     where methodology_id = mid and output_kind = 'changeset' and stage_type = 'relate'
  ) then
    raise exception 'no changeset prompt for the relate stage';
  end if;
  if not exists (
    select 1 from public.methodology_ai_prompts
     where methodology_id = mid and output_kind = 'changeset' and stage_type = 'capture'
  ) then
    raise exception 'the capture board lost its tidy-up';
  end if;

  -- AND NOTHING LEAKED. The genericity claim is the one this repo keeps
  -- having to defend, so the migration asserts it rather than the suite alone.
  select count(*) into n
    from public.methodology_stages s
    join public.methodologies m2 on m2.id = s.methodology_id
   where m2.key <> 'swot-tows' and s.config ? 'delivery';
  if n > 0 then
    raise exception '% other methodology stage(s) gained a delivery board', n;
  end if;

  select count(*) into n
    from public.methodology_ai_prompts p
    join public.methodologies m2 on m2.id = p.methodology_id
   where m2.key <> 'swot-tows' and p.function_key = 'action_cleanup';
  if n > 0 then
    raise exception '% other methodology(ies) gained an action tidy-up', n;
  end if;

  raise notice 'action delivery + action cleanup verified';
end $$;
