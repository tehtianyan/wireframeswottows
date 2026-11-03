-- Capture board ordering, and per-SUGGESTION review of an AI output.
--
-- Two unrelated defects, one migration, because both are small schema facts
-- that the handlers above them cannot express today.
--
-- 1. factors.board_position
--
-- The capture board had no ordering of its own. `ListFactors` returns
-- `order by votes desc, created_at desc`, which the PRIORITIZE stage needs —
-- but on a capture wall it means every new note appears at the TOP, so the
-- wall reads backwards against the session that produced it, and a
-- facilitator cannot group related notes together while the room watches.
--
-- A null position means "never placed by hand": the board then falls back to
-- creation order, oldest first, which is the physical wall's own order. Once a
-- facilitator arranges a panel every note in it gets a position, and a note
-- added afterwards is null again and so lands at the bottom — which is where a
-- new sticky goes.
--
-- The position is DELIBERATELY not read by the prioritize stage, the
-- leaderboard or the report's prioritized_factors section. Those rank by
-- weight, and a facilitator's visual arrangement is not a group priority
-- decision; letting it quietly outrank the votes is exactly the misreading
-- the reporting rules were written to prevent.
--
-- 2. ai_output_items
--
-- `ai_outputs.human_review_status` is ONE status for an output that holds N
-- suggestions, and `converted_object_id` is ONE column for what may be N
-- created objects. So accepting the first suggestion marked the whole output
-- reviewed, and every later suggestion in the same batch was refused with
-- "This suggestion has already been reviewed." The panel's own per-index state
-- was right; the storage could not hold it.
--
-- The item rows are now the authoritative record of what a human did with each
-- suggestion. The output-level column is kept and keeps its meaning — the
-- output AS A WHOLE — so everything already reading it still works: it stays
-- `pending` until every suggestion has been decided.

-- ============================================================
-- 1. Board ordering
-- ============================================================

alter table public.factors
  add column if not exists board_position integer;

comment on column public.factors.board_position is
  'Hand-set order within a category on the capture board. NULL means never '
  'placed by hand, so the board falls back to created_at ascending. Set only '
  'by a facilitator, through PUT /workshops/{id}/factors/order. Never read by '
  'the prioritize stage or by reports, which rank by weight.';

-- The board sorts within one category at a time, so that is what the index
-- covers. NULLS LAST matches the handler's `coalesce`-free ordering.
create index if not exists factors_board_order_idx
  on public.factors (workshop_id, factor_category_id, board_position nulls last, created_at);

-- ============================================================
-- 2. Per-suggestion AI review
-- ============================================================

create table if not exists public.ai_output_items (
  id uuid primary key default gen_random_uuid(),
  ai_output_id uuid not null references public.ai_outputs(id) on delete cascade,
  -- The suggestion's index in ai_outputs.content's array. The array is
  -- immutable once stored, so the index is a stable identity for the item.
  item_index int not null,
  review_status text not null,
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  converted_object_type text,
  converted_object_id uuid,

  constraint ai_output_items_index_check check (item_index >= 0),
  constraint ai_output_items_status_check
    check (review_status in ('accepted', 'edited', 'rejected')),
  -- One decision per suggestion. This is the constraint that makes the bug
  -- unrepresentable rather than merely fixed: a second decision on the same
  -- index cannot be stored, whatever a future handler tries.
  constraint ai_output_items_one_decision_per_item
    unique (ai_output_id, item_index),
  -- The same shape as the governance constraints on every object table: an
  -- acceptance must name what it created, and a rejection must have created
  -- nothing. An "accepted" row with no object is an acceptance nobody can
  -- trace, which is the one thing AI governance here does not allow.
  constraint ai_output_items_converted_check check (
    (review_status = 'rejected'
      and converted_object_type is null and converted_object_id is null)
    or (review_status in ('accepted', 'edited')
      and converted_object_type is not null and converted_object_id is not null)
  )
);

comment on table public.ai_output_items is
  'One human decision per suggestion inside an ai_outputs row. Authoritative: '
  'ai_outputs.human_review_status describes the output as a whole and stays '
  'pending until every suggestion here has been decided.';

create index if not exists ai_output_items_output_idx
  on public.ai_output_items (ai_output_id);

-- RLS on, and no policy. The convention in this schema is that every table in
-- `public` has RLS enabled (public.rls_coverage_gaps raises otherwise, and a
-- table created outside this directory is how the ledger came to be exposed).
-- Go reads and writes this table as postgres, which bypasses RLS; no client
-- reads it directly, so zero policies denies every browser and costs the
-- server nothing.
alter table public.ai_output_items enable row level security;

-- ============================================================
-- Checks — raise rather than trust the statements above
-- ============================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'factors'
      and column_name = 'board_position'
  ) then
    raise exception 'factors.board_position was not created';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'ai_output_items'
  ) then
    raise exception 'public.ai_output_items was not created';
  end if;

  -- The coverage view is the thing that caught the unsecured ledger. If this
  -- migration had left the new table without RLS, this is where it stops.
  if exists (select 1 from public.rls_coverage_gaps) then
    raise exception 'a table in public has RLS disabled after this migration';
  end if;
end $$;
