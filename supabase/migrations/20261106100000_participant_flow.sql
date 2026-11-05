-- ============================================================
-- The participant flow: capture, theme and prioritise one category at a time
-- ============================================================
--
-- UAT asked for a flow a room can follow without being taught the
-- methodology: Stage 1 is Strengths, and everything you do to strengths —
-- capture them, group them into themes, rate those themes — happens there
-- before Stage 2 begins. Repeat for weaknesses, opportunities and threats,
-- then the TOWS matrix.
--
-- THIS IS ENTIRELY CONFIGURATION, which is the claim the engine exists to
-- make good on. Three statements below, no new table and no new column:
--
--   1. Stages are RENUMBERED so the participant flow is 1..7.
--   2. Three stages declare `visible_to_roles`, so they leave the navigation
--      for everybody but a facilitator.
--   3. One `methodology_weights` row makes a theme rateable 1-5.
--
-- NOTHING IS DELETED, and that is load-bearing rather than cautious:
--   - `CaptureBoard` offers note-stacking only when the methodology HAS a
--     synthesize stage, so dropping Theme Analysis would silently remove the
--     very feature this change is built around.
--   - The `vote` weight, the report's `prioritized_factors` section and the
--     `prioritization_review` AI prompt are all seeded FROM the existence of a
--     prioritize stage. Removing it would strip a report section and an AI
--     function from a methodology that still wants both.
--   - Recommendations cite insights and nothing else (pkg/objects registry),
--     so an unreachable Insight Generation stage would leave every
--     recommendation citing nothing — against Traceability First. A
--     facilitator keeps it, so the chain survives.
--
-- Hiding is therefore presentational, and only SWOT-TOWS is touched: the other
-- seven methodologies declare no `visible_to_roles` and show every stage, which
-- `tests/suites/genericity.js` asserts.

-- ------------------------------------------------------------
-- 1. Renumber, so the flow a participant sees IS the stored order
-- ------------------------------------------------------------
--
-- The alternative was to keep the canonical methodology order and show
-- participants a computed index, which would have had a facilitator saying
-- "stage 7" while the room read "stage 5" off the same screen. Nothing
-- branches on a particular number — sequence_number is read for ORDER and for
-- DISPLAY only — so the stored order is free to be the order people say out
-- loud.
--
-- The three facilitator-only stages go to the end. They are no longer steps in
-- a sequence; they are tools reached when a facilitator needs one.

update public.methodology_stages ms
   set sequence_number = v.seq
  from (values
    ('strength_discovery',         1),
    ('weakness_discovery',         2),
    ('opportunity_discovery',      3),
    ('threat_discovery',           4),
    ('tows_analysis',              5),
    ('recommendation_generation',  6),
    ('reporting',                  7),
    ('prioritization',             8),
    ('theme_generation',           9),
    ('insight_generation',        10)
  ) as v(key, seq)
 where ms.key = v.key
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- `activities.sequence_number` is written from the stage at workshop creation
-- and then never read back — every reader orders by the stage. Updated anyway,
-- because a column that disagrees with its source is a trap for whoever reads
-- it next expecting it to mean something.
update public.activities a
   set sequence_number = ms.sequence_number
  from public.methodology_stages ms
 where ms.id = a.stage_id
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows')
   and a.sequence_number <> ms.sequence_number;

-- ------------------------------------------------------------
-- 2. Three stages leave the participant's navigation
-- ------------------------------------------------------------
--
-- `visible_to_roles` absent means "everyone", so this is additive and no other
-- methodology changes behaviour. The merge is `config || ...` rather than an
-- assignment: `prioritization` carries `votes_per_participant`, which the
-- `vote` weight's budget was derived from, and overwriting the object would
-- take the budget with it.

update public.methodology_stages ms
   set config = ms.config || '{"visible_to_roles":["facilitator"]}'::jsonb
 where ms.key in ('prioritization', 'theme_generation', 'insight_generation')
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- Theme Analysis declares the weight its objects carry, which is the
-- convention Porter's Five Forces already established for a synthesize stage
-- (`{"groups":"factor","weights":["intensity"]}`). Following it rather than
-- inventing a second mechanism means the capture board can ask one question —
-- "what weights does this methodology's synthesize stage declare?" — and get
-- an answer for any methodology, and that the rating also appears on the
-- Theme Analysis stage itself for the facilitator.

update public.methodology_stages ms
   set config = ms.config || '{"weights":["theme_priority"]}'::jsonb
 where ms.key = 'theme_generation'
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- ------------------------------------------------------------
-- 3. A theme can be rated 1-5
-- ------------------------------------------------------------
--
-- Needs no Go: `PUT /workshops/{id}/syntheses/{id}/weights/{key}` already
-- resolves any object-registry kind, and `aggregate = 'mean'` is already in
-- the CHECK. A weight on a theme was expressible the day the weights package
-- replaced voting; nothing had asked for one until now.
--
-- PARTICIPANTS ONLY. The facilitator runs the room and does not rate, which is
-- the same separation of duties that denies them Curate in App Spec §3.23. A
-- facilitator's own rating averaged in with the room's would quietly carry more
-- weight than anybody else's, because they decide when rating stops.
--
-- `per_participant` with `mean` is what makes the two-numbers rule work here:
-- the screen shows the average AND how many people rated, because "4.5" from
-- two people is not the finding "4.5" from eleven is.

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step,
   constraint_type, constraint_total, per_participant, aggregate, allowed_roles,
   guidance_text, sort_order)
select
  m.id,
  'theme_priority',
  'Theme priority',
  'synthesis',
  1, 5, 1,
  'single',
  null,
  true,
  'mean',
  array['participant'],
  'Rate how much this theme matters to the objective, 1 (least) to 5 (most). '
  || 'Everyone''s rating counts once; the group sees the average and how many people rated.',
  1
from public.methodologies m
where m.key = 'swot-tows'
on conflict (methodology_id, key) do update
  set name           = excluded.name,
      applies_to     = excluded.applies_to,
      scale_min      = excluded.scale_min,
      scale_max      = excluded.scale_max,
      scale_step     = excluded.scale_step,
      constraint_type = excluded.constraint_type,
      per_participant = excluded.per_participant,
      aggregate      = excluded.aggregate,
      allowed_roles  = excluded.allowed_roles,
      guidance_text  = excluded.guidance_text,
      sort_order     = excluded.sort_order,
      updated_at     = now();

-- ------------------------------------------------------------
-- Verify, rather than trust the statements above
-- ------------------------------------------------------------
--
-- Each check RAISES. A migration that reports success while leaving the
-- configuration half-applied is the failure mode this whole file exists inside:
-- the result would be a flow that looks right in the nav and refuses a rating,
-- or a budget silently taken away with a jsonb overwrite.

do $$
declare
  mid        uuid;
  bad        text;
  n          integer;
  budget     numeric;
begin
  select id into mid from public.methodologies where key = 'swot-tows';
  if mid is null then
    raise exception 'swot-tows methodology is missing';
  end if;

  -- The participant flow is exactly 1..7, contiguous and in the stated order.
  select string_agg(key || '=' || sequence_number, ', ' order by sequence_number)
    into bad
    from public.methodology_stages
   where methodology_id = mid
     and not (config ? 'visible_to_roles')
     and sequence_number not between 1 and 7;
  if bad is not null then
    raise exception 'a participant-visible stage is numbered outside 1..7: %', bad;
  end if;

  select count(*) into n
    from public.methodology_stages
   where methodology_id = mid and not (config ? 'visible_to_roles');
  if n <> 7 then
    raise exception 'expected 7 participant-visible stages, found %', n;
  end if;

  select count(*) into n
    from public.methodology_stages
   where methodology_id = mid
     and config -> 'visible_to_roles' = '["facilitator"]'::jsonb;
  if n <> 3 then
    raise exception 'expected 3 facilitator-only stages, found %', n;
  end if;

  -- The vote budget survived the jsonb merge. This is the assertion that
  -- would have caught an assignment where a merge was meant.
  select (config ->> 'votes_per_participant')::numeric into budget
    from public.methodology_stages
   where methodology_id = mid and key = 'prioritization';
  if coalesce(budget, 0) <= 0 then
    raise exception 'prioritization lost its votes_per_participant budget (now %)', budget;
  end if;

  -- The theme weight is rateable by a participant on a real 1-5 scale.
  select count(*) into n
    from public.methodology_weights
   where methodology_id = mid
     and key = 'theme_priority'
     and applies_to = 'synthesis'
     and scale_min = 1 and scale_max = 5 and scale_step = 1
     and constraint_type = 'single'
     and per_participant
     and aggregate = 'mean'
     and allowed_roles = array['participant'];
  if n <> 1 then
    raise exception 'theme_priority weight is not configured as expected';
  end if;

  -- NO OTHER METHODOLOGY MOVED. The genericity claim, asserted here as well as
  -- in tests/suites/genericity.js, because this file is where it could break.
  select string_agg(distinct m.key, ', ')
    into bad
    from public.methodology_stages ms
    join public.methodologies m on m.id = ms.methodology_id
   where ms.methodology_id <> mid
     and ms.config ? 'visible_to_roles';
  if bad is not null then
    raise exception 'visible_to_roles leaked into other methodologies: %', bad;
  end if;

  -- Scoped to THIS weight, not to synthesis weights in general.
  --
  -- The first version of this check asserted that no other methodology had a
  -- weight on a synthesis at all, and it RAISED on the first run: Porter's
  -- Five Forces has carried `intensity` on a force assessment since
  -- 2026-09-20. The assertion was wrong the day it was written, and what it
  -- actually demonstrated is the opposite of a leak — a second methodology
  -- rating a synthesis, with a different shape (one agreed value, latest wins,
  -- facilitator and analyst) to this one (per participant, averaged,
  -- participants only). Two unlike weights on the same object kind is the
  -- genericity claim holding, so the check now asks the question it meant to.
  select string_agg(distinct m.key, ', ')
    into bad
    from public.methodology_weights mw
    join public.methodologies m on m.id = mw.methodology_id
   where mw.methodology_id <> mid
     and mw.key = 'theme_priority';
  if bad is not null then
    raise exception 'theme_priority leaked into other methodologies: %', bad;
  end if;

  -- Theme Analysis declares the weight, or the capture board has nothing to
  -- look up and the rating control silently never renders.
  select count(*) into n
    from public.methodology_stages
   where methodology_id = mid
     and key = 'theme_generation'
     and config -> 'weights' @> '["theme_priority"]'::jsonb;
  if n <> 1 then
    raise exception 'theme_generation does not declare the theme_priority weight';
  end if;
end $$;
