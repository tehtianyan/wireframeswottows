-- Generic Methodology Engine
-- Introduces methodology configuration tables and generalizes the SWOT-TOWS-specific
-- object tables (artifacts/tows_relationships/themes/...) into methodology-neutral
-- equivalents (factors/factor_relationships/syntheses/...) that reference config
-- rows instead of hardcoded CHECK-constraint enums. SWOT-TOWS becomes the first
-- methodology expressed as data against this engine, not a special case.
--
-- Safe to run now: only demo/seed data exists (12 profiles, 1 workshop, 10
-- activities, 8 artifacts, 2 themes) — no real usage to preserve beyond that.

-- ============================================================
-- Config tables
-- ============================================================

create table public.methodologies (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  version text not null default '1.0',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger methodologies_updated_at before update on public.methodologies
  for each row execute function public.set_updated_at();

create table public.methodology_factor_categories (
  id uuid primary key default gen_random_uuid(),
  methodology_id uuid not null references public.methodologies(id) on delete cascade,
  key text not null,
  name text not null,
  color_token text,
  sort_order integer not null default 0,
  guidance_text text,
  created_at timestamptz not null default now(),
  unique(methodology_id, key)
);

create table public.methodology_stages (
  id uuid primary key default gen_random_uuid(),
  methodology_id uuid not null references public.methodologies(id) on delete cascade,
  key text not null,
  name text not null,
  sequence_number integer not null,
  stage_type text not null,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(methodology_id, key),
  constraint methodology_stages_type_check check (stage_type in (
    'capture','prioritize','synthesize','relate','interpret','recommend','report','knowledge'
  ))
);

create table public.methodology_relationship_types (
  id uuid primary key default gen_random_uuid(),
  methodology_id uuid not null references public.methodologies(id) on delete cascade,
  key text not null,
  name text not null,
  source_category_id uuid references public.methodology_factor_categories(id),
  target_category_id uuid references public.methodology_factor_categories(id),
  guidance_text text,
  created_at timestamptz not null default now(),
  unique(methodology_id, key)
);

create table public.methodology_ai_prompts (
  id uuid primary key default gen_random_uuid(),
  methodology_id uuid not null references public.methodologies(id) on delete cascade,
  function_key text not null,
  stage_id uuid references public.methodology_stages(id),
  name text not null,
  prompt_template text not null,
  output_schema jsonb,
  prompt_version text not null default 'v1.0',
  created_at timestamptz not null default now(),
  unique(methodology_id, function_key)
);

alter table public.methodologies enable row level security;
alter table public.methodology_factor_categories enable row level security;
alter table public.methodology_stages enable row level security;
alter table public.methodology_relationship_types enable row level security;
alter table public.methodology_ai_prompts enable row level security;

create policy "Authenticated users can view methodologies" on public.methodologies for select to authenticated using (true);
create policy "Authenticated users can view factor categories" on public.methodology_factor_categories for select to authenticated using (true);
create policy "Authenticated users can view stages" on public.methodology_stages for select to authenticated using (true);
create policy "Authenticated users can view relationship types" on public.methodology_relationship_types for select to authenticated using (true);
create policy "Authenticated users can view ai prompts" on public.methodology_ai_prompts for select to authenticated using (true);

grant usage on schema public to authenticated;
grant select on
  public.methodologies, public.methodology_factor_categories, public.methodology_stages,
  public.methodology_relationship_types, public.methodology_ai_prompts
to authenticated;
grant all on
  public.methodologies, public.methodology_factor_categories, public.methodology_stages,
  public.methodology_relationship_types, public.methodology_ai_prompts
to service_role;

-- ============================================================
-- Seed: SWOT-TOWS methodology, expressed entirely as config
-- ============================================================

insert into public.methodologies (key, name, description, version) values
  ('swot-tows', 'SWOT-TOWS', 'Strengths/Weaknesses/Opportunities/Threats analysis extended into TOWS strategic pairing.', '1.0');

insert into public.methodology_factor_categories (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, v.color_token, v.sort_order, v.guidance_text
from public.methodologies m,
  (values
    ('strength', 'Strength', 'strength', 1, 'Identify capabilities, assets, relationships, skills, technologies, intellectual property, brand advantages, and organizational strengths.'),
    ('weakness', 'Weakness', 'weakness', 2, 'Identify limitations, gaps, resource constraints, and areas where the organization is at a disadvantage.'),
    ('opportunity', 'Opportunity', 'opportunity', 3, 'Identify external trends, market shifts, and conditions the organization could exploit.'),
    ('threat', 'Threat', 'threat', 4, 'Identify external risks, competitive pressures, and conditions that could harm the organization.')
  ) as v(key, name, color_token, sort_order, guidance_text)
where m.key = 'swot-tows';

insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.sequence_number, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('strength_discovery', 'Strength Discovery', 1, 'capture', '{"factor_category_key":"strength"}'),
    ('weakness_discovery', 'Weakness Discovery', 2, 'capture', '{"factor_category_key":"weakness"}'),
    ('opportunity_discovery', 'Opportunity Discovery', 3, 'capture', '{"factor_category_key":"opportunity"}'),
    ('threat_discovery', 'Threat Discovery', 4, 'capture', '{"factor_category_key":"threat"}'),
    ('prioritization', 'Prioritization', 5, 'prioritize', '{"votes_per_participant":20}'),
    ('theme_generation', 'Theme Analysis', 6, 'synthesize', '{}'),
    ('tows_analysis', 'TOWS Matrix', 7, 'relate', '{}'),
    ('insight_generation', 'Insight Generation', 8, 'interpret', '{}'),
    ('recommendation_generation', 'Recommendations', 9, 'recommend', '{}'),
    ('reporting', 'Reporting', 10, 'report', '{}')
  ) as v(key, name, sequence_number, stage_type, config)
where m.key = 'swot-tows';

insert into public.methodology_relationship_types (methodology_id, key, name, source_category_id, target_category_id, guidance_text)
select m.id, v.key, v.name,
  (select id from public.methodology_factor_categories where methodology_id = m.id and key = v.source_key),
  (select id from public.methodology_factor_categories where methodology_id = m.id and key = v.target_key),
  v.guidance_text
from public.methodologies m,
  (values
    ('so', 'SO — Leverage', 'strength', 'opportunity', 'Use strengths to exploit opportunities.'),
    ('st', 'ST — Defend', 'strength', 'threat', 'Use strengths to mitigate threats.'),
    ('wo', 'WO — Improve', 'weakness', 'opportunity', 'Address weaknesses to exploit opportunities.'),
    ('wt', 'WT — Mitigate', 'weakness', 'threat', 'Reduce weaknesses to mitigate threats.')
  ) as v(key, name, source_key, target_key, guidance_text)
where m.key = 'swot-tows';

insert into public.methodology_ai_prompts (methodology_id, function_key, stage_id, name, prompt_template, output_schema, prompt_version)
select m.id, v.function_key,
  (select id from public.methodology_stages where methodology_id = m.id and key = v.stage_key),
  v.name, v.prompt_template, v.output_schema::jsonb, 'v1.0'
from public.methodologies m,
  (values
    ('artifact_suggestion', 'strength_discovery', 'Generate Artifact Suggestions',
      'Generate up to 8 candidate {{factor_category_name}} factors for the workshop "{{workshop_name}}" (objective: {{workshop_objective}}). Do not duplicate any of the existing factors provided. Phrase each as a consideration, not a stated fact. Include a rationale for each.',
      '{"suggestions":[{"title":"","description":"","rationale":"","confidence_score":0}]}'),
    ('duplicate_detection', 'strength_discovery', 'Detect Duplicates',
      'Review the supplied factor list for the workshop objective "{{workshop_objective}}" and identify duplicate or near-duplicate factors. Explain why each group overlaps and propose a merged title and description. Do not merge automatically.',
      '{"duplicate_groups":[{"factor_ids":[],"reason":"","suggested_title":"","suggested_description":"","confidence_score":0}]}'),
    ('theme_generation', 'theme_generation', 'Generate Themes',
      'Group the supplied prioritized factors into 5-10 themes for workshop objective "{{workshop_objective}}". Every theme must cite the factor IDs supporting it. Avoid generic names like "Strengths" or "Risks". Include a rationale per theme.',
      '{"themes":[{"title":"","description":"","supporting_factor_ids":[],"rationale":"","confidence_score":0}]}'),
    ('relationship_generation', 'tows_analysis', 'Generate TOWS Relationships',
      'Generate {{relationship_type_name}} relationships ({{relationship_type_guidance}}) for workshop objective "{{workshop_objective}}", using only the supplied factors. Reference source and target factor IDs. Include a strategic narrative and a candidate strategic option per relationship.',
      '{"relationships":[{"relationship_type_key":"","source_factor_id":"","target_factor_id":"","title":"","narrative":"","strategic_option":"","confidence_score":0}]}'),
    ('insight_generation', 'insight_generation', 'Generate Insights',
      'Generate 5-8 insights for workshop objective "{{workshop_objective}}" from the supplied approved syntheses and factor relationships. Each insight must interpret meaning, not restate an observation, and must cite the supporting synthesis and/or relationship IDs. Explain the strategic significance.',
      '{"insights":[{"title":"","description":"","strategic_significance":"","supporting_synthesis_ids":[],"supporting_relationship_ids":[],"rationale":"","confidence_score":0}]}'),
    ('recommendation_generation', 'recommendation_generation', 'Generate Recommendations',
      'Generate 4-7 recommendations for workshop objective "{{workshop_objective}}" from the supplied approved insights. Each must cite supporting insight IDs. Do not invent budgets, timelines, owners, or metrics unless supplied. Include benefits, risks, and a priority (critical/high/medium/low).',
      '{"recommendations":[{"title":"","description":"","benefits":"","risks":"","priority":"","supporting_insight_ids":[],"rationale":"","confidence_score":0}]}'),
    ('executive_summary_generation', 'reporting', 'Generate Executive Summary',
      'Write a concise executive-style summary for workshop "{{workshop_name}}" (objective: {{workshop_objective}}) from the supplied prioritized factors, approved themes, insights, and recommendations. No internal workshop mechanics. No invented facts, financial values, dates, owners, or commitments.',
      '{"executive_summary":{"title":"","situation_summary":"","key_findings":[],"strategic_implications":[],"top_recommendations":[],"next_steps":[]}}'),
    ('workshop_summary', null, 'Summarize Workshop',
      'Summarize the current progress of workshop "{{workshop_name}}" from the supplied activity status, factor counts, themes, insights, and recommendations. Identify incomplete items. Do not invent missing outputs.',
      '{"summary":{"completed_work":[],"emerging_findings":[],"incomplete_items":[],"recommended_next_steps":[]}}'),
    ('challenge', null, 'Challenge',
      'Constructively challenge the supplied object (do not reject it outright). Identify missing evidence, assumptions, alternative interpretations, implementation risks, and suggested improvements.',
      '{"challenge":{"missing_evidence":[],"assumptions":[],"alternative_interpretations":[],"risks":[],"suggested_improvements":[]}}'),
    ('traceability_explanation', null, 'Explain Why',
      'In plain business language, explain why the supplied object exists, referencing only its supplied supporting objects. Do not introduce new claims.',
      '{"explanation":{"summary":"","supporting_points":[],"confidence_note":""}}')
  ) as v(function_key, stage_key, name, prompt_template, output_schema)
where m.key = 'swot-tows';

-- ============================================================
-- Validation stub: a second methodology proving factor categories/stages
-- are genuinely config-driven, not SWOT-TOWS-hardcoded. Not built out beyond
-- this — inactive, exists only to prove the engine holds before Phase 1+.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active) values
  ('pestle', 'PESTLE', 'Political, Economic, Social, Technological, Legal, Environmental factor analysis.', '0.1', false);

insert into public.methodology_factor_categories (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, v.color_token, v.sort_order, v.guidance_text
from public.methodologies m,
  (values
    ('political', 'Political', 'strength', 1, 'Government policy, regulation, political stability.'),
    ('economic', 'Economic', 'weakness', 2, 'Economic growth, exchange rates, inflation, interest rates.'),
    ('social', 'Social', 'opportunity', 3, 'Demographics, culture, consumer attitudes.'),
    ('technological', 'Technological', 'threat', 4, 'Innovation, automation, technology access.'),
    ('legal', 'Legal', 'strength', 5, 'Employment law, consumer law, health and safety.'),
    ('environmental', 'Environmental', 'opportunity', 6, 'Climate, sustainability, environmental regulation.')
  ) as v(key, name, color_token, sort_order, guidance_text)
where m.key = 'pestle';

insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'political_discovery', 'Political Discovery', 1, 'capture', '{"factor_category_key":"political"}'
from public.methodologies m where m.key = 'pestle';

-- ============================================================
-- Generalize the object tables
-- ============================================================

alter table public.workshops add column methodology_id uuid references public.methodologies(id);
alter table public.workshops add column votes_per_participant integer not null default 20;
update public.workshops set methodology_id = (select id from public.methodologies where key = 'swot-tows');
alter table public.workshops alter column methodology_id set not null;

alter table public.activities add column stage_id uuid references public.methodology_stages(id);
update public.activities a
  set stage_id = (
    select ms.id from public.methodology_stages ms
    join public.workshops w on w.methodology_id = ms.methodology_id
    where w.id = a.workshop_id and ms.key = a.activity_type
  );
alter table public.activities alter column stage_id set not null;
alter table public.activities drop constraint if exists activities_type_check;
alter table public.activities drop column activity_type;

alter table public.artifacts add column factor_category_id uuid references public.methodology_factor_categories(id);
update public.artifacts a
  set factor_category_id = (
    select mfc.id from public.methodology_factor_categories mfc
    join public.workshops w on w.methodology_id = mfc.methodology_id
    where w.id = a.workshop_id and mfc.key = a.artifact_type
  );
alter table public.artifacts alter column factor_category_id set not null;
alter table public.artifacts drop constraint if exists artifacts_type_check;
alter table public.artifacts drop column artifact_type;
alter table public.artifacts rename to factors;

alter table public.tows_relationships add column relationship_type_id uuid references public.methodology_relationship_types(id);
update public.tows_relationships r
  set relationship_type_id = (
    select mrt.id from public.methodology_relationship_types mrt
    join public.workshops w on w.methodology_id = mrt.methodology_id
    where w.id = r.workshop_id and mrt.key = r.relationship_type
  );
alter table public.tows_relationships alter column relationship_type_id set not null;
alter table public.tows_relationships drop constraint if exists tows_relationship_type_check;
alter table public.tows_relationships drop column relationship_type;
alter table public.tows_relationships rename column source_artifact_id to source_factor_id;
alter table public.tows_relationships rename column target_artifact_id to target_factor_id;
alter table public.tows_relationships rename to factor_relationships;

alter table public.theme_artifacts rename column artifact_id to factor_id;
alter table public.theme_artifacts rename column theme_id to synthesis_id;
alter table public.theme_artifacts rename to synthesis_factors;

alter table public.themes rename to syntheses;

alter table public.insight_themes rename column theme_id to synthesis_id;
alter table public.insight_themes rename to insight_syntheses;

alter table public.insight_tows_relationships rename column tows_relationship_id to factor_relationship_id;
alter table public.insight_tows_relationships rename to insight_factor_relationships;

alter table public.ai_outputs add column prompt_version text;

-- Rebuild the full-text search index that referenced the old table name.
drop index if exists idx_artifacts_search;
create index idx_factors_search on public.factors
  using gin(to_tsvector('english', title || ' ' || coalesce(description, '')));
