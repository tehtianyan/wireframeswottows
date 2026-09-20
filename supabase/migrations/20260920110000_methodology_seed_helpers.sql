-- ============================================================
-- Seeding helpers, so a methodology's own migration says only what makes it
-- different
--
-- Seven methodologies are about to be configured. Almost all of what they need
-- is already methodology-neutral: the AI prompt templates are keyed by
-- STAGE TYPE and interpolate {{factor_category_name}}, {{workshop_objective}}
-- and so on, so a capture prompt written for SWOT-TOWS works verbatim for
-- PESTLE's six categories, Porter's five forces and the Business Model
-- Canvas's nine blocks.
--
-- Rather than restate ten prompts in each of seven files — where they would
-- drift — this copies them, taking only the ones whose stage type the target
-- actually has. A methodology with no relate stage gets no relationship
-- prompt, and its AI panel therefore offers nothing it cannot do.
--
-- This is platform plumbing added once, like the weight tables. Configuring an
-- eighth methodology still writes no Go, no React and no schema.
-- ============================================================

create or replace function public.seed_methodology_ai_prompts(target_key text)
returns integer
language plpgsql
as $$
declare
  target_id uuid;
  source_id uuid;
  inserted integer;
begin
  select id into target_id from public.methodologies where key = target_key;
  if target_id is null then
    raise exception 'seed_methodology_ai_prompts: no methodology with key %', target_key;
  end if;

  -- SWOT-TOWS is the reference set purely because it was configured first and
  -- has one prompt per stage type. Nothing about it is privileged.
  select id into source_id from public.methodologies where key = 'swot-tows';
  if source_id is null then
    raise exception 'seed_methodology_ai_prompts: the reference methodology is missing';
  end if;

  insert into public.methodology_ai_prompts
    (methodology_id, function_key, stage_type, name, prompt_template,
     output_schema, prompt_version, output_kind)
  select
    target_id,
    p.function_key,
    p.stage_type,
    -- "Generate TOWS Relationships" is the one name carrying another
    -- methodology's vocabulary. Nothing else does.
    replace(p.name, 'TOWS ', ''),
    -- The theme prompt warns against generic names by example, and its
    -- examples are SWOT's. Replaced with methodology-neutral ones so no
    -- other methodology's words travel inside a prompt.
    replace(replace(p.prompt_template, '"Strengths"', '"Themes"'), '"Risks"', '"Issues"'),
    p.output_schema,
    p.prompt_version,
    p.output_kind
  from public.methodology_ai_prompts p
  where p.methodology_id = source_id
    -- A prompt with no stage type is workshop-wide and always applies.
    -- One tied to a stage type applies only if the target has such a stage.
    and (
      coalesce(p.stage_type, '') = ''
      or exists (
        select 1 from public.methodology_stages s
        where s.methodology_id = target_id and s.stage_type = p.stage_type
      )
    )
  on conflict (methodology_id, function_key) do nothing;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

comment on function public.seed_methodology_ai_prompts(text) is
  'Copies the stage-type-keyed AI prompts to a methodology, taking only those whose stage type it has. Seed-time helper; not called at runtime.';
