-- The TOWS matrix becomes the place the room decides what to DO
-- =============================================================
--
-- UAT supplied a worked TOWS slide and a workshop sequence to go with it:
--
--   a. pair themes up in the SO quadrant
--   b. enter the actions that pairing suggests, for SO as a whole
--   c. tidy them up (deduplicate and fix)        <- a later migration
--   d. prioritise them
--   e. then the same for WO, ST, WT
--
-- Everything the room produces therefore lands on ONE screen, and the separate
-- Recommendations stage stops being a step in the participant flow.
--
-- WHAT THIS MIGRATION DOES NOT DO IS INVENT A VOCABULARY FOR SWOT-TOWS.
-- The 3x3 layout in the mockup — strengths and weaknesses across the top,
-- opportunities and threats down the side, four quadrants in the middle — is
-- already derivable from data that has been in `methodology_relationship_types`
-- since Phase 0: every row carries `source_category_id` and
-- `target_category_id`, so the distinct sources ARE the columns and the
-- distinct targets ARE the rows. The grid is a pivot of rows this table
-- already holds, which is why no column is added to it here and why the client
-- can draw the same grid for any methodology whose relationship types happen to
-- form a complete cross-product.
--
-- What IS new is structural, and so it is declared rather than assumed:
--
--   1. `public.initiatives` — a fifth reviewable object kind. In the mockup
--      each quadrant's actions sit under recurring bold headings ("INVEST IN
--      PARTNERS", "BUILD OUT NEW FOCUSSED SALES CAMPAIGNS"). Those headings
--      are the unit a sponsor funds, so they are an object with a lifecycle,
--      not a text label on a child row.
--
--      ONE INITIATIVE PER QUADRANT (decided with the user, 2026-11-09). The
--      same NAME may appear in SO and in WO, and those are two initiatives.
--      The alternative — one workshop-wide initiative appearing in several
--      quadrants — was considered and declined: it makes an initiative's
--      membership a many-to-many and leaves "which quadrant produced this"
--      unanswerable, which is the question the matrix exists to answer.
--
--   2. `recommendations.initiative_id` — an action belongs to exactly one
--      initiative. A COLUMN, not a link table, because this is containment
--      and not citation. The distinction is load-bearing: `cites` is evidence
--      (many-to-many, traceability) and a parent is structure (one-to-many).
--      Nullable, because the other seven methodologies group nothing.
--
--   3. `recommendations.board_position` — the facilitator's hand-set order.
--
--      THIS ONE DELIBERATELY BREAKS THE RULE `factors.board_position` FOLLOWS,
--      and the break is the decision rather than an oversight. On the capture
--      board an arrangement is visual tidying, so CLAUDE.md requires that it
--      never outrank the group's votes. Here the user asked for the opposite
--      and gave the reason: the facilitator drags to rank "even if it disagrees
--      with the aggregated ranking during a live discussion". Ranking actions
--      in front of the room IS the prioritisation decision, made by a named
--      person who can be asked why.
--      So BOTH numbers stay visible — the rank is the order, the 1-5 average
--      rides on the card beside it — and a disagreement between them is shown
--      rather than resolved. A single number here would hide exactly the
--      moment this screen exists to make visible.
--
--   4. `action_priority` — participants rate an action 1-5, averaged. Needs no
--      Go whatsoever: `PUT /workshops/{id}/{kind}/{objectId}/weights/{key}`
--      has resolved any registry kind since the weights package replaced
--      voting. PARTICIPANTS ONLY, following `theme_priority` and App Spec
--      §3.23 — the facilitator runs the room, and their own rating averaged in
--      with everybody else's would quietly count twice, once as a rating and
--      again as the hand that sets the order.
--
--   5. Stage config, which is how all of the above reaches ONE methodology.
--      PESTLE, Porter, Capability, Operating Model, Risk, Business Model
--      Canvas and Transformation Planning declare none of it and are
--      untouched — Business Model Canvas and Transformation Planning have
--      relate stages and keep today's flat grid, which is the proof that the
--      new layout is opted into rather than imposed.

-- ------------------------------------------------------------
-- 1. Initiatives — the fifth reviewable object kind
-- ------------------------------------------------------------
--
-- Mirrors the other four object tables exactly: the one governance lifecycle
-- (`draft|submitted|approved|rejected|archived`), the attribution columns, and
-- the "an approval names its reviewer" constraint every other kind carries.
-- Deliberately NOT a reduced copy — a kind that is reviewable in the registry
-- and unreviewable in the schema is the shape of defect this codebase keeps
-- finding.

create table if not exists public.initiatives (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,

  -- The quadrant this initiative belongs to. NOT NULL: an initiative with no
  -- quadrant has nowhere to be drawn, and a row that cannot be rendered is a
  -- row that silently disappears.
  relationship_type_id uuid not null
    references public.methodology_relationship_types(id) on delete cascade,

  title text not null,
  -- Nullable, like `syntheses.description` and for the same reason: the
  -- heading IS the claim, and the cell collects a name in one keystroke.
  -- objects.Kind.DescriptionRequired mirrors this column; see the comment
  -- there about the requirement Go once invented for themes.
  description text,

  -- The facilitator's hand-set order of initiatives within the quadrant.
  board_position integer,

  confidence_score numeric(4,2),
  generated_by text not null default 'human',
  state text not null default 'submitted',
  created_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint initiatives_generated_by_check
    check (generated_by in ('human','ai','hybrid')),
  constraint initiatives_state_check
    check (state in ('draft','submitted','approved','rejected','archived')),
  -- An approval cannot exist without an attributed reviewer. Identical to the
  -- constraint on every other object table; see 20260917100000.
  constraint initiatives_reviewed_attribution_check
    check (state not in ('approved','rejected')
           or (reviewed_by is not null and reviewed_at is not null))
);

create index if not exists initiatives_workshop_idx
  on public.initiatives(workshop_id);
create index if not exists initiatives_relationship_type_idx
  on public.initiatives(relationship_type_id);

alter table public.initiatives enable row level security;

-- Same four policies every object table carries. RLS is the secondary net —
-- Go is the trust boundary and connects as `postgres` (rolbypassrls) — but
-- `public.rls_coverage_gaps` raises on any table in `public` without it, and
-- a table created with RLS off is exactly the gap that produced the
-- `_migrations` finding.
drop policy if exists "Workshop members can view initiatives" on public.initiatives;
create policy "Workshop members can view initiatives" on public.initiatives
  for select to authenticated using (public.is_workshop_member(workshop_id));

drop policy if exists "Workshop members can manage initiatives" on public.initiatives;
create policy "Workshop members can manage initiatives" on public.initiatives
  for insert to authenticated with check (public.is_workshop_member(workshop_id));

drop policy if exists "Workshop members can update initiatives" on public.initiatives;
create policy "Workshop members can update initiatives" on public.initiatives
  for update to authenticated using (public.is_workshop_member(workshop_id));

drop policy if exists "Workshop members can delete initiatives" on public.initiatives;
create policy "Workshop members can delete initiatives" on public.initiatives
  for delete to authenticated using (public.is_workshop_member(workshop_id));

-- An archived workshop is read-only, enforced by a trigger on every
-- workshop-scoped content table rather than by handler checks — the generic
-- object handlers, the weights routes and the AI accept path all write this
-- table, and a rule spread across them is a rule the next one will miss.
drop trigger if exists initiatives_not_archived on public.initiatives;
create trigger initiatives_not_archived
  before insert or update or delete on public.initiatives
  for each row execute function public.refuse_if_workshop_archived();

-- ------------------------------------------------------------
-- 2. An action belongs to an initiative, and carries a rank
-- ------------------------------------------------------------
--
-- `on delete cascade`: deleting an initiative takes its actions with it,
-- which is what "remove this programme" means. The alternative — orphaning
-- them to null — would leave actions in a quadrant under no heading, visible
-- nowhere the cell draws.

alter table public.recommendations
  add column if not exists initiative_id uuid
    references public.initiatives(id) on delete cascade;

alter table public.recommendations
  add column if not exists board_position integer;

create index if not exists recommendations_initiative_idx
  on public.recommendations(initiative_id);

-- ------------------------------------------------------------
-- 3. Participants rate an action 1-5
-- ------------------------------------------------------------
--
-- Configuration only. The scale lives in these columns and nowhere else —
-- a literal 5 in pkg/weights, pkg/handlers/weights.go or WeightControl.tsx is
-- a bug by the rule the weights package was written under.

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step,
   constraint_type, constraint_total, per_participant, aggregate,
   allowed_roles, guidance_text, sort_order)
select
  m.id,
  'action_priority',
  'Action priority',
  'recommendation',
  1, 5, 1,
  'single',
  null,
  true,
  'mean',
  array['participant'],
  'Rate how important this action is, 1 (least) to 5 (most). Everyone''s '
  || 'rating counts once; the group sees the average and how many people rated. '
  || 'The facilitator sets the running order, which may differ — both are shown.',
  2
from public.methodologies m
where m.key = 'swot-tows'
on conflict (methodology_id, key) do update
  set name            = excluded.name,
      applies_to      = excluded.applies_to,
      scale_min       = excluded.scale_min,
      scale_max       = excluded.scale_max,
      scale_step      = excluded.scale_step,
      constraint_type = excluded.constraint_type,
      per_participant = excluded.per_participant,
      aggregate       = excluded.aggregate,
      allowed_roles   = excluded.allowed_roles,
      guidance_text   = excluded.guidance_text,
      sort_order      = excluded.sort_order;

-- ------------------------------------------------------------
-- 4. The relate stage declares the new layout and what it hosts
-- ------------------------------------------------------------
--
-- `layout` follows the precedent the capture board set with `"layout":
-- "board"`: a genuinely different visual form is opted into by config, never
-- inferred, so adding it cannot silently restyle a methodology that did not
-- ask for it.
--
-- `actions` names the registry kinds by key. Nothing in the client may
-- hardcode "recommendation" or "initiative" for this screen; it reads them
-- here, which is what keeps "a methodology is configuration" true of a change
-- this large. `label` and `group_label` are the words on screen — the registry
-- calls the kind a Recommendation because that is what it IS to the platform,
-- and this room calls it an Action.

update public.methodology_stages ms
   set config = ms.config || jsonb_build_object(
         'layout', 'axis',
         'actions', jsonb_build_object(
           'kind',        'recommendation',
           'label',       'Action',
           'group_kind',  'initiative',
           'group_label', 'Initiative',
           'weight',      'action_priority'
         )
       )
 where ms.key = 'tows_analysis'
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- ------------------------------------------------------------
-- 5. Recommendations leaves the participant flow; Reporting is stage 6
-- ------------------------------------------------------------
--
-- NOTHING IS DELETED, and that is load-bearing rather than cautious — the
-- rule the participant-flow migration established three days ago. The
-- Recommendations stage is still READ by things that would break without it:
--
--   * `requireStageForKind` refuses an object whose kind the methodology has
--     no stage for, and an action IS a recommendation. Remove the stage and
--     every action the TOWS cell creates is refused, with a message about a
--     stage nobody can see.
--   * the report's recommendation sections are seeded from its existence.
--
-- It becomes a facilitator's tool: one list of every action in the workshop,
-- across all four quadrants, which is a genuinely useful view and the place to
-- go when the matrix is not the right shape for a question.

update public.methodology_stages ms
   set sequence_number = v.seq
  from (values
    ('strength_discovery',         1),
    ('weakness_discovery',         2),
    ('opportunity_discovery',      3),
    ('threat_discovery',           4),
    ('tows_analysis',              5),
    ('reporting',                  6),
    ('recommendation_generation',  7),
    ('prioritization',             8),
    ('theme_generation',           9),
    ('insight_generation',        10)
  ) as v(key, seq)
 where ms.key = v.key
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- `visible_to_roles` is an AFFORDANCE, not a boundary: the data behind a
-- hidden stage is the participant's own work, and a pasted URL still opens it,
-- which is what lets a facilitator send somebody to a stage when the room
-- needs one. Contrast `workshop_members`, where the write path was REMOVED.
update public.methodology_stages ms
   set config = ms.config || '{"visible_to_roles":["facilitator"]}'::jsonb
 where ms.key = 'recommendation_generation'
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows');

-- `activities.sequence_number` is written at workshop creation and never read
-- back — every reader orders by the stage — but a column that disagrees with
-- its source is a trap for whoever reads it next expecting it to mean
-- something.
update public.activities a
   set sequence_number = ms.sequence_number
  from public.methodology_stages ms
 where ms.id = a.stage_id
   and ms.methodology_id = (select id from public.methodologies where key = 'swot-tows')
   and a.sequence_number <> ms.sequence_number;

-- ------------------------------------------------------------
-- 6. Verify, and RAISE rather than trust the statements above
-- ------------------------------------------------------------
--
-- Each check asks about the RELATIONSHIP rather than restating a literal,
-- which is the lesson from the count assertion that broke when a tenth report
-- section was added. The one exception is the 1-5 scale, which IS the thing
-- being asserted.

do $$
declare
  mid uuid;
  n   int;
  txt text;
begin
  select id into mid from public.methodologies where key = 'swot-tows';
  if mid is null then
    raise exception 'swot-tows methodology not found';
  end if;

  -- (a) The quadrant grid must be derivable, or the client has nothing to
  --     pivot on. This is the claim the whole layout rests on: four
  --     relationship types forming a complete cross-product of 2 sources and
  --     2 targets. If a future edit leaves one with a null category, the
  --     matrix silently loses a row or a column — so it fails here instead.
  select count(*) into n
    from public.methodology_relationship_types
   where methodology_id = mid
     and source_category_id is not null
     and target_category_id is not null;
  if n <> (select count(*) from public.methodology_relationship_types where methodology_id = mid) then
    raise exception 'every swot-tows relationship type must name both categories; % of % do',
      n, (select count(*) from public.methodology_relationship_types where methodology_id = mid);
  end if;

  select count(distinct source_category_id) * count(distinct target_category_id)
    into n
    from public.methodology_relationship_types
   where methodology_id = mid;
  if n <> (select count(*) from public.methodology_relationship_types where methodology_id = mid) then
    raise exception
      'swot-tows relationship types do not form a complete grid: % cells for % sources x % targets',
      (select count(*) from public.methodology_relationship_types where methodology_id = mid),
      (select count(distinct source_category_id) from public.methodology_relationship_types where methodology_id = mid),
      (select count(distinct target_category_id) from public.methodology_relationship_types where methodology_id = mid);
  end if;

  -- (b) The weight, asked about specifically. The participant-flow migration's
  --     own first verification asked "does this methodology have a weight on a
  --     synthesis?" and raised on Porter's Five Forces, which has had one with
  --     a different shape since 2026-09-20. Two unlike weights on one object
  --     kind is the engine being general, so the question has to name the key.
  select count(*) into n
    from public.methodology_weights
   where methodology_id = mid
     and key = 'action_priority'
     and applies_to = 'recommendation'
     and scale_min = 1 and scale_max = 5 and scale_step = 1
     and constraint_type = 'single'
     and per_participant
     and aggregate = 'mean'
     and allowed_roles = array['participant'];
  if n <> 1 then
    raise exception 'action_priority weight not configured as 1-5 mean, participants only (found %)', n;
  end if;

  -- (c) The stage config the client reads. Checked by KEY, because a typo
  --     renders an empty cell rather than an error.
  select count(*) into n
    from public.methodology_stages
   where methodology_id = mid
     and key = 'tows_analysis'
     and config ->> 'layout' = 'axis'
     and config -> 'actions' ->> 'kind' = 'recommendation'
     and config -> 'actions' ->> 'group_kind' = 'initiative'
     and config -> 'actions' ->> 'weight' = 'action_priority';
  if n <> 1 then
    raise exception 'tows_analysis stage is not configured for the axis layout with actions';
  end if;

  -- (d) The participant flow is 1..6 with no gaps, and everything above it is
  --     hidden. Phrased as "every visible stage is in 1..6", so adding a
  --     seventh participant stage later fails loudly instead of appearing
  --     unannounced at the end of somebody's workshop.
  select string_agg(key || '=' || sequence_number, ', ' order by sequence_number)
    into txt
    from public.methodology_stages
   where methodology_id = mid
     and not (config ? 'visible_to_roles')
     and sequence_number not between 1 and 6;
  if txt is not null then
    raise exception 'participant-visible stages outside 1..6: %', txt;
  end if;

  select count(*) into n
    from public.methodology_stages
   where methodology_id = mid and not (config ? 'visible_to_roles');
  if n <> 6 then
    raise exception 'expected 6 participant-visible stages, found %', n;
  end if;

  if not exists (
    select 1 from public.methodology_stages
     where methodology_id = mid and key = 'recommendation_generation'
       and config -> 'visible_to_roles' = '["facilitator"]'::jsonb
  ) then
    raise exception 'the Recommendations stage did not become facilitator-only';
  end if;

  -- The stage must still EXIST, or requireStageForKind refuses every action
  -- the TOWS cell creates. This is the check that catches somebody later
  -- "tidying up" a stage nobody can see.
  if not exists (
    select 1 from public.methodology_stages
     where methodology_id = mid and stage_type = 'recommend'
  ) then
    raise exception 'swot-tows must keep a recommend stage or no action can be created';
  end if;

  -- (e) NOTHING LEAKED. The genericity claim, asserted rather than asserted
  --     about. Seven other methodologies exist and two of them have relate
  --     stages; if either picked up the axis layout, their matrix changed
  --     shape without anybody asking.
  select string_agg(m.key || '/' || ms.key, ', ')
    into txt
    from public.methodology_stages ms
    join public.methodologies m on m.id = ms.methodology_id
   where m.key <> 'swot-tows'
     and (ms.config ? 'actions' or ms.config ->> 'layout' = 'axis');
  if txt is not null then
    raise exception 'the axis layout leaked into other methodologies: %', txt;
  end if;

  select string_agg(m.key, ', ')
    into txt
    from public.methodology_weights w
    join public.methodologies m on m.id = w.methodology_id
   where m.key <> 'swot-tows' and w.key = 'action_priority';
  if txt is not null then
    raise exception 'action_priority leaked into other methodologies: %', txt;
  end if;

  raise notice 'TOWS actions: initiatives table, action_priority weight, axis layout, participant flow 1..6 — all verified';
end $$;
