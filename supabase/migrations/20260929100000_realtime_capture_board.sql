-- ============================================================
-- Realtime for the capture board — and the RLS fix it requires
--
-- The capture board shows every factor category at once and fills in live as
-- people contribute. Live means a Supabase Realtime subscription, which is the
-- FIRST client-side read in this product that does not pass through Go.
--
-- That matters more than it sounds. CLAUDE.md records that "Go is the trust
-- boundary" and that RLS is a secondary net only, because Go connects as
-- `postgres`, which has rolbypassrls. A Realtime subscription goes straight
-- from the browser to Postgres and is authorised by RLS ALONE. So RLS stops
-- being a net and becomes the gate — and it was not correct.
--
-- public.is_workshop_member() checked ONLY workshop_members. pkg/authz was
-- fixed on 2026-09-18 to also enforce level 1 of App Spec §11.5 by joining
-- through workspace_members, because removing someone from a workspace did NOT
-- revoke their workshop access. The RLS function never got the same fix.
--
-- Harmless while nothing read through RLS. Shipping Realtime without this
-- would reintroduce exactly that hole, with live push as the delivery
-- mechanism: a person removed from a workspace would keep receiving every
-- factor as it was typed. The two changes ship together or not at all.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Make RLS agree with pkg/authz.
--
-- Mirrors the query in pkg/authz/authz.go exactly. Every RLS policy on
-- factors, syntheses, insights, recommendations, votes and the rest calls
-- this, so it tightens all of them at once — which is the point.
-- ------------------------------------------------------------

create or replace function public.is_workshop_member(target_workshop_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.workshop_members wm
    join public.workshops w on w.id = wm.workshop_id
    join public.workspace_members wsm
         on wsm.workspace_id = w.workspace_id and wsm.user_id = wm.user_id
    where wm.workshop_id = target_workshop_id
      and wm.user_id = auth.uid()
  );
$function$;

comment on function public.is_workshop_member(uuid) is
  'App Spec 11.5 levels 1 and 2: workspace membership AND workshop membership. Must stay identical to pkg/authz/authz.go — Realtime subscriptions are authorised by this function alone.';

-- ------------------------------------------------------------
-- 2. Publish factors for Realtime.
--
-- supabase_realtime exists but publishes nothing today, so this is the first
-- table on it. Deliberately factors ONLY: the board is the only live surface,
-- and every extra table is another read path that bypasses Go.
-- ------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'factors'
  ) then
    alter publication supabase_realtime add table public.factors;
  end if;
end $$;

-- UPDATE and DELETE payloads carry only the primary key under the default
-- replica identity. The board needs the whole row to know which quadrant a
-- note left, so a deletion can be removed from the right panel.
alter table public.factors replica identity full;
