-- Canonical Data Model / Physical Database Schema
-- Source: SWOT-TOWS Application Specification.docx section 10
-- Applied to a fresh, user-owned Supabase project (azbqapefetexjqefcdep).

-- ============================================================
-- Shared helpers
-- ============================================================

create or replace function public.set_updated_at()
returns trigger as $$ begin new.updated_at = now(); return new; end; $$
language plpgsql set search_path = public;

-- ============================================================
-- 10.4 organizations
-- ============================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  industry text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.6 profiles (created before workspaces so workspaces.owner_id can reference it)
-- ============================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  first_name text,
  last_name text,
  display_name text,
  global_role text not null default 'user',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile row whenever a Supabase Auth user is created.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, first_name, last_name, display_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name',
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email)
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 10.5 workspaces
-- ============================================================

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  owner_id uuid references public.profiles(id),
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.7 workspace_members
-- ============================================================

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  unique(workspace_id, user_id),
  constraint workspace_members_role_check check (role in ('owner','admin','facilitator','analyst','member','viewer'))
);

-- ============================================================
-- 10.8 workshops
-- ============================================================

create table public.workshops (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text,
  objective text,
  facilitator_id uuid references public.profiles(id),
  status text not null default 'draft',
  start_date date,
  end_date date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workshops_status_check check (status in ('draft','configured','active','analysis','reporting','completed','archived'))
);

create trigger workshops_updated_at before update on public.workshops
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.9 workshop_members
-- ============================================================

create table public.workshop_members (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'participant',
  invited_at timestamptz,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique(workshop_id, user_id),
  constraint workshop_members_role_check check (role in ('facilitator','participant','executive_viewer','analyst','observer'))
);

-- ============================================================
-- Membership helper functions (defined here, now that workspace_members and
-- workshop_members exist for these SQL-language functions to validate against)
-- ============================================================

create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = target_workspace_id and wm.user_id = auth.uid()
  );
$$ language sql stable security definer set search_path = public;

create or replace function public.is_workshop_member(target_workshop_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.workshop_members wm
    where wm.workshop_id = target_workshop_id and wm.user_id = auth.uid()
  );
$$ language sql stable security definer set search_path = public;

-- ============================================================
-- 10.10 activities
-- ============================================================

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  activity_type text not null,
  title text not null,
  description text,
  sequence_number integer not null,
  status text not null default 'not_started',
  opened_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activities_type_check check (activity_type in (
    'strength_discovery','weakness_discovery','opportunity_discovery','threat_discovery',
    'swot_review','prioritization','theme_generation','tows_analysis',
    'insight_generation','recommendation_generation','reporting'
  ))
);

create trigger activities_updated_at before update on public.activities
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.11 artifacts
-- ============================================================

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  activity_id uuid references public.activities(id) on delete set null,
  artifact_type text not null,
  title text not null,
  description text,
  category text,
  created_by uuid references public.profiles(id),
  state text not null default 'submitted',
  priority_score integer not null default 0,
  confidence_score numeric(4,2),
  is_ai_generated boolean not null default false,
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifacts_type_check check (artifact_type in ('strength','weakness','opportunity','threat'))
);

create trigger artifacts_updated_at before update on public.artifacts
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.12 votes
-- ============================================================

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  vote_value integer not null default 1,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10.13 comments
-- ============================================================

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  object_type text not null,
  object_id uuid not null,
  workshop_id uuid references public.workshops(id) on delete cascade,
  created_by uuid references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint comments_object_type_check check (object_type in ('artifact','theme','insight','recommendation','report'))
);

create trigger comments_updated_at before update on public.comments
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.14 themes
-- ============================================================

create table public.themes (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  title text not null,
  description text,
  confidence_score numeric(4,2),
  generated_by text not null default 'human',
  state text not null default 'review',
  created_by uuid references public.profiles(id),
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint themes_generated_by_check check (generated_by in ('human','ai','hybrid')),
  constraint themes_state_check check (state in ('review','approved','rejected','archived'))
);

create trigger themes_updated_at before update on public.themes
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.15 theme_artifacts
-- ============================================================

create table public.theme_artifacts (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references public.themes(id) on delete cascade,
  artifact_id uuid not null references public.artifacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(theme_id, artifact_id)
);

-- ============================================================
-- 10.16 tows_relationships
-- ============================================================

create table public.tows_relationships (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  source_artifact_id uuid references public.artifacts(id) on delete set null,
  target_artifact_id uuid references public.artifacts(id) on delete set null,
  relationship_type text not null,
  title text,
  narrative text,
  strategic_option text,
  confidence_score numeric(4,2),
  generated_by text not null default 'human',
  state text not null default 'review',
  source_ai_output_id uuid,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tows_relationship_type_check check (relationship_type in ('so','wo','st','wt')),
  constraint tows_generated_by_check check (generated_by in ('human','ai','hybrid')),
  constraint tows_state_check check (state in ('review','approved','rejected','archived'))
);

create trigger tows_relationships_updated_at before update on public.tows_relationships
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.17 insights
-- ============================================================

create table public.insights (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  title text not null,
  description text not null,
  strategic_significance text,
  confidence_score numeric(4,2),
  generated_by text not null default 'human',
  state text not null default 'review',
  created_by uuid references public.profiles(id),
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint insights_generated_by_check check (generated_by in ('human','ai','hybrid')),
  constraint insights_state_check check (state in ('review','approved','rejected','archived'))
);

create trigger insights_updated_at before update on public.insights
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.18 insight_themes
-- ============================================================

create table public.insight_themes (
  id uuid primary key default gen_random_uuid(),
  insight_id uuid not null references public.insights(id) on delete cascade,
  theme_id uuid not null references public.themes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(insight_id, theme_id)
);

-- ============================================================
-- 10.19 insight_tows_relationships
-- ============================================================

create table public.insight_tows_relationships (
  id uuid primary key default gen_random_uuid(),
  insight_id uuid not null references public.insights(id) on delete cascade,
  tows_relationship_id uuid not null references public.tows_relationships(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(insight_id, tows_relationship_id)
);

-- ============================================================
-- 10.20 recommendations
-- ============================================================

create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  title text not null,
  description text not null,
  benefits text,
  risks text,
  priority text not null default 'medium',
  impact_score integer,
  feasibility_score integer,
  generated_by text not null default 'human',
  state text not null default 'review',
  created_by uuid references public.profiles(id),
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recommendations_priority_check check (priority in ('critical','high','medium','low')),
  constraint recommendations_generated_by_check check (generated_by in ('human','ai','hybrid')),
  constraint recommendations_state_check check (state in ('review','approved','rejected','archived'))
);

create trigger recommendations_updated_at before update on public.recommendations
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.21 recommendation_insights
-- ============================================================

create table public.recommendation_insights (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.recommendations(id) on delete cascade,
  insight_id uuid not null references public.insights(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(recommendation_id, insight_id)
);

-- ============================================================
-- 10.22 actions
-- ============================================================

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  recommendation_id uuid not null references public.recommendations(id) on delete cascade,
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  title text not null,
  description text,
  owner_id uuid references public.profiles(id),
  due_date date,
  status text not null default 'not_started',
  success_measure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger actions_updated_at before update on public.actions
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.23 reports
-- ============================================================

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id) on delete cascade,
  title text not null,
  report_type text not null,
  status text not null default 'draft',
  generated_by uuid references public.profiles(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reports_type_check check (report_type in ('executive','swot','tows','recommendation','workshop_summary'))
);

create trigger reports_updated_at before update on public.reports
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.24 narratives
-- ============================================================

create table public.narratives (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  title text not null,
  content text not null,
  narrative_type text not null,
  generated_by text not null default 'ai',
  source_ai_output_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint narratives_type_check check (narrative_type in ('executive_summary','strategic_context','key_insights','recommendations','next_steps'))
);

create trigger narratives_updated_at before update on public.narratives
  for each row execute function public.set_updated_at();

-- ============================================================
-- 10.25 ai_sessions
-- ============================================================

create table public.ai_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id),
  workshop_id uuid references public.workshops(id) on delete cascade,
  prompt_type text not null,
  input_summary text,
  status text not null default 'completed',
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10.26 ai_outputs
-- ============================================================

create table public.ai_outputs (
  id uuid primary key default gen_random_uuid(),
  ai_session_id uuid not null references public.ai_sessions(id) on delete cascade,
  output_type text not null,
  content jsonb not null,
  confidence_score numeric(4,2),
  human_review_status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint ai_outputs_type_check check (output_type in (
    'artifact_suggestion','theme_suggestion','insight_suggestion',
    'recommendation_suggestion','report_narrative','summary','challenge'
  )),
  constraint ai_outputs_review_status_check check (human_review_status in ('pending','accepted','edited','rejected'))
);

-- ============================================================
-- 10.27 notifications
-- ============================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null,
  title text not null,
  body text,
  object_type text,
  object_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10.28 audit_events
-- ============================================================

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  object_type text not null,
  object_id uuid,
  previous_state text,
  new_state text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 10.29 Recommended indexes
-- ============================================================

create index idx_workspaces_organization_id on public.workspaces(organization_id);
create index idx_workshops_workspace_id on public.workshops(workspace_id);
create index idx_workshops_status on public.workshops(status);

create index idx_workspace_members_workspace_id on public.workspace_members(workspace_id);
create index idx_workspace_members_user_id on public.workspace_members(user_id);
create index idx_workshop_members_workshop_id on public.workshop_members(workshop_id);
create index idx_workshop_members_user_id on public.workshop_members(user_id);

create index idx_activities_workshop_id on public.activities(workshop_id);
create index idx_artifacts_workshop_id on public.artifacts(workshop_id);
create index idx_artifacts_type on public.artifacts(artifact_type);
create index idx_votes_workshop_id on public.votes(workshop_id);
create index idx_votes_artifact_id on public.votes(artifact_id);

create index idx_themes_workshop_id on public.themes(workshop_id);
create index idx_insights_workshop_id on public.insights(workshop_id);
create index idx_recommendations_workshop_id on public.recommendations(workshop_id);
create index idx_reports_workshop_id on public.reports(workshop_id);

create index idx_notifications_recipient_id on public.notifications(recipient_id);
create index idx_audit_events_object on public.audit_events(object_type, object_id);

-- ============================================================
-- 10.30 Full-text search indexes
-- ============================================================

create index idx_artifacts_search on public.artifacts
  using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
create index idx_insights_search on public.insights
  using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
create index idx_recommendations_search on public.recommendations
  using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
create index idx_reports_search on public.reports
  using gin(to_tsvector('english', title));

-- ============================================================
-- 10.32 Row-Level Security
-- ============================================================

alter table public.organizations enable row level security;
alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workshops enable row level security;
alter table public.workshop_members enable row level security;
alter table public.activities enable row level security;
alter table public.artifacts enable row level security;
alter table public.votes enable row level security;
alter table public.comments enable row level security;
alter table public.themes enable row level security;
alter table public.theme_artifacts enable row level security;
alter table public.tows_relationships enable row level security;
alter table public.insights enable row level security;
alter table public.insight_themes enable row level security;
alter table public.insight_tows_relationships enable row level security;
alter table public.recommendations enable row level security;
alter table public.recommendation_insights enable row level security;
alter table public.actions enable row level security;
alter table public.reports enable row level security;
alter table public.narratives enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.ai_outputs enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

-- profiles: any authenticated user can see basic profile info (names shown throughout
-- the app as authors/facilitators/commenters); only the owner can modify their own row.
create policy "Authenticated users can view profiles"
  on public.profiles for select to authenticated using (true);
create policy "Users can update their own profile"
  on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- organizations / workspaces: visible and manageable only by members.
create policy "Members can view their organizations"
  on public.organizations for select to authenticated using (
    exists (
      select 1 from public.workspaces w
      where w.organization_id = organizations.id and public.is_workspace_member(w.id)
    )
  );
create policy "Authenticated users can create organizations"
  on public.organizations for insert to authenticated with check (true);
create policy "Authenticated users can update organizations they belong to"
  on public.organizations for update to authenticated using (
    exists (
      select 1 from public.workspaces w
      where w.organization_id = organizations.id and public.is_workspace_member(w.id)
    )
  );

create policy "Members can view their workspaces"
  on public.workspaces for select to authenticated using (public.is_workspace_member(id));
create policy "Authenticated users can create workspaces"
  on public.workspaces for insert to authenticated with check (owner_id = auth.uid());
create policy "Members can update their workspaces"
  on public.workspaces for update to authenticated using (public.is_workspace_member(id));

create policy "Members can view workspace membership"
  on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members can manage workspace membership"
  on public.workspace_members for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members can update workspace membership"
  on public.workspace_members for update to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members can remove workspace membership"
  on public.workspace_members for delete to authenticated using (public.is_workspace_member(workspace_id));

-- workshops / workshop_members
create policy "Members can view their workshops"
  on public.workshops for select to authenticated using (public.is_workshop_member(id) or public.is_workspace_member(workspace_id));
create policy "Workspace members can create workshops"
  on public.workshops for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Workshop members can update their workshops"
  on public.workshops for update to authenticated using (public.is_workshop_member(id) or public.is_workspace_member(workspace_id));

create policy "Members can view workshop membership"
  on public.workshop_members for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Members can manage workshop membership"
  on public.workshop_members for insert to authenticated with check (public.is_workshop_member(workshop_id) or public.is_workspace_member((select workspace_id from public.workshops w where w.id = workshop_id)));
create policy "Members can update workshop membership"
  on public.workshop_members for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Members can remove workshop membership"
  on public.workshop_members for delete to authenticated using (public.is_workshop_member(workshop_id));

-- Generic pattern for all workshop-scoped content tables: readable and writable
-- by any member of the owning workshop. Fine-grained per-role checks (e.g. only
-- facilitators may approve) remain enforced at the application layer, same as
-- the rest of this prototype today.
create policy "Workshop members can view activities" on public.activities for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage activities" on public.activities for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update activities" on public.activities for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete activities" on public.activities for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view artifacts" on public.artifacts for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can create artifacts" on public.artifacts for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update artifacts" on public.artifacts for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete artifacts" on public.artifacts for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view votes" on public.votes for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can cast votes" on public.votes for insert to authenticated with check (public.is_workshop_member(workshop_id) and user_id = auth.uid());
create policy "Users can remove their own votes" on public.votes for delete to authenticated using (user_id = auth.uid());

create policy "Workshop members can view comments" on public.comments for select to authenticated using (workshop_id is null or public.is_workshop_member(workshop_id));
create policy "Workshop members can add comments" on public.comments for insert to authenticated with check (created_by = auth.uid() and (workshop_id is null or public.is_workshop_member(workshop_id)));
create policy "Authors can update their own comments" on public.comments for update to authenticated using (created_by = auth.uid());
create policy "Authors can delete their own comments" on public.comments for delete to authenticated using (created_by = auth.uid());

create policy "Workshop members can view themes" on public.themes for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage themes" on public.themes for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update themes" on public.themes for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete themes" on public.themes for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view theme_artifacts" on public.theme_artifacts for select to authenticated using (
  exists (select 1 from public.themes t where t.id = theme_id and public.is_workshop_member(t.workshop_id))
);
create policy "Workshop members can manage theme_artifacts" on public.theme_artifacts for insert to authenticated with check (
  exists (select 1 from public.themes t where t.id = theme_id and public.is_workshop_member(t.workshop_id))
);
create policy "Workshop members can delete theme_artifacts" on public.theme_artifacts for delete to authenticated using (
  exists (select 1 from public.themes t where t.id = theme_id and public.is_workshop_member(t.workshop_id))
);

create policy "Workshop members can view tows_relationships" on public.tows_relationships for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage tows_relationships" on public.tows_relationships for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update tows_relationships" on public.tows_relationships for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete tows_relationships" on public.tows_relationships for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view insights" on public.insights for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage insights" on public.insights for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update insights" on public.insights for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete insights" on public.insights for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view insight_themes" on public.insight_themes for select to authenticated using (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);
create policy "Workshop members can manage insight_themes" on public.insight_themes for insert to authenticated with check (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);
create policy "Workshop members can delete insight_themes" on public.insight_themes for delete to authenticated using (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);

create policy "Workshop members can view insight_tows_relationships" on public.insight_tows_relationships for select to authenticated using (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);
create policy "Workshop members can manage insight_tows_relationships" on public.insight_tows_relationships for insert to authenticated with check (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);
create policy "Workshop members can delete insight_tows_relationships" on public.insight_tows_relationships for delete to authenticated using (
  exists (select 1 from public.insights i where i.id = insight_id and public.is_workshop_member(i.workshop_id))
);

create policy "Workshop members can view recommendations" on public.recommendations for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage recommendations" on public.recommendations for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update recommendations" on public.recommendations for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete recommendations" on public.recommendations for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view recommendation_insights" on public.recommendation_insights for select to authenticated using (
  exists (select 1 from public.recommendations r where r.id = recommendation_id and public.is_workshop_member(r.workshop_id))
);
create policy "Workshop members can manage recommendation_insights" on public.recommendation_insights for insert to authenticated with check (
  exists (select 1 from public.recommendations r where r.id = recommendation_id and public.is_workshop_member(r.workshop_id))
);
create policy "Workshop members can delete recommendation_insights" on public.recommendation_insights for delete to authenticated using (
  exists (select 1 from public.recommendations r where r.id = recommendation_id and public.is_workshop_member(r.workshop_id))
);

create policy "Workshop members can view actions" on public.actions for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage actions" on public.actions for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update actions" on public.actions for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete actions" on public.actions for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view reports" on public.reports for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can manage reports" on public.reports for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update reports" on public.reports for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete reports" on public.reports for delete to authenticated using (public.is_workshop_member(workshop_id));

create policy "Workshop members can view narratives" on public.narratives for select to authenticated using (
  exists (select 1 from public.reports r where r.id = report_id and public.is_workshop_member(r.workshop_id))
);
create policy "Workshop members can manage narratives" on public.narratives for insert to authenticated with check (
  exists (select 1 from public.reports r where r.id = report_id and public.is_workshop_member(r.workshop_id))
);
create policy "Workshop members can update narratives" on public.narratives for update to authenticated using (
  exists (select 1 from public.reports r where r.id = report_id and public.is_workshop_member(r.workshop_id))
);
create policy "Workshop members can delete narratives" on public.narratives for delete to authenticated using (
  exists (select 1 from public.reports r where r.id = report_id and public.is_workshop_member(r.workshop_id))
);

create policy "Workshop members can view ai_sessions" on public.ai_sessions for select to authenticated using (workshop_id is null or public.is_workshop_member(workshop_id));
create policy "Workshop members can create ai_sessions" on public.ai_sessions for insert to authenticated with check (user_id = auth.uid() and (workshop_id is null or public.is_workshop_member(workshop_id)));

create policy "Workshop members can view ai_outputs" on public.ai_outputs for select to authenticated using (
  exists (select 1 from public.ai_sessions s where s.id = ai_session_id and (s.workshop_id is null or public.is_workshop_member(s.workshop_id)))
);
create policy "Workshop members can create ai_outputs" on public.ai_outputs for insert to authenticated with check (
  exists (select 1 from public.ai_sessions s where s.id = ai_session_id and (s.workshop_id is null or public.is_workshop_member(s.workshop_id)))
);
create policy "Workshop members can update ai_outputs" on public.ai_outputs for update to authenticated using (
  exists (select 1 from public.ai_sessions s where s.id = ai_session_id and (s.workshop_id is null or public.is_workshop_member(s.workshop_id)))
);

-- notifications: strictly per-recipient.
create policy "Users can view their own notifications" on public.notifications for select to authenticated using (recipient_id = auth.uid());
create policy "Users can update their own notifications" on public.notifications for update to authenticated using (recipient_id = auth.uid());
create policy "Authenticated users can create notifications" on public.notifications for insert to authenticated with check (true);

-- audit_events: simplified for MLP — any authenticated user may write an event and
-- read the audit trail. Tightening this to per-object membership scoping is possible
-- once the application layer that writes these events is built.
create policy "Authenticated users can view audit events" on public.audit_events for select to authenticated using (true);
create policy "Authenticated users can create audit events" on public.audit_events for insert to authenticated with check (true);

-- ============================================================
-- Grants (RLS still applies on top of these for the authenticated role)
-- ============================================================

grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on
  public.organizations, public.workspaces, public.profiles, public.workspace_members,
  public.workshops, public.workshop_members, public.activities, public.artifacts,
  public.votes, public.comments, public.themes, public.theme_artifacts,
  public.tows_relationships, public.insights, public.insight_themes,
  public.insight_tows_relationships, public.recommendations, public.recommendation_insights,
  public.actions, public.reports, public.narratives, public.ai_sessions, public.ai_outputs,
  public.notifications, public.audit_events
to authenticated;

grant all on
  public.organizations, public.workspaces, public.profiles, public.workspace_members,
  public.workshops, public.workshop_members, public.activities, public.artifacts,
  public.votes, public.comments, public.themes, public.theme_artifacts,
  public.tows_relationships, public.insights, public.insight_themes,
  public.insight_tows_relationships, public.recommendations, public.recommendation_insights,
  public.actions, public.reports, public.narratives, public.ai_sessions, public.ai_outputs,
  public.notifications, public.audit_events
to service_role;
