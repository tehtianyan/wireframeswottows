-- ============================================================
-- Phase 5 — Knowledge Workspace and Notifications
--
-- The Knowledge Workspace is what App Spec §2.12 calls the thing that
-- "differentiates the application from traditional workshop tools": workshop
-- output that outlives its workshop.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Knowledge assets (App Spec §8.31)
--
--   Insight → Review → Knowledge Candidate → Published Knowledge Asset
--
-- "Not all workshop outputs become organizational knowledge. Knowledge
-- promotion should be deliberate. This prevents repository clutter."
--
-- So promotion is a SEPARATE axis from the review lifecycle, not another
-- state on it: an approved insight is a valid workshop output, and only some
-- approved outputs are worth keeping for the organization. Modelling it as a
-- table rather than a column also makes "organizational knowledge" a
-- first-class thing that can be queried across workshops, which is the whole
-- point.
--
-- object_kind uses the object registry's vocabulary plus 'factor' — platform
-- constants, so a CHECK is legitimate here for the same reason stage_type has
-- one. Deliberately NO foreign key to the object tables: a cascade would let
-- deleting a workshop silently erase organizational memory.
-- ------------------------------------------------------------

create table if not exists public.knowledge_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  source_workshop_id uuid references public.workshops(id) on delete set null,

  object_kind text not null,
  object_id   uuid not null,

  -- Snapshotted at promotion. Knowledge is meant to outlive its source, and a
  -- library whose entries silently change when someone edits a workshop is
  -- not a record of anything.
  title   text not null,
  summary text,

  state text not null default 'candidate',

  promoted_by  uuid references public.profiles(id),
  promoted_at  timestamptz not null default now(),
  published_by uuid references public.profiles(id),
  published_at timestamptz,
  archived_at  timestamptz,

  tags text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint knowledge_assets_kind_check check (object_kind in
    ('factor','synthesis','factor_relationship','insight','recommendation','report')),
  constraint knowledge_assets_state_check check (state in ('candidate','published','archived')),
  -- Publishing makes it organizational memory, so it names a person.
  constraint knowledge_assets_publish_attribution_check
    check (state <> 'published' or (published_by is not null and published_at is not null)),
  unique (object_kind, object_id)
);

create trigger knowledge_assets_updated_at before update on public.knowledge_assets
  for each row execute function public.set_updated_at();

create index if not exists idx_knowledge_assets_workspace
  on public.knowledge_assets (workspace_id, state);
create index if not exists idx_knowledge_assets_object
  on public.knowledge_assets (object_kind, object_id);
create index if not exists idx_knowledge_assets_search
  on public.knowledge_assets
  using gin(to_tsvector('english', title || ' ' || coalesce(summary, '')));

alter table public.knowledge_assets enable row level security;

-- §3.23: "Historical knowledge should be reusable while remaining secure."
-- Visibility follows workspace membership; Go enforces curation rights.
create policy "Workspace members can view knowledge assets" on public.knowledge_assets
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Workspace members can insert knowledge assets" on public.knowledge_assets
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Workspace members can update knowledge assets" on public.knowledge_assets
  for update to authenticated using (public.is_workspace_member(workspace_id));
create policy "Workspace members can delete knowledge assets" on public.knowledge_assets
  for delete to authenticated using (public.is_workspace_member(workspace_id));

grant select, insert, update, delete on public.knowledge_assets to authenticated;
grant all on public.knowledge_assets to service_role;

-- ------------------------------------------------------------
-- 2. Search indexes for the kinds that lacked them
--
-- factors, insights, recommendations and reports already had gin tsvector
-- indexes from the canonical schema; syntheses and factor_relationships never
-- did, and knowledge search covers all of them.
-- ------------------------------------------------------------

create index if not exists idx_syntheses_search on public.syntheses
  using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));

create index if not exists idx_factor_relationships_search on public.factor_relationships
  using gin(to_tsvector('english',
    coalesce(title, '') || ' ' || coalesce(narrative, '') || ' ' || coalesce(strategic_option, '')));

-- ------------------------------------------------------------
-- 3. Notifications (App Spec §8.32, §10.27, §11.27)
--
-- The table already existed and had never been written to. It needs a state
-- vocabulary and the indexes a per-recipient inbox actually queries by.
-- ------------------------------------------------------------

alter table public.notifications
  add column if not exists workshop_id uuid references public.workshops(id) on delete cascade,
  add column if not exists actor_id    uuid references public.profiles(id),
  add column if not exists read_at     timestamptz;

create index if not exists idx_notifications_recipient
  on public.notifications (recipient_id, is_read, created_at desc);

alter table public.notifications enable row level security;

-- A notification is addressed to one person. Nobody else reads it, including
-- the workshop's facilitator.
drop policy if exists "Recipients can view their notifications" on public.notifications;
create policy "Recipients can view their notifications" on public.notifications
  for select to authenticated using (recipient_id = auth.uid());
drop policy if exists "Recipients can update their notifications" on public.notifications;
create policy "Recipients can update their notifications" on public.notifications
  for update to authenticated using (recipient_id = auth.uid());
drop policy if exists "Recipients can delete their notifications" on public.notifications;
create policy "Recipients can delete their notifications" on public.notifications
  for delete to authenticated using (recipient_id = auth.uid());

grant select, update, delete on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- ------------------------------------------------------------
-- 4. Administration (App Spec §11.29)
--
-- profiles.global_role and profiles.status already exist but were never
-- constrained, so any string could be written to either.
-- ------------------------------------------------------------

update public.profiles set global_role = 'user'
  where global_role is null or global_role not in ('user', 'admin', 'platform_admin');
update public.profiles set status = 'active'
  where status is null or status not in ('active', 'disabled');

alter table public.profiles drop constraint if exists profiles_global_role_check;
alter table public.profiles add constraint profiles_global_role_check
  check (global_role in ('user', 'admin', 'platform_admin'));

alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check
  check (status in ('active', 'disabled'));
