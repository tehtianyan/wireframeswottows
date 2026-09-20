-- ============================================================
-- The roster's vote count follows voting into public.weights
--
-- 20260920100000 made voting one instance of a weight and stopped writing to
-- public.votes. Four things still read that table and would have silently
-- reported zero: the factor list's vote count, the AI context, the report
-- renderer, and this view — which is what the Participants panel displays.
-- The first three are fixed in Go; this is the fourth.
--
-- The test suites did not catch any of them, because none of them assert a
-- vote count on a factor card or in the roster. That gap is closed in
-- tests/suites/weights.js.
--
-- BEHAVIOUR CHANGE, deliberate and called out: votes_used counted ROWS, so it
-- reported how many factors a person had voted on, not how many votes they had
-- spent. The Participants panel renders it as "{votes_used}/{budget} votes"
-- and drives a progress bar from it, so with a budget of 20 someone who had
-- spent all 20 votes across 3 factors showed as 3/20. It now sums the
-- allocations, which is what the label has always claimed.
-- ============================================================

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
  select workshop_id, user_id, sum(value) as votes_used
  from public.weights
  where weight_key = 'vote' and user_id is not null
  group by workshop_id, user_id
) v on v.workshop_id = wm.workshop_id and v.user_id = wm.user_id
left join (
  -- public.artifacts was renamed to public.factors by the generic engine
  -- migration; a view stores its references by OID, so this followed the
  -- rename automatically and counts factors.
  select workshop_id, created_by, count(*) as artifacts_count
  from public.factors where created_by is not null group by workshop_id, created_by
) a on a.workshop_id = wm.workshop_id and a.created_by = wm.user_id
left join (
  select workshop_id, created_by, count(*) as comments_count
  from public.comments where created_by is not null group by workshop_id, created_by
) c on c.workshop_id = wm.workshop_id and c.created_by = wm.user_id;

grant select on public.workshop_roster to authenticated;
grant select on public.workshop_roster to service_role;
