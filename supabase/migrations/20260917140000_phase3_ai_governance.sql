-- ============================================================
-- Phase 3 — AI Strategy Assistant: governance schema
--
-- Fixes two genericity violations in the original AI tables, then adds the
-- audit fields App Spec §12.20 requires.
-- ============================================================

-- ------------------------------------------------------------
-- 1. output_type was a hardcoded, SWOT-flavoured enum
--
-- The CHECK allowed artifact_suggestion | theme_suggestion |
-- insight_suggestion | recommendation_suggestion | report_narrative |
-- summary | challenge. That is wrong twice over: a new methodology defining
-- its own AI functions would be rejected outright, and it did not even match
-- the function keys actually seeded (theme_generation, relationship_generation,
-- duplicate_detection, traceability_explanation...), so most real outputs
-- could never have been stored.
--
-- output_type is now the function_key from methodology_ai_prompts — config,
-- not an enum.
-- ------------------------------------------------------------

do $$
declare con text;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.ai_outputs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%output_type%'
  loop
    execute format('alter table public.ai_outputs drop constraint %I', con);
  end loop;
end $$;

alter table public.ai_outputs drop constraint if exists ai_outputs_output_type_nonempty;
alter table public.ai_outputs add constraint ai_outputs_output_type_nonempty
  check (length(trim(output_type)) > 0);

-- ------------------------------------------------------------
-- 2. Prompts could only attach to ONE named stage
--
-- artifact_suggestion and duplicate_detection were seeded against
-- strength_discovery, so the other three SWOT capture stages — and all six
-- of PESTLE's — had no AI at all. A prompt may now target a stage_type,
-- which applies it to every stage of that type in the methodology.
--
-- Resolution order in Go: exact stage_id, then stage_type, then global.
-- ------------------------------------------------------------

alter table public.methodology_ai_prompts
  add column if not exists stage_type text;

alter table public.methodology_ai_prompts drop constraint if exists methodology_ai_prompts_target_check;
alter table public.methodology_ai_prompts add constraint methodology_ai_prompts_target_check
  check (stage_id is null or stage_type is null);

-- Re-point the two capture-stage prompts from "the strength stage" to
-- "any capture stage", so every category gets them for free.
update public.methodology_ai_prompts p
set stage_id = null, stage_type = 'capture'
from public.methodology_stages s
where p.stage_id = s.id
  and s.stage_type = 'capture';

-- The remaining stage-linked prompts are one-per-stage-type anyway, so
-- expressing them as stage_type keeps resolution uniform and lets a
-- methodology with two synthesize stages reuse one prompt.
update public.methodology_ai_prompts p
set stage_type = s.stage_type, stage_id = null
from public.methodology_stages s
where p.stage_id = s.id;

-- ------------------------------------------------------------
-- 3. Audit fields per App Spec §12.20
--
-- "Converted object type, Converted object ID" — the link from an accepted
-- AI suggestion to the business object it became. The object tables already
-- carry source_ai_output_id pointing the other way; this completes the pair
-- so an output can be traced forward as well as back.
-- ------------------------------------------------------------

alter table public.ai_outputs
  add column if not exists reviewed_by           uuid references public.profiles(id),
  add column if not exists reviewed_at           timestamptz,
  add column if not exists converted_object_type text,
  add column if not exists converted_object_id   uuid;

-- A reviewed output must name its reviewer, matching every other governance
-- decision in the system.
alter table public.ai_outputs drop constraint if exists ai_outputs_review_attribution_check;
alter table public.ai_outputs add constraint ai_outputs_review_attribution_check
  check (
    human_review_status = 'pending'
    or (reviewed_by is not null and reviewed_at is not null)
  );

-- ------------------------------------------------------------
-- 4. Session telemetry for the cost/latency tracking §12.21 asks for
-- ------------------------------------------------------------

alter table public.ai_sessions
  add column if not exists latency_ms     integer,
  add column if not exists error_message  text,
  add column if not exists model          text,
  add column if not exists input_tokens   integer,
  add column if not exists output_tokens  integer,
  add column if not exists stage_key      text;

do $$
declare con text;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.ai_sessions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table public.ai_sessions drop constraint %I', con);
  end loop;
end $$;

update public.ai_sessions set status = 'completed'
  where status not in ('pending', 'completed', 'failed');

alter table public.ai_sessions add constraint ai_sessions_status_check
  check (status in ('pending', 'completed', 'failed'));

-- Rate limiting counts a user's sessions in a rolling window (§12.21).
create index if not exists idx_ai_sessions_user_created
  on public.ai_sessions (user_id, created_at desc);

create index if not exists idx_ai_outputs_session
  on public.ai_outputs (ai_session_id);
