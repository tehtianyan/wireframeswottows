-- An action on the delivery board carries who owns it, when it runs, what it
-- costs and what it is worth (UAT 2026-11-14).
--
-- "The Kanban board should have a field for the action owner, start date, end
-- date, effort estimation, and business impact field for every action. These
-- are optional fields so that the facilitator can skip these when he is out of
-- time."
--
-- EVERY COLUMN IS NULLABLE, AND THAT IS THE REQUIREMENT RATHER THAN CAUTION.
-- These are filled in a live session against the clock; a required field here
-- would stop a facilitator recording the action at all, which is the one thing
-- that must never happen. An action with nothing but a title is still a valid
-- action.
--
-- THE VALUE IS A QUANTITY, NOT A SENTENCE. "about $450k of retained revenue"
-- cannot be totalled, sorted, or weighed against effort. An amount plus a unit
-- can be: two actions in the same unit add up, per initiative and per
-- workshop, and the pair travels into the Jira export where the figure is
-- furthest from the room that produced it.

begin;

-- ---------------------------------------------------------------- owner ----
--
-- TWO COLUMNS, AND A CHECK SAYING AT MOST ONE IS SET.
--
-- The common owner is somebody in the room, and a picker off the roster is one
-- click and gives a real account — which is what lets the Jira export name an
-- assignee rather than a string. But a workshop action is often owned by
-- somebody who never attended ("Head of Sales Ops"), and a product that cannot
-- record that forces the facilitator to lie or to leave it blank.
--
-- So: an account when there is one, free text when there is not, never both.
-- "Exactly one of these two, or neither" is a thing a CHECK can state, which
-- is the same argument board_cleanup_changes made for two typed columns over
-- one polymorphic id.
alter table public.recommendations
  add column if not exists owner_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists owner_name text;

-- on delete set null, not cascade: deleting a person must not delete the work.

alter table public.recommendations
  drop constraint if exists recommendations_owner_one_of_check;
alter table public.recommendations
  add constraint recommendations_owner_one_of_check
  check (owner_user_id is null or owner_name is null);

-- ----------------------------------------------------------------- when ----
alter table public.recommendations
  add column if not exists start_date date,
  add column if not exists end_date date;

-- A range that runs backwards is a typo, and catching it here means every
-- path catches it — the quick-add, the board editor and direct SQL alike.
-- Only when BOTH are present: "starts in March, no end decided" is ordinary.
alter table public.recommendations
  drop constraint if exists recommendations_dates_order_check;
alter table public.recommendations
  add constraint recommendations_dates_order_check
  check (start_date is null or end_date is null or end_date >= start_date);

-- --------------------------------------------------------------- effort ----
--
-- PERSON-DAYS, AND THE UNIT IS FIXED ON PURPOSE. Effort is the one figure
-- here that has a natural common unit, and leaving it free would mean one
-- action in days and the next in weeks with nothing able to add them. numeric
-- rather than integer because half a day is a real estimate.
alter table public.recommendations
  add column if not exists effort_person_days numeric(10,2);

alter table public.recommendations
  drop constraint if exists recommendations_effort_sign_check;
alter table public.recommendations
  add constraint recommendations_effort_sign_check
  check (effort_person_days is null or effort_person_days >= 0);

-- ------------------------------------------------------------ the value ----
--
-- NO CHECK ON THE UNIT, DELIBERATELY. The options live in pkg/objects'
-- registry as an `enum` Field, and coerceFields already refuses anything not
-- in them — so the registry is the single statement of the list. A CHECK here
-- would be a sixth hardcoded enum in a schema that has had to remove five, and
-- the two would drift the first time a unit was added.
--
-- The amount and the unit stand or fall together: a number with no unit is not
-- a quantity, and a unit with no number says nothing at all. That one IS worth
-- a constraint, because it is the difference between "quantified" and a field
-- somebody half filled in.
alter table public.recommendations
  add column if not exists value_amount numeric(16,2),
  add column if not exists value_unit text,
  add column if not exists value_basis text;

alter table public.recommendations
  drop constraint if exists recommendations_value_pair_check;
alter table public.recommendations
  add constraint recommendations_value_pair_check
  check ((value_amount is null) = (value_unit is null));

alter table public.recommendations
  drop constraint if exists recommendations_value_sign_check;
alter table public.recommendations
  add constraint recommendations_value_sign_check
  check (value_amount is null or value_amount >= 0);

-- The board reads these for every action in a workshop; the existing
-- workshop_id index carries that, so no new index is added for a table that
-- holds tens of rows per workshop.

-- ------------------------------------------------------------- verified ----
--
-- The migration checks its own work rather than trusting the loop above, the
-- way 20261109110000 does. A migration that reports success against a schema
-- it did not actually change is the deploy failure this project has already
-- had once.
do $$
declare
  missing text;
  n int;
begin
  select string_agg(c, ', ') into missing
  from unnest(array[
    'owner_user_id', 'owner_name', 'start_date', 'end_date',
    'effort_person_days', 'value_amount', 'value_unit', 'value_basis'
  ]) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'recommendations'
      and column_name = c
  );
  if missing is not null then
    raise exception 'delivery columns missing after migration: %', missing;
  end if;

  -- EVERY ONE OF THEM NULLABLE. If any arrived NOT NULL, a facilitator in a
  -- hurry could no longer add an action at all — which is exactly the defect
  -- `an_action_is_one_line` had to undo five days ago.
  select count(*) into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'recommendations'
    and column_name in ('owner_user_id','owner_name','start_date','end_date',
                        'effort_person_days','value_amount','value_unit','value_basis')
    and is_nullable = 'NO';
  if n > 0 then
    raise exception '% of the new delivery columns are NOT NULL; all must be optional', n;
  end if;

  select count(*) into n
  from pg_constraint
  where conrelid = 'public.recommendations'::regclass
    and conname in ('recommendations_owner_one_of_check',
                    'recommendations_dates_order_check',
                    'recommendations_effort_sign_check',
                    'recommendations_value_pair_check',
                    'recommendations_value_sign_check');
  if n <> 5 then
    raise exception 'expected 5 delivery constraints, found %', n;
  end if;
end $$;

commit;
