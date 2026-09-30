-- ============================================================
-- Where an AI function BELONGS is configuration, not code
--
-- UAT found that only "Generate Artifact Suggestions" worked in the AI panel.
-- Challenge, Explain Why and Summarize Workshop all called the model happily
-- and returned good output — the panel simply could not render it, and said
-- "The assistant had nothing to add", which was untrue and cost real money to
-- be told.
--
-- Two separate faults, and only one of them was the renderer:
--
-- 1. The panel renders an ARRAY of titled suggestions. `challenge`,
--    `traceability_explanation` and `workshop_summary` all return a single
--    nested OBJECT. `challenge` was additionally mislabelled
--    output_kind = 'suggestions' when its own schema is an object.
--
-- 2. **They were in the wrong place.** App Spec §13.10-13.12 states each
--    function's trigger explicitly, and none of the three is a stage button:
--      §13.10 Workshop Summary  — "from Workshop Overview"
--      §13.11 AI Challenge      — "from an insight or recommendation card"
--      §13.12 Explain Why       — "from an insight, recommendation, or report
--                                  section"
--    A Challenge with no selected object cannot do what its prompt asks
--    ("Selected Object: {{selected_object}}"), so it was never going to work
--    as a panel button however well the output rendered.
--
-- So a prompt now declares its SCOPE, and which object kinds it applies to.
-- The UI reads that instead of assuming every function is a stage action —
-- which keeps placement in config, like everything else about a methodology.
-- ============================================================

-- ------------------------------------------------------------
-- 1. scope + applies_to
-- ------------------------------------------------------------

alter table public.methodology_ai_prompts
  add column if not exists scope text not null default 'stage',
  -- Registry keys (pkg/objects) an `object`-scoped function may run against.
  -- Empty for any other scope.
  add column if not exists applies_to text[] not null default '{}';

alter table public.methodology_ai_prompts drop constraint if exists methodology_ai_prompts_scope_check;
alter table public.methodology_ai_prompts add constraint methodology_ai_prompts_scope_check
  check (scope in ('stage', 'object', 'workshop'));

-- An object-scoped function without applies_to would appear on no card at all,
-- which is the silent-no-op this migration exists to remove.
alter table public.methodology_ai_prompts drop constraint if exists methodology_ai_prompts_applies_to_check;
alter table public.methodology_ai_prompts add constraint methodology_ai_prompts_applies_to_check
  check (scope <> 'object' or cardinality(applies_to) > 0);

comment on column public.methodology_ai_prompts.scope is
  'Where the action is offered: stage (the stage panel), object (a card for one of applies_to), workshop (the overview). App Spec §13.10-13.12 fixes these per function.';

-- ------------------------------------------------------------
-- 2. Re-home the three functions that were in the wrong place
-- ------------------------------------------------------------

update public.methodology_ai_prompts
set scope = 'object',
    applies_to = array['insight', 'recommendation'],
    -- Its schema was always {"challenge": {...}} — an object, not a list of
    -- suggestions. The label said otherwise, so the panel looked for an array
    -- and found none.
    output_kind = 'narrative'
where function_key = 'challenge';

update public.methodology_ai_prompts
set scope = 'object',
    applies_to = array['insight', 'recommendation']
where function_key = 'traceability_explanation';

update public.methodology_ai_prompts
set scope = 'workshop'
where function_key = 'workshop_summary';

-- ------------------------------------------------------------
-- 3. Retire duplicate_detection — superseded by "Merge and Fix"
--
-- §4.11 SWOT Review asks for "Duplicate detection / Merge suggestions /
-- Language normalization". `board_cleanup` does all three, applies them as
-- tracked changes and lets the facilitator undo any of them. Meanwhile
-- duplicate_detection returned {"duplicate_groups": [...]} whose items have no
-- title, so the panel drew "(untitled)" rows whose "Add for review" button
-- would have created a factor out of a duplicate report.
--
-- Two buttons for one job, one of them producing garbage. This removes the
-- one that does not work.
-- ------------------------------------------------------------

delete from public.methodology_ai_prompts where function_key = 'duplicate_detection';

-- ------------------------------------------------------------
-- 4. §4.12 Prioritization — the one genuine gap in §4.8-4.16
--
-- "AI Assistance: Suggest prioritization anomalies. Identify voting patterns."
-- There was no prioritize-stage prompt at all, so the panel offered nothing on
-- that stage beyond the three misplaced global ones.
--
-- Output is a narrative, deliberately: an anomaly is an observation for the
-- facilitator to act on in the room, not an object to create. Nothing here is
-- SWOT-specific — it reads whatever categories and weights the methodology
-- defines, so it serves Five Forces' intensity ratings and ISO 31000's
-- likelihood just as well. It is therefore seeded for EVERY methodology that
-- has a prioritize stage, and for none that does not: Business Model Canvas
-- has no such stage and so is offered no such action.
-- ------------------------------------------------------------

insert into public.methodology_ai_prompts
  (methodology_id, function_key, stage_type, scope, name, prompt_template,
   output_schema, prompt_version, output_kind)
select m.id, 'prioritization_review', 'prioritize', 'stage', 'Review the Prioritization',
  'You are reviewing how a workshop group has prioritised its factors, for the workshop "{{workshop_name}}" (objective: {{workshop_objective}}), run under the {{methodology_name}} methodology.'
  || E'\n\nThe context gives each factor with its category, the total it received and how many people contributed to that total, plus the budget each participant had to spend.'
  || E'\n\nIdentify:'
  || E'\n  * Anomalies — a factor that scores far above or below what its content suggests, a heavily-backed factor that restates something ranked low, or a category the objective clearly depends on that has attracted almost nothing.'
  || E'\n  * Patterns — concentration on a few factors versus a flat spread, a category dominating the total, agreement resting on one or two people rather than the group, unspent budget.'
  || E'\n  * What looks under-discussed relative to the objective.'
  || E'\n\nRules:'
  || E'\n  * Use ONLY the supplied factors and totals. Never invent a factor, a number or a participant.'
  || E'\n  * Say how many people are behind a total before calling it agreement. A high total from one voter is not consensus.'
  || E'\n  * Where no anomaly or pattern is evident, return an empty list rather than manufacturing one.'
  || E'\n  * Name the factors you are talking about, so the facilitator can check you.'
  || E'\n  * Do not tell the group what to prioritise. Point at what is worth a second look and let them decide.',
  '{"analysis":{"anomalies":[],"patterns":[],"under_discussed":[],"questions_for_the_room":[]}}'::jsonb,
  'v1.0', 'narrative'
from public.methodologies m
where exists (
  select 1 from public.methodology_stages s
  where s.methodology_id = m.id and s.stage_type = 'prioritize'
)
on conflict (methodology_id, function_key) do update set
  stage_type      = excluded.stage_type,
  scope           = excluded.scope,
  name            = excluded.name,
  prompt_template = excluded.prompt_template,
  output_schema   = excluded.output_schema,
  prompt_version  = excluded.prompt_version,
  output_kind     = excluded.output_kind;

-- ------------------------------------------------------------
-- 5. Carry scope and applies_to when seeding another methodology
--
-- Without this the seven other methodologies would inherit these prompts with
-- scope defaulted to 'stage' — putting Challenge back on a stage panel, which
-- is the bug being fixed. `applies_to` travels too, so an object action lands
-- on the same cards everywhere.
-- ------------------------------------------------------------

create or replace function public.seed_methodology_ai_prompts(target_key text)
returns integer
language plpgsql
as $$
declare
  target_id uuid;
  source_id uuid;
  inserted integer;
begin
  select id into target_id from public.methodologies where key = target_key;
  if target_id is null then
    raise exception 'seed_methodology_ai_prompts: no methodology with key %', target_key;
  end if;

  -- SWOT-TOWS is the reference set purely because it was configured first and
  -- has one prompt per stage type. Nothing about it is privileged.
  select id into source_id from public.methodologies where key = 'swot-tows';
  if source_id is null then
    raise exception 'seed_methodology_ai_prompts: the reference methodology is missing';
  end if;

  insert into public.methodology_ai_prompts
    (methodology_id, function_key, stage_type, scope, applies_to, name, prompt_template,
     output_schema, prompt_version, output_kind)
  select
    target_id,
    p.function_key,
    p.stage_type,
    p.scope,
    p.applies_to,
    -- "Generate TOWS Relationships" is the one name carrying another
    -- methodology's vocabulary. Nothing else does.
    replace(p.name, 'TOWS ', ''),
    -- The theme prompt warns against generic names by example, and its
    -- examples are SWOT's. Replaced with methodology-neutral ones so no
    -- other methodology's words travel inside a prompt.
    replace(replace(p.prompt_template, '"Strengths"', '"Themes"'), '"Risks"', '"Issues"'),
    p.output_schema,
    p.prompt_version,
    p.output_kind
  from public.methodology_ai_prompts p
  where p.methodology_id = source_id
    -- A prompt with no stage type is not necessarily workshop-wide any more:
    -- scope says where it belongs. Only a STAGE-scoped prompt has to have a
    -- matching stage; object- and workshop-scoped ones always apply.
    and (
      p.scope <> 'stage'
      or coalesce(p.stage_type, '') = ''
      or exists (
        select 1 from public.methodology_stages s
        where s.methodology_id = target_id and s.stage_type = p.stage_type
      )
    )
    -- A changeset applies edits directly and is opted into per methodology,
    -- like the capture board itself. It is not copied by default.
    and p.output_kind <> 'changeset'
  on conflict (methodology_id, function_key) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.seed_methodology_ai_prompts(text) is
  'Copies the stage-type-keyed AI prompts to a methodology, carrying scope and applies_to, and taking only those whose stage type it has. Changesets are opt-in and not copied. Seed-time helper; not called at runtime.';
