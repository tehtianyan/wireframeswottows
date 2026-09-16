-- ============================================================
-- Phase 1 — factor governance state machine + methodology-neutral voting
--
-- Two concerns, both generic. Nothing here names SWOT, TOWS, or any
-- methodology: a PESTLE capture stage reviews and prioritizes through
-- exactly these columns.
--
--   1. The Draft -> Review -> Approved/Rejected lifecycle that the App Spec
--      applies to every object type, enforced at the DB level rather than
--      only in the UI (CLAUDE.md: "enforce traceability constraints at the
--      DB level").
--   2. Voting, cleaned up to reference `factors` rather than the old
--      `artifacts` name the engine migration left behind on this one column.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Factor governance
-- ------------------------------------------------------------

alter table public.factors
  add column if not exists reviewed_by  uuid references public.profiles(id),
  add column if not exists reviewed_at  timestamptz,
  add column if not exists review_note  text;

-- Normalize any pre-existing free-text state before constraining the column.
update public.factors set state = 'submitted'
  where state is null or state not in ('draft', 'submitted', 'approved', 'rejected');

alter table public.factors drop constraint if exists factors_state_check;
alter table public.factors add constraint factors_state_check
  check (state in ('draft', 'submitted', 'approved', 'rejected'));

-- A review decision must record who made it. Approval is an accountable act
-- (App Spec: AI never approves; every approval is attributed to a person).
alter table public.factors drop constraint if exists factors_review_attribution_check;
alter table public.factors add constraint factors_review_attribution_check
  check (
    state not in ('approved', 'rejected')
    or (reviewed_by is not null and reviewed_at is not null)
  );

create index if not exists idx_factors_workshop_state
  on public.factors (workshop_id, state);

-- ------------------------------------------------------------
-- 2. Voting
-- ------------------------------------------------------------

-- The engine migration renamed artifacts -> factors but left this FK column
-- carrying the old methodology-flavoured name.
alter table public.votes rename column artifact_id to factor_id;

-- One row per (participant, factor); vote_value carries how much of the
-- participant's budget is allocated to it. The budget itself is NOT stored
-- here — it comes from the prioritize stage's config, so each methodology
-- sets its own.
delete from public.votes v
  using public.votes keep
  where v.factor_id = keep.factor_id
    and v.user_id = keep.user_id
    and v.id > keep.id;

alter table public.votes drop constraint if exists votes_factor_user_unique;
alter table public.votes add constraint votes_factor_user_unique
  unique (factor_id, user_id);

alter table public.votes drop constraint if exists votes_value_positive_check;
alter table public.votes add constraint votes_value_positive_check
  check (vote_value > 0);

create index if not exists idx_votes_workshop_user
  on public.votes (workshop_id, user_id);
