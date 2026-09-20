-- ============================================================
-- Weights: the generalisation of voting
--
-- Seven real consulting methodologies were configured against this engine and
-- four of them could not be expressed. Porter's Five Forces rates each force,
-- Capability Assessment rates current and target maturity, ISO 31000 rates
-- likelihood and consequence, and Transformation Planning rates value, effort
-- and wave. Every one needs a NUMBER ATTACHED TO AN OBJECT ON A DEFINED SCALE,
-- and the engine had no way to express that: object fields are Go constants
-- backed by real typed columns (pkg/objects/registry.go), so a methodology
-- could not add one.
--
-- But the engine already had exactly that mechanism, under another name.
-- A vote is a constrained number attached to a factor by a participant. The
-- prioritize stage reads its budget from config; pkg/handlers/votes.go enforces
-- it. Voting was never a primitive — it was one instance of a general idea.
--
--   a vote            = scale 0..unbounded, constraint 'budget' of 20, summed
--                       across participants
--   a maturity score  = scale 1..5 step 1, constraint 'single', one agreed
--                       value per object
--   a percentage      = scale 0..100 step 5
--   a bipolar rating  = scale -3..+3 step 1
--
-- So this migration does not add scoring beside voting. It introduces the
-- general form, and makes voting the first instance of it.
--
-- THE SCALE IS CONFIGURATION, NOT A CONSTANT. `value` is numeric rather than
-- integer and the bounds are columns, because 1-5 is a convention the seven
-- methodologies happen to share, not something the engine may assume. Nothing
-- in Go, React or CSS may contain a literal 5 as a scale bound, a step count or
-- an array length.
--
-- NON-DESTRUCTIVE BY DESIGN: public.votes is copied, not dropped. Go stops
-- writing to it in this release; it is dropped in a later migration once the
-- vote adapters have been proven. Other people are running UAT against the
-- prioritization screens right now.
-- ============================================================

-- ------------------------------------------------------------
-- Config: what weights this methodology defines
--
-- Sits alongside methodology_factor_categories and
-- methodology_relationship_types, and is referenced by key from the values
-- table the same way a stage's config references a category key.
-- ------------------------------------------------------------

create table if not exists public.methodology_weights (
  id uuid primary key default gen_random_uuid(),
  methodology_id uuid not null references public.methodologies(id) on delete cascade,
  key text not null,
  name text not null,
  -- An object registry key: factor | synthesis | factor_relationship |
  -- insight | recommendation. Not constrained by CHECK, because the registry
  -- is a Go constant and a CHECK here would be a second place to edit when a
  -- sixth object kind is added.
  applies_to text not null default 'factor',

  -- The scale. scale_max null means unbounded, which is what a vote is.
  scale_min numeric not null default 0,
  scale_max numeric,
  scale_step numeric not null default 1,
  -- Optional ordinal names, e.g. ISO 31000's Rare .. Almost certain. When
  -- present the array length must equal the number of steps, which is checked
  -- below rather than left to whoever writes the seed.
  scale_labels jsonb,

  -- 'budget': the participant has a pool to spend across objects (voting).
  -- 'single': one value per object per participant, no pool.
  constraint_type text not null default 'single',
  constraint_total numeric,

  -- true  -> one row per (object, user); the workshop sees an aggregate.
  -- false -> one agreed value per object, set by whoever holds the role.
  per_participant boolean not null default true,
  aggregate text not null default 'sum',

  -- Who may set it. Voting includes participants; a risk rating may not.
  allowed_roles text[] not null default array['facilitator','participant','analyst'],

  guidance_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (methodology_id, key),

  constraint methodology_weights_constraint_type_check
    check (constraint_type in ('budget', 'single')),
  constraint methodology_weights_aggregate_check
    check (aggregate in ('sum', 'mean', 'latest', 'min', 'max')),
  constraint methodology_weights_step_check
    check (scale_step > 0),
  constraint methodology_weights_range_check
    check (scale_max is null or scale_max > scale_min),
  -- A budget without a total is a budget of nothing, which would silently
  -- refuse every allocation rather than failing loudly here.
  constraint methodology_weights_budget_total_check
    check (constraint_type <> 'budget' or constraint_total > 0),
  -- An unbounded scale cannot be given ordinal labels.
  constraint methodology_weights_labels_need_bounds_check
    check (scale_labels is null or scale_max is not null),
  -- Labels must cover exactly the steps the scale defines, so a 1-5 scale
  -- cannot ship four names.
  constraint methodology_weights_labels_length_check
    check (
      scale_labels is null
      or jsonb_array_length(scale_labels) = floor((scale_max - scale_min) / scale_step)::int + 1
    )
);

create trigger methodology_weights_updated_at before update on public.methodology_weights
  for each row execute function public.set_updated_at();

create index if not exists methodology_weights_methodology_idx
  on public.methodology_weights (methodology_id, sort_order);

-- ------------------------------------------------------------
-- Values: every weight, for every object kind, in one table
--
-- object_id is deliberately NOT a foreign key: the reference is polymorphic
-- across factors, syntheses, insights and recommendations, and a per-kind FK
-- would mean a new column each time the registry grows. workshop_id carries
-- the cascade, and the object handlers delete an object's weights alongside
-- it (pkg/handlers/objects.go, factors.go).
-- ------------------------------------------------------------

create table if not exists public.weights (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  weight_key text not null,
  object_kind text not null,
  object_id uuid not null,
  -- null when the definition is per_participant = false: the value belongs to
  -- the object, not to a person.
  user_id uuid references public.profiles(id) on delete cascade,
  value numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger weights_updated_at before update on public.weights
  for each row execute function public.set_updated_at();

-- Two partial indexes rather than one unique constraint: Postgres treats NULL
-- as distinct, so a plain unique(workshop_id, weight_key, object_id, user_id)
-- would let a per-object weight be written an unlimited number of times.
create unique index if not exists weights_per_user_uniq
  on public.weights (workshop_id, weight_key, object_id, user_id)
  where user_id is not null;

create unique index if not exists weights_per_object_uniq
  on public.weights (workshop_id, weight_key, object_id)
  where user_id is null;

create index if not exists weights_object_idx
  on public.weights (workshop_id, object_kind, object_id);

-- ------------------------------------------------------------
-- RLS, matching the convention of every other table: enabled as a secondary
-- net, while Go remains the trust boundary (it connects as postgres, which
-- has rolbypassrls).
-- ------------------------------------------------------------

alter table public.methodology_weights enable row level security;
alter table public.weights enable row level security;

drop policy if exists "Authenticated users can view weight definitions" on public.methodology_weights;
create policy "Authenticated users can view weight definitions"
  on public.methodology_weights for select to authenticated using (true);

drop policy if exists "Workshop members can view weights" on public.weights;
create policy "Workshop members can view weights"
  on public.weights for select to authenticated
  using (public.is_workshop_member(workshop_id));

drop policy if exists "Workshop members can set their own weights" on public.weights;
create policy "Workshop members can set their own weights"
  on public.weights for insert to authenticated
  with check (public.is_workshop_member(workshop_id)
              and (user_id is null or user_id = auth.uid()));

drop policy if exists "Users can update their own weights" on public.weights;
create policy "Users can update their own weights"
  on public.weights for update to authenticated
  using (public.is_workshop_member(workshop_id)
         and (user_id is null or user_id = auth.uid()));

drop policy if exists "Users can remove their own weights" on public.weights;
create policy "Users can remove their own weights"
  on public.weights for delete to authenticated
  using (public.is_workshop_member(workshop_id)
         and (user_id is null or user_id = auth.uid()));

grant select on public.methodology_weights to authenticated;
grant select, insert, update, delete on public.weights to authenticated;

-- ------------------------------------------------------------
-- Voting becomes the first weight
--
-- Every methodology with a prioritize stage gets a 'vote' definition built
-- from the budget already in that stage's config, so SWOT-TOWS arrives at 20
-- and PESTLE at 6 without either number being written here.
-- ------------------------------------------------------------

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step,
   constraint_type, constraint_total, per_participant, aggregate, allowed_roles,
   guidance_text, sort_order)
select
  ms.methodology_id,
  'vote',
  'Priority votes',
  'factor',
  0,
  null,                      -- a participant may stack their whole budget on one factor
  1,
  'budget',
  (ms.config ->> 'votes_per_participant')::numeric,
  true,
  'sum',
  array['facilitator','participant','analyst'],
  'Spend your budget on the factors that matter most. Several votes may go on one factor.',
  0
from public.methodology_stages ms
where ms.stage_type = 'prioritize'
  and coalesce((ms.config ->> 'votes_per_participant')::numeric, 0) > 0
on conflict (methodology_id, key) do nothing;

-- Copy existing allocations. The demo workshop's votes must survive, because
-- the prioritization UAT cases assert specific totals against them.
insert into public.weights (workshop_id, weight_key, object_kind, object_id, user_id, value, created_at)
select v.workshop_id, 'vote', 'factor', v.factor_id, v.user_id, v.vote_value, v.created_at
from public.votes v
where exists (select 1 from public.factors f where f.id = v.factor_id)
on conflict do nothing;

-- Fail the migration rather than silently losing allocations.
do $$
declare
  src int;
  dst int;
begin
  select count(*) into src from public.votes v
    where exists (select 1 from public.factors f where f.id = v.factor_id);
  select count(*) into dst from public.weights where weight_key = 'vote';
  if src <> dst then
    raise exception 'vote migration lost rows: % in votes, % in weights', src, dst;
  end if;
end $$;

-- public.votes is intentionally left in place, still holding its rows. Go no
-- longer writes to it from this release. It is dropped in a later migration,
-- once the vote adapters have run against a real database.

comment on table public.weights is
  'Every weight value in every methodology. A vote is a weight with a budget constraint; a score is a weight with a bounded scale. See 20260920100000_weight_abstraction.sql.';
comment on table public.methodology_weights is
  'Weight definitions per methodology. Scale bounds are configuration: any range, any step. Do not assume 1-5.';
