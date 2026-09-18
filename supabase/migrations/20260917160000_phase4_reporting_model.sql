-- ============================================================
-- Phase 4 — Reporting data model
--
-- `reports` and `narratives` were left behind by the generic-engine
-- migration. They still carry hardcoded SWOT enums, use a different
-- governance vocabulary from every other object type, and `narratives` cannot
-- express ordering or inclusion. This fixes all three, and adds the
-- versioning App Spec §14.24 requires.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Remove the hardcoded enums
--
-- reports.report_type allowed ('executive','swot','tows','recommendation',
-- 'workshop_summary') and narratives.narrative_type allowed five fixed
-- SWOT-flavoured values. A PESTLE report would be rejected by the database.
-- Same violation removed from ai_outputs.output_type in Phase 3.
--
-- Constraints are dropped by name DISCOVERED from pg_constraint, never by an
-- assumed name: Postgres keeps a constraint's original name across a table
-- rename, which broke the Phase 2 migration (syntheses still carried
-- "themes_state_check"). This migration renames narratives, so the same trap
-- applies to anything added here later.
-- ------------------------------------------------------------

do $$
declare con text;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%report_type%'
  loop execute format('alter table public.reports drop constraint %I', con); end loop;

  for con in
    select conname from pg_constraint
    where conrelid = 'public.narratives'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%narrative_type%'
  loop execute format('alter table public.narratives drop constraint %I', con); end loop;

  for con in
    select conname from pg_constraint
    where conrelid = 'public.reports'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%status%'
  loop execute format('alter table public.reports drop constraint %I', con); end loop;
end $$;

alter table public.reports drop constraint if exists reports_report_type_nonempty;
alter table public.reports add constraint reports_report_type_nonempty
  check (length(trim(report_type)) > 0);

-- ------------------------------------------------------------
-- 2. One governance vocabulary
--
-- `status` is renamed to `state` so reports match the other five object
-- types. `generated_by` on reports was a profiles FK, while `generated_by`
-- everywhere else is 'human'|'ai'|'hybrid' — a name collision that would
-- break generic code, so the FK becomes created_by and generated_by takes
-- its usual meaning.
-- ------------------------------------------------------------

alter table public.reports rename column status to state;
alter table public.reports rename column generated_by to created_by;

alter table public.reports
  add column if not exists generated_by text not null default 'human',
  add column if not exists reviewed_by  uuid references public.profiles(id),
  add column if not exists reviewed_at  timestamptz,
  add column if not exists review_note  text,
  add column if not exists published_by uuid references public.profiles(id),
  add column if not exists archived_at  timestamptz;

-- The spec's "Review" is this platform's "submitted", as in Phase 2.
update public.reports set state = 'submitted' where state = 'review';
update public.reports set state = 'draft'
  where state is null
     or state not in ('draft','submitted','approved','published','rejected','archived');

alter table public.reports drop constraint if exists reports_state_check;
alter table public.reports add constraint reports_state_check
  check (state in ('draft','submitted','approved','published','rejected','archived'));

alter table public.reports drop constraint if exists reports_generated_by_check;
alter table public.reports add constraint reports_generated_by_check
  check (generated_by in ('human','ai','hybrid'));

alter table public.reports drop constraint if exists reports_review_attribution_check;
alter table public.reports add constraint reports_review_attribution_check
  check (state not in ('approved','rejected')
         or (reviewed_by is not null and reviewed_at is not null));

-- ------------------------------------------------------------
-- 3. Versioning (§14.24) — a version chain plus a publish-time snapshot
--
-- Each version is its own row, linked by root_id. The snapshot is what makes
-- a published report REPRODUCIBLE: sections otherwise hold pointers, so
-- rejecting an insight next month would silently rewrite a report published
-- today. Storing the resolved data (not a rendered PDF) means an export can
-- be re-rendered deterministically later.
-- ------------------------------------------------------------

alter table public.reports
  add column if not exists root_id           uuid references public.reports(id),
  add column if not exists supersedes_id     uuid references public.reports(id),
  add column if not exists version_major     integer not null default 1,
  add column if not exists version_minor     integer not null default 0,
  add column if not exists snapshot          jsonb,
  add column if not exists snapshot_taken_at timestamptz;

update public.reports set root_id = id where root_id is null;
alter table public.reports alter column root_id set not null;

-- Publishing is where a report becomes an organizational record. It must name
-- a human publisher — App Spec §14.25: "The AI Assistant cannot publish
-- reports" — and it must carry its snapshot, so "published without a
-- snapshot" is unrepresentable rather than merely discouraged.
alter table public.reports drop constraint if exists reports_publish_attribution_check;
alter table public.reports add constraint reports_publish_attribution_check
  check (state <> 'published'
         or (published_by is not null and published_at is not null and snapshot is not null));

create unique index if not exists uq_reports_root_version
  on public.reports (root_id, version_major, version_minor);

-- Without this, two facilitators can each branch v1.1 from v1.0.
create unique index if not exists uq_reports_one_open_version
  on public.reports (root_id) where state in ('draft','submitted','approved');

create index if not exists idx_reports_workshop_state on public.reports (workshop_id, state);
create index if not exists idx_reports_root
  on public.reports (root_id, version_major desc, version_minor desc);

-- Target for the composite FK from sections below.
create unique index if not exists uq_reports_id_workshop on public.reports (id, workshop_id);

-- ------------------------------------------------------------
-- 4. narratives -> report_sections
--
-- Renamed rather than replaced so the trigger, grants, RLS policies and OID
-- survive — the same approach used for artifacts -> factors.
--
-- section_type is a PLATFORM renderer vocabulary, the same class of thing as
-- methodology_stages.stage_type: a methodology chooses which renderers it
-- uses and what feeds them, but cannot invent one without a React component.
-- App Spec §14.21's eight section types map onto these one to one.
-- ------------------------------------------------------------

alter table public.narratives rename to report_sections;
alter table public.report_sections rename column narrative_type to section_key;
alter table public.report_sections rename column content to body;

alter index if exists narratives_pkey rename to report_sections_pkey;
alter trigger narratives_updated_at on public.report_sections rename to report_sections_updated_at;

alter table public.report_sections
  add column if not exists workshop_id  uuid,
  add column if not exists section_type text not null default 'narrative',
  add column if not exists sort_order   integer not null default 0,
  add column if not exists included     boolean not null default true,
  add column if not exists source       jsonb not null default '{}'::jsonb,
  add column if not exists edited_by    uuid references public.profiles(id),
  add column if not exists edited_at    timestamptz;

-- A matrix or table section has no prose.
alter table public.report_sections alter column body drop not null;

update public.report_sections s set workshop_id = r.workshop_id
  from public.reports r where r.id = s.report_id and s.workshop_id is null;
alter table public.report_sections alter column workshop_id set not null;

-- The denormalised workshop_id cannot drift: the composite FK makes an
-- inconsistent pair unrepresentable. It exists so authz and the
-- belongs-to-this-workshop checks can run without a join, matching how every
-- other table works.
alter table public.report_sections drop constraint if exists narratives_report_id_fkey;
alter table public.report_sections drop constraint if exists report_sections_report_workshop_fk;
alter table public.report_sections
  add constraint report_sections_report_workshop_fk
  foreign key (report_id, workshop_id)
  references public.reports(id, workshop_id) on delete cascade;

alter table public.report_sections drop constraint if exists report_sections_type_check;
alter table public.report_sections add constraint report_sections_type_check
  check (section_type in (
    'narrative','bullet_list','table','object_list',
    'category_matrix','pair_matrix','evidence_chain','appendix'
  ));

alter table public.report_sections drop constraint if exists report_sections_generated_by_check;
alter table public.report_sections add constraint report_sections_generated_by_check
  check (generated_by in ('human','ai','hybrid'));

-- §14.13 requires the UI to "clearly distinguish between AI-generated content
-- and human-edited content". 'hybrid' means an AI draft a person changed, so
-- it must name that person.
alter table public.report_sections drop constraint if exists report_sections_edit_attribution_check;
alter table public.report_sections add constraint report_sections_edit_attribution_check
  check (generated_by <> 'hybrid' or (edited_by is not null and edited_at is not null));

-- source_ai_output_id was a bare uuid with no foreign key.
alter table public.report_sections drop constraint if exists report_sections_ai_source_fk;
alter table public.report_sections
  add constraint report_sections_ai_source_fk
  foreign key (source_ai_output_id) references public.ai_outputs(id) on delete set null;

create index if not exists idx_report_sections_report_order
  on public.report_sections (report_id, sort_order);
create index if not exists idx_report_sections_workshop
  on public.report_sections (workshop_id);

-- Replace the join-based policies inherited from narratives with direct ones.
drop policy if exists "Workshop members can view narratives"   on public.report_sections;
drop policy if exists "Workshop members can insert narratives" on public.report_sections;
drop policy if exists "Workshop members can update narratives" on public.report_sections;
drop policy if exists "Workshop members can delete narratives" on public.report_sections;
drop policy if exists "Workshop members can manage narratives" on public.report_sections;

create policy "Workshop members can view report sections" on public.report_sections
  for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can insert report sections" on public.report_sections
  for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update report sections" on public.report_sections
  for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete report sections" on public.report_sections
  for delete to authenticated using (public.is_workshop_member(workshop_id));

-- ------------------------------------------------------------
-- 5. Per-item inclusion (§14.13 "include or exclude recommendations")
--
-- object_kind's vocabulary is the object registry's keys plus 'factor' —
-- platform constants, so a CHECK is legitimate here for the same reason
-- stage_type has one. Deliberately NO foreign key to the object tables: a
-- cascade would silently gut a published report.
-- ------------------------------------------------------------

create table if not exists public.report_section_items (
  id uuid primary key default gen_random_uuid(),
  report_section_id uuid not null references public.report_sections(id) on delete cascade,
  workshop_id       uuid not null references public.workshops(id) on delete cascade,
  object_kind text not null,
  object_id   uuid not null,
  sort_order  integer not null default 0,
  included    boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  constraint report_section_items_kind_check check (object_kind in
    ('factor','synthesis','factor_relationship','insight','recommendation')),
  unique (report_section_id, object_kind, object_id)
);

create index if not exists idx_report_section_items_section
  on public.report_section_items (report_section_id, sort_order);
create index if not exists idx_report_section_items_object
  on public.report_section_items (object_kind, object_id);

alter table public.report_section_items enable row level security;

create policy "Workshop members can view report section items" on public.report_section_items
  for select to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can insert report section items" on public.report_section_items
  for insert to authenticated with check (public.is_workshop_member(workshop_id));
create policy "Workshop members can update report section items" on public.report_section_items
  for update to authenticated using (public.is_workshop_member(workshop_id));
create policy "Workshop members can delete report section items" on public.report_section_items
  for delete to authenticated using (public.is_workshop_member(workshop_id));

grant select, insert, update, delete on public.report_section_items to authenticated;
grant all on public.report_section_items to service_role;

-- ------------------------------------------------------------
-- 6. Immutability once published (§14.24)
-- ------------------------------------------------------------

create or replace function public.reports_immutable_when_published()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.state in ('published','archived') then
      raise exception 'A published report cannot be deleted; archive it or publish a new version.'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.state = 'published' then
    if new.state not in ('published','archived') then
      raise exception 'A published report cannot move to %; create a new version instead.', new.state
        using errcode = 'restrict_violation';
    end if;
    if (to_jsonb(new) - 'state' - 'archived_at' - 'updated_at')
       is distinct from (to_jsonb(old) - 'state' - 'archived_at' - 'updated_at') then
      raise exception 'A published report is immutable; create a new version instead.'
        using errcode = 'restrict_violation';
    end if;
  elsif old.state = 'archived' then
    raise exception 'An archived report cannot be modified.' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

drop trigger if exists reports_immutable on public.reports;
create trigger reports_immutable
  before update or delete on public.reports
  for each row execute function public.reports_immutable_when_published();

-- A published report's content is frozen too, or the snapshot and the rows
-- would disagree.
--
-- NOTE for the publish transaction: write the sections, build the snapshot,
-- and only THEN flip state to 'published'. Flipping first makes this trigger
-- reject the rest of your own transaction.
create or replace function public.report_children_immutable()
returns trigger language plpgsql as $$
declare parent_state text; rid uuid;
begin
  if tg_table_name = 'report_sections' then
    rid := coalesce(new.report_id, old.report_id);
  else
    select report_id into rid from public.report_sections
     where id = coalesce(new.report_section_id, old.report_section_id);
  end if;
  select state into parent_state from public.reports where id = rid;
  if parent_state in ('published','archived') then
    raise exception 'Content of a published report cannot be changed; create a new version.'
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists report_sections_frozen on public.report_sections;
create trigger report_sections_frozen
  before insert or update or delete on public.report_sections
  for each row execute function public.report_children_immutable();

drop trigger if exists report_section_items_frozen on public.report_section_items;
create trigger report_section_items_frozen
  before insert or update or delete on public.report_section_items
  for each row execute function public.report_children_immutable();

-- ------------------------------------------------------------
-- 7. Which published reports now cite something that was later rejected
--
-- security_invoker is not optional: a plain view runs as its owner and would
-- read across workshops, past RLS.
-- ------------------------------------------------------------

create or replace view public.report_stale_citations
with (security_invoker = true) as
select r.id as report_id, r.workshop_id,
       'v' || r.version_major || '.' || r.version_minor as version_label,
       i.object_kind, i.object_id, o.state as current_state
from public.reports r
join public.report_sections s      on s.report_id = r.id and s.included
join public.report_section_items i on i.report_section_id = s.id and i.included
join lateral (
  select state from public.factors              where id = i.object_id and i.object_kind = 'factor'
  union all
  select state from public.syntheses            where id = i.object_id and i.object_kind = 'synthesis'
  union all
  select state from public.factor_relationships where id = i.object_id and i.object_kind = 'factor_relationship'
  union all
  select state from public.insights             where id = i.object_id and i.object_kind = 'insight'
  union all
  select state from public.recommendations      where id = i.object_id and i.object_kind = 'recommendation'
) o on true
where r.state = 'published' and o.state <> 'approved';

grant select on public.report_stale_citations to authenticated, service_role;
