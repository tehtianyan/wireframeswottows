-- Roster view: joins workshop_members + profiles with real aggregate counts
-- from votes/artifacts/comments. security_invoker means it respects the RLS
-- of the querying user, not the view owner.

create or replace view public.workshop_roster
with (security_invoker = true) as
select
  wm.workshop_id,
  wm.user_id as id,
  p.email,
  coalesce(p.display_name, trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), p.email) as name,
  wm.role,
  wm.joined_at,
  wm.invited_at,
  case when wm.joined_at is not null then 'active' else 'invited' end as status,
  coalesce(v.votes_used, 0)::int as votes_used,
  coalesce(a.artifacts_count, 0)::int as artifacts_count,
  coalesce(c.comments_count, 0)::int as comments_count
from public.workshop_members wm
join public.profiles p on p.id = wm.user_id
left join (
  select workshop_id, user_id, count(*) as votes_used
  from public.votes group by workshop_id, user_id
) v on v.workshop_id = wm.workshop_id and v.user_id = wm.user_id
left join (
  select workshop_id, created_by, count(*) as artifacts_count
  from public.artifacts where created_by is not null group by workshop_id, created_by
) a on a.workshop_id = wm.workshop_id and a.created_by = wm.user_id
left join (
  select workshop_id, created_by, count(*) as comments_count
  from public.comments where created_by is not null group by workshop_id, created_by
) c on c.workshop_id = wm.workshop_id and c.created_by = wm.user_id;

grant select on public.workshop_roster to authenticated;
grant select on public.workshop_roster to service_role;
