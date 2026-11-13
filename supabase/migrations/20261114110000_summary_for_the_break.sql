-- Summarize Workshop is pressed during the coffee break (UAT 2026-11-14).
--
-- "The 'Summarize the Workshop' button should summarize outstanding actions
-- and next steps in the workshop. The goal is to give the facilitator a simple
-- button to click during the break time to prepare the next phase of the
-- workshop. Keep the language simple and the next actions directly
-- actionable."
--
-- THE PROMPT WAS NOT THE ONLY PROBLEM, AND IT WAS THE SMALLER HALF. The old
-- template asked for incomplete items from "the supplied activity status",
-- and the context it was given carried no activity status at all: factors,
-- themes, insights and recommendations, and nothing about where the room had
-- got to. So "incomplete_items" was produced by inference from content — a
-- guess dressed as a finding. `fetchWorkshopStanding` now supplies derived
-- stage progress, the review queues by kind, the actions with their owners and
-- delivery columns, and how many people have actually contributed.
--
-- THE SCHEMA CHANGES WITH IT, which is why this is a migration and not an
-- edit. `completed_work` and `emerging_findings` described the workshop to
-- somebody who was not there; a facilitator with four minutes and a cooling
-- coffee needs the opposite — what is done, what is stuck, what to say when
-- everybody sits back down.
--
-- `on conflict do update`, because a prompt is CONFIGURATION that carries
-- tuning, and re-running a seed must not throw away a better wording.

begin;

update public.methodology_ai_prompts
set
  prompt_template =
    'You are helping a workshop facilitator who has stepped out for a short break and ' ||
    'has a few minutes to prepare what happens next in "{{workshop_name}}".' || E'\n\n' ||
    'Write for somebody standing up holding a coffee. Short sentences. No jargon, no ' ||
    'consulting register, no restating what a SWOT or a matrix is. Never invent an ' ||
    'item, a name or a number that is not in the data you were given.' || E'\n\n' ||
    'Use the supplied stage progress, review queues, themes, actions, owners and ' ||
    'delivery states. Work out:' || E'\n' ||
    '- where_we_are: two or three sentences on what the room has finished and what it ' ||
    'is in the middle of. Name stages by their own names.' || E'\n' ||
    '- outstanding: the things that are genuinely waiting on somebody — items ' ||
    'submitted and not yet reviewed, actions with no owner, stages with nothing in ' ||
    'them. Each one a single line saying what it is and how many. Leave it empty if ' ||
    'nothing is outstanding; do not pad it.' || E'\n' ||
    '- next_steps: what to do when everybody sits back down, in order, each starting ' ||
    'with a verb and naming the stage or the people involved. Three to five at most. ' ||
    'These must be doable in the next part of the session, not strategic advice.' || E'\n' ||
    '- say_to_the_room: one or two sentences the facilitator could say out loud to ' ||
    'restart the session, in their voice, referring to what the room actually produced.' ||
    E'\n\n' ||
    'awaiting_review is the ONLY authority on what is waiting for a decision: it counts ' ||
    'each item once, by kind. Do not count the same submissions again from the factor or ' ||
    'theme lists — "2 strengths waiting" and "2 notes waiting" are the same two items, ' ||
    'and a facilitator reading both would think there were four.' || E'\n\n' ||
    'A stage marked facilitator_only is a tool, not a step the room is behind on — ' ||
    'never tell them to chase it. If several people are on the roster but few have ' ||
    'contributed, say so plainly in where_we_are: that is a fact about the session, ' ||
    'not a criticism of anybody.',
  output_schema =
    '{"summary":{"where_we_are":"","outstanding":[],"next_steps":[],"say_to_the_room":""}}'::jsonb
where function_key = 'workshop_summary';

-- ------------------------------------------------------------- verified ----
do $$
declare
  n int;
  bad int;
begin
  select count(*) into n
  from public.methodology_ai_prompts where function_key = 'workshop_summary';
  if n = 0 then
    raise exception 'no workshop_summary prompt to update — the seed is missing';
  end if;

  -- EVERY ONE OF THEM, not just SWOT-TOWS. The prompt is seeded per
  -- methodology by seed_methodology_ai_prompts, so updating one row would
  -- leave the other seven answering with the old schema — and the client
  -- picks its renderer from the declared output_kind and walks whatever keys
  -- the schema declares, so a stale schema renders a summary with the wrong
  -- headings rather than failing visibly.
  select count(*) into bad
  from public.methodology_ai_prompts
  where function_key = 'workshop_summary'
    and not (output_schema -> 'summary' ? 'next_steps');
  if bad > 0 then
    raise exception '% workshop_summary prompt(s) still carry the old schema', bad;
  end if;

  -- It stays a narrative: this is something to READ, not suggestions to
  -- accept, and ExecuteAI refuses to "accept" one for exactly that reason.
  select count(*) into bad
  from public.methodology_ai_prompts
  where function_key = 'workshop_summary' and output_kind <> 'narrative';
  if bad > 0 then
    raise exception '% workshop_summary prompt(s) are not narratives', bad;
  end if;
end $$;

commit;
