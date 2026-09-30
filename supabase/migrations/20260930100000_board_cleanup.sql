-- ============================================================
-- "Merge and Fix" — a tracked, undoable AI tidy-up of the capture board
--
-- A live capture session leaves a messy wall: typos, the same idea written
-- three ways by three people, notes in the wrong quadrant. The facilitator
-- gets one button that cleans it up.
--
-- The governance argument, which these tables exist to make true:
--
--   * NOTHING IS APPROVED BY AI. Every touched factor stays `submitted`, so
--     the Review Board remains the §12.19 decision point.
--   * NOTHING IS DESTROYED. A merged duplicate is set to `archived`, never
--     deleted, so undo is a state change rather than a resurrection.
--   * NOTHING IS UNTRACEABLE. Every change is a row holding its own
--     before-state, attributed to the facilitator who ran it.
--
-- If that argument ever stops holding, the feature is wrong, not the rule.
-- ============================================================

-- ------------------------------------------------------------
-- 1. `changeset` — a third genuine AI output shape
--
-- `suggestions` is a list of things to CREATE and `narrative` is prose. This
-- is neither: it is a list of edits to rows that already exist, and the UI
-- must not offer "Add for review" buttons against it. Declaring the shape in
-- config beats sniffing it at runtime, which is the precedent
-- 20260917170000_report_templates_config.sql set.
-- ------------------------------------------------------------

alter table public.methodology_ai_prompts drop constraint if exists methodology_ai_prompts_output_kind_check;
alter table public.methodology_ai_prompts add constraint methodology_ai_prompts_output_kind_check
  check (output_kind in ('suggestions', 'narrative', 'changeset'));

-- ------------------------------------------------------------
-- 2. The runs
-- ------------------------------------------------------------

create table if not exists public.board_cleanup_runs (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,

  -- Which capture stage the facilitator ran it from. Recorded for the audit
  -- trail; the run itself covers the whole board, because a note in the wrong
  -- quadrant is by definition not on the stage it belongs to.
  stage_key text,

  -- The model's raw proposal stays inspectable, including the parts that were
  -- refused. Without this, "why didn't it merge those two?" has no answer.
  ai_output_id uuid references public.ai_outputs(id) on delete set null,

  -- What the model proposed and the server refused, with the reason for each.
  -- Stored rather than merely returned, because "two of these look like
  -- duplicates but are cited by a theme" is exactly the thing a facilitator
  -- needs to still be able to read tomorrow.
  skipped jsonb not null default '[]'::jsonb,

  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),

  undone_at timestamptz,
  undone_by uuid references public.profiles(id),

  -- Same attribution rule every other governance decision in the system
  -- carries: an undo names who did it.
  constraint board_cleanup_runs_undo_attribution_check
    check (undone_at is null or undone_by is not null)
);

create index if not exists board_cleanup_runs_workshop_idx
  on public.board_cleanup_runs (workshop_id, created_at desc);

-- ------------------------------------------------------------
-- 3. The changes
--
-- `before` holds ONLY what the change touched — {title, description} for a
-- reword, {category_key} for a move, {state} for a merge. Undo is therefore a
-- targeted restore rather than a whole-row overwrite, which would clobber an
-- edit somebody made in between.
-- ------------------------------------------------------------

create table if not exists public.board_cleanup_changes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.board_cleanup_runs(id) on delete cascade,

  change_type text not null,
  factor_id   uuid not null references public.factors(id) on delete cascade,

  before_state jsonb not null default '{}'::jsonb,
  after_state  jsonb not null default '{}'::jsonb,

  -- The model's own words for what was wrong, shown to the facilitator.
  -- A change the facilitator cannot understand is a change they cannot judge.
  reason text,

  created_at timestamptz not null default now(),
  undone_at  timestamptz,
  undone_by  uuid references public.profiles(id),

  constraint board_cleanup_changes_type_check
    check (change_type in ('reword', 'move', 'merge')),
  constraint board_cleanup_changes_undo_attribution_check
    check (undone_at is null or undone_by is not null)
);

create index if not exists board_cleanup_changes_run_idx
  on public.board_cleanup_changes (run_id, created_at);

-- The Review Board asks "was this note tidied?" per factor, so that lookup
-- gets its own index rather than scanning every change ever made.
create index if not exists board_cleanup_changes_factor_idx
  on public.board_cleanup_changes (factor_id) where undone_at is null;

-- ------------------------------------------------------------
-- 4. RLS — the secondary net, as everywhere else
--
-- Go is the trust boundary and connects as a role with rolbypassrls, so these
-- policies protect direct PostgREST access rather than Go's queries.
-- ------------------------------------------------------------

alter table public.board_cleanup_runs enable row level security;
alter table public.board_cleanup_changes enable row level security;

drop policy if exists "Workshop members can view cleanup runs" on public.board_cleanup_runs;
create policy "Workshop members can view cleanup runs" on public.board_cleanup_runs
  for select to authenticated using (public.is_workshop_member(workshop_id));

drop policy if exists "Workshop members can view cleanup changes" on public.board_cleanup_changes;
create policy "Workshop members can view cleanup changes" on public.board_cleanup_changes
  for select to authenticated using (
    exists (
      select 1 from public.board_cleanup_runs r
      where r.id = run_id and public.is_workshop_member(r.workshop_id)
    )
  );

-- ------------------------------------------------------------
-- 5. The prompt — configuration, not code
--
-- Seeded for SWOT-TOWS only, the same opt-in shape the capture board itself
-- uses (`"layout": "board"`). Another methodology gets the feature by seeding
-- its own row; nothing in Go names a methodology, and a methodology without
-- this row shows no button.
--
-- Keyed by stage_type = 'capture', so it serves all four SWOT discovery
-- stages from one row — and would serve PESTLE's six unchanged.
-- ------------------------------------------------------------

insert into public.methodology_ai_prompts
  (methodology_id, function_key, stage_type, name, prompt_template, output_schema, prompt_version, output_kind)
select m.id, 'board_cleanup', 'capture', 'Merge and Fix',
  'You are tidying the capture board for the workshop "{{workshop_name}}" (objective: {{workshop_objective}}), run under the {{methodology_name}} methodology.'
  || E'\n\nPropose edits to the supplied notes so the board reads cleanly to someone who was not in the room. You may:'
  || E'\n  * "reword" — fix spelling and grammar, and rewrite a note that is ambiguous or vague so it states one clear point.'
  || E'\n  * "move" — put a note in the category it actually belongs to, using only the category keys supplied in the context.'
  || E'\n  * "merge" — fold a note into another that says the same thing in different words. Name the note to remove as factor_id and the one to keep as into_factor_id.'
  || E'\n\nRules:'
  || E'\n  * For a "reword", always give the new title. Give "description" ONLY if you are changing it — leaving it out keeps the note''s existing description.'
  || E'\n  * Use ONLY the supplied notes and their ids. Never invent a note, an id or a category.'
  || E'\n  * Keep the author''s voice. Do not normalise everything to one house style, and do not lengthen a note that is already clear.'
  || E'\n  * Never change what a note MEANS while fixing how it reads. If you cannot tell what it means, leave it alone.'
  || E'\n  * Propose nothing for a note that is already correct. A short changeset is a good outcome.'
  || E'\n  * Give at most one change per note. You may, however, reword a note AND merge a duplicate into that same note.'
  || E'\n  * Do not chain merges: a note you merge something into must not itself be merged away.'
  || E'\n  * In "reason", say plainly what was wrong, in one short sentence a facilitator can check at a glance.',
  '{"changes":[{"type":"reword","factor_id":"","title":"","description":"","reason":""},{"type":"move","factor_id":"","category_key":"","reason":""},{"type":"merge","factor_id":"","into_factor_id":"","reason":""}]}'::jsonb,
  'v1.0', 'changeset'
from public.methodologies m
where m.key = 'swot-tows'
-- Upserted rather than inserted-once: prompt text is configuration that gets
-- tuned, and re-running the migration should carry the tuning rather than
-- silently keeping an older template.
on conflict (methodology_id, function_key) do update set
  stage_type      = excluded.stage_type,
  name            = excluded.name,
  prompt_template = excluded.prompt_template,
  output_schema   = excluded.output_schema,
  prompt_version  = excluded.prompt_version,
  output_kind     = excluded.output_kind;

comment on table public.board_cleanup_runs is
  'One "Merge and Fix" run. Undoable as a whole; see board_cleanup_changes for the individual edits.';
comment on table public.board_cleanup_changes is
  'One tracked edit made by a cleanup run, holding the before-state so it can be undone individually.';
