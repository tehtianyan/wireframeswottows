-- ============================================================
-- SECURITY: public._migrations was world-readable and world-WRITABLE
--
-- Supabase's security advisor flagged `rls_disabled_in_public` on
-- public._migrations. Confirmed on BOTH projects, over HTTP, with nothing but
-- the publishable key that ships in the browser bundle by design:
--
--   GET /rest/v1/_migrations?select=name,applied_at  ->  200, full contents
--
-- and `anon` held DELETE, INSERT, SELECT, TRUNCATE and UPDATE on it.
--
-- Every other table in `public` held correctly: factors, profiles, workshops
-- and workshop_roster all returned [] to an anonymous caller. So no workshop
-- content and no personal data were exposed — the table holds migration
-- filenames and timestamps only.
--
-- WHY IT WAS THE ONE GAP. Every other table was created by a migration, which
-- enables RLS as a matter of course (CLAUDE.md: "RLS is enabled on every table
-- as a secondary safety net"). This one was created by the migration RUNNER
-- itself — `scripts/migrate.mjs` does `create table if not exists
-- public._migrations`, outside the system that would have secured it. A table
-- created by tooling skips the convention the tooling exists to apply.
--
-- THE REAL RISK WAS INTEGRITY, NOT CONFIDENTIALITY. The ledger decides which
-- migrations still need applying, so an anonymous writer could:
--   * TRUNCATE it, making the next --apply replay all 28 migrations; or
--   * INSERT a pending filename, making the runner SILENTLY SKIP a real
--     migration — a deploy that reports success against the wrong schema.
--
-- FIX: enable RLS, add NO policies, and revoke the grants.
--
-- No policies is deliberate, not an oversight. Nothing legitimate reads this
-- table through PostgREST: the runner connects over DATABASE_URL as `postgres`,
-- which has rolbypassrls and is unaffected. RLS with zero policies therefore
-- denies anon and authenticated outright, which is exactly right here.
-- Supabase's advisor may report "RLS enabled, no policies" as an informational
-- notice afterwards; for this table that notice describes the intent.
--
-- The grants are revoked as well as RLS enabled, so the table is not exposed
-- again by anyone merely turning RLS off.
-- ============================================================

create table if not exists public._migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

alter table public._migrations enable row level security;

-- Belt as well as braces: with no grant, PostgREST cannot reach the table even
-- if RLS is ever disabled again.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public._migrations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public._migrations from authenticated;
  end if;
end $$;

revoke all on public._migrations from public;

comment on table public._migrations is
  'Migration ledger, read and written ONLY by scripts/migrate.mjs as the postgres role. RLS is enabled with NO policies on purpose: no client may read or write it. Do not add a policy.';

-- ------------------------------------------------------------
-- A standing guard, so this class of gap is caught by the database rather than
-- by an advisor email.
--
-- Any future table added to `public` without RLS will show up here, and
-- tests/suites/scoping.js asserts this view is EMPTY. That assertion is the
-- generalisable lesson: the bug was not "this table"; it was that nothing
-- checked the convention held.
-- ------------------------------------------------------------

create or replace view public.rls_coverage_gaps
with (security_invoker = true) as
select c.relname as table_name,
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and not c.relrowsecurity;

comment on view public.rls_coverage_gaps is
  'Tables in public with RLS disabled. Must always be empty; tests/suites/scoping.js asserts it. Reads pg_class, so an unprivileged caller sees nothing regardless.';

revoke all on public.rls_coverage_gaps from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.rls_coverage_gaps from anon;
  end if;
end $$;

-- Fail the migration rather than report success if anything is still uncovered.
do $$
declare bad text;
begin
  select string_agg(table_name, ', ' order by table_name) into bad
  from public.rls_coverage_gaps;
  if bad is not null then
    raise exception 'tables still without RLS: %', bad;
  end if;
end $$;
