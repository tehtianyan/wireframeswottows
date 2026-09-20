-- ============================================================
-- PESTLE, completed
--
-- PESTLE scans the EXTERNAL macro environment through six lenses — Political,
-- Economic, Social, Technological, Legal, Environmental — for forces outside
-- the organisation's control. The discipline is that it produces DRIVERS, not
-- a list: each force is rated for impact and likelihood, the handful that
-- matter are distilled into drivers, and the implications are written out.
--
-- The stub already had six capture stages, a six-vote prioritize stage,
-- Driver Analysis (synthesize), Implications (interpret) and a report. What it
-- could not express until the weight abstraction landed was the rating step,
-- which is most of what makes PESTLE an assessment.
--
-- Deliberately NO recommend stage and NO relate stage. PESTLE ends at
-- implications; deciding what to do about them is another methodology's job.
-- The genericity suite depends on that shape.
--
-- Reference: https://www.cipd.org/uk/knowledge/factsheets/pestle-analysis-factsheet/
-- Stays is_active = false. It is a fixture, not a product.
-- ============================================================

-- ------------------------------------------------------------
-- Impact and likelihood, rated per factor.
--
-- per_participant = false: these are an agreed assessment, not a poll. One
-- value per factor, set by a facilitator or analyst. Contrast the vote weight,
-- which is per participant and summed.
--
-- 1-5 is PESTLE practice, not the engine's. Both bounds are columns.
-- ------------------------------------------------------------

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, v.key, v.name, 'factor', 1, 5, 1, v.labels::jsonb,
       'single', false, 'latest', array['facilitator','analyst'], v.guidance, v.sort_order
from public.methodologies m,
  (values
    ('impact', 'Impact', 1,
     '["Negligible","Minor","Moderate","Major","Severe"]',
     'How much this force would affect the organisation if it plays out.'),
    ('likelihood', 'Likelihood', 2,
     '["Rare","Unlikely","Possible","Likely","Almost certain"]',
     'How probable this force is over the planning horizon.')
  ) as v(key, name, sort_order, labels, guidance)
where m.key = 'pestle'
on conflict (methodology_id, key) do nothing;

-- The prioritize stage surfaces all three: the vote budget that already
-- existed, plus the two ratings. Naming them explicitly is what makes the
-- stage show them; a stage that names none shows every factor weight, which
-- is why SWOT-TOWS needed no edit.
update public.methodology_stages ms
set config = ms.config || jsonb_build_object(
  'weights', jsonb_build_array('vote', 'impact', 'likelihood')
)
from public.methodologies m
where ms.methodology_id = m.id
  and m.key = 'pestle'
  and ms.stage_type = 'prioritize';

-- ------------------------------------------------------------
-- The report gains the rating table.
--
-- Composed from renderers that already exist: the six-lens overview is a
-- category_matrix, and the rated scan is a `table` carrying the two weights as
-- columns, ordered by impact. No heat map, by decision — the numbers are
-- there to be read, sorted.
-- ------------------------------------------------------------

update public.methodology_stages ms
set config = jsonb_set(
  ms.config,
  '{report_types,0,sections}',
  jsonb_build_array(
    jsonb_build_object('key','factor_matrix','name','PESTLE Overview',
      'section_type','category_matrix',
      'source', jsonb_build_object('from','factor','state','approved','group_by','factor_category')),
    jsonb_build_object('key','rated_scan','name','Rated Scan',
      'section_type','table',
      'source', jsonb_build_object('from','factor','state','approved',
                                   'weights', jsonb_build_array('impact','likelihood'),
                                   'order_by','weight:impact desc')),
    jsonb_build_object('key','drivers','name','Key Drivers',
      'section_type','bullet_list',
      'source', jsonb_build_object('from','synthesis','state','approved')),
    jsonb_build_object('key','implications','name','Implications',
      'section_type','bullet_list',
      'source', jsonb_build_object('from','insight','state','approved'))
  )
)
from public.methodologies m
where ms.methodology_id = m.id
  and m.key = 'pestle'
  and ms.stage_type = 'report';

-- ------------------------------------------------------------
-- AI. PESTLE had none, so its assistant panel offered nothing at all — the
-- Phase 3 genericity cases assume it inherits the capture actions.
-- It gets capture, synthesize, interpret and report prompts; no relate or
-- recommend prompt, because it has neither stage.
-- ------------------------------------------------------------

select public.seed_methodology_ai_prompts('pestle');

update public.methodologies
set description = 'Scans the external macro environment through six lenses — political, economic, social, technological, legal and environmental — rating each force for impact and likelihood, then distilling the drivers that matter and what they imply.'
where key = 'pestle';
