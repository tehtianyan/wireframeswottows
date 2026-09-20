-- ============================================================
-- Risk Assessment (ISO 31000)
--
-- ISO 31000's process: establish context, IDENTIFY, ANALYSE (likelihood and
-- consequence), EVALUATE against risk appetite, TREAT — with residual risk
-- recorded after treatment.
--
-- Inherent versus residual is what makes this an assessment rather than a
-- list, so this methodology carries FOUR weights on the same object: the
-- inherent pair rated at analysis, and the residual pair rated once treatment
-- is decided. A register that shows only one pair cannot answer "did the
-- treatment work", which is the whole point of the evaluate step.
--
-- No heat map, by decision — the register is a table ordered by inherent
-- likelihood, with consequence beside it. The information is the same; what is
-- lost is the 5x5 grid, and that is recorded as a known gap rather than
-- pretended away.
--
-- The ordinal labels are ISO's own vocabulary. They reach the screen because
-- the scale carries them, not because any code knows the words.
--
-- Reference: https://www.iso.org/standard/65694.html
-- Seeded inactive.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('risk-iso31000', 'Risk Assessment',
        'Identifies risks by category, analyses each for likelihood and consequence, evaluates them against appetite, and records residual risk once treatment is decided. Follows ISO 31000.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('strategic', 'Strategic', 1,
     'Risks to the strategy itself: market shifts, competitor moves, failed bets, reputational damage.'),
    ('operational', 'Operational', 2,
     'Risks in running the business: process failure, capacity, supply disruption, key person dependency.'),
    ('financial', 'Financial', 3,
     'Risks to cash and the balance sheet: liquidity, credit, currency, cost inflation, fraud.'),
    ('compliance', 'Compliance and Legal', 4,
     'Risks from obligation: regulation, contracts, licensing, litigation, sanctions.'),
    ('technology', 'Technology and Cyber', 5,
     'Risks in the platform: outage, data loss, breach, technical debt, vendor lock-in.'),
    ('people', 'People', 6,
     'Risks in the workforce: attrition, capability shortfall, safety, culture, industrial action.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'risk-iso31000'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('strategic_risks',   'Strategic Risks',       1, 'capture',    '{"factor_category_key":"strategic"}'),
    ('operational_risks', 'Operational Risks',     2, 'capture',    '{"factor_category_key":"operational"}'),
    ('financial_risks',   'Financial Risks',       3, 'capture',    '{"factor_category_key":"financial"}'),
    ('compliance_risks',  'Compliance and Legal',  4, 'capture',    '{"factor_category_key":"compliance"}'),
    ('technology_risks',  'Technology and Cyber',  5, 'capture',    '{"factor_category_key":"technology"}'),
    ('people_risks',      'People Risks',          6, 'capture',    '{"factor_category_key":"people"}'),
    ('risk_analysis',     'Risk Analysis',         7, 'prioritize',
       '{"weights":["likelihood","consequence","residual_likelihood","residual_consequence"]}'),
    ('risk_themes',       'Risk Themes',           8, 'synthesize', '{"groups":"factor"}'),
    ('risk_evaluation',   'Evaluation',            9, 'interpret',  '{"cites":["synthesis"]}'),
    ('risk_treatment',    'Treatment Plan',       10, 'recommend',  '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'risk-iso31000'
on conflict (methodology_id, key) do nothing;

-- Four weights on one object. The inherent pair is rated at analysis; the
-- residual pair is rated after treatment is agreed, which is why they are
-- separate weights rather than the same one edited twice — an overwritten
-- rating loses the before, and the before is the evidence that the treatment
-- was worth doing.
insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, v.key, v.name, 'factor', 1, 5, 1, v.labels::jsonb,
       'single', false, 'latest', array['facilitator','analyst'], v.guidance, v.sort_order
from public.methodologies m,
  (values
    ('likelihood', 'Likelihood (inherent)', 1,
     '["Rare","Unlikely","Possible","Likely","Almost certain"]',
     'How probable this is before any treatment, over the stated horizon.'),
    ('consequence', 'Consequence (inherent)', 2,
     '["Insignificant","Minor","Moderate","Major","Catastrophic"]',
     'What it would cost if it happened, before any treatment.'),
    ('residual_likelihood', 'Likelihood (residual)', 3,
     '["Rare","Unlikely","Possible","Likely","Almost certain"]',
     'How probable it remains once the agreed treatment is in place.'),
    ('residual_consequence', 'Consequence (residual)', 4,
     '["Insignificant","Minor","Moderate","Major","Catastrophic"]',
     'What it would still cost once the agreed treatment is in place.')
  ) as v(key, name, sort_order, labels, guidance)
where m.key = 'risk-iso31000'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'risk_report', 'Risk Report', 11, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'risk_register',
        'name', 'Risk Register',
        'description', 'Every identified risk, rated inherent and residual, with its treatment.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','inherent_register','name','Risk Register — Inherent',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('likelihood','consequence'),
                                         'order_by','weight:likelihood desc')),
          jsonb_build_object('key','residual_register','name','Risk Register — Residual',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('residual_likelihood','residual_consequence'),
                                         'order_by','weight:residual_likelihood desc')),
          jsonb_build_object('key','by_category','name','Risks by Category',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'group_by','factor_category')),
          jsonb_build_object('key','themes','name','Risk Themes',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','evaluation','name','Evaluation Against Appetite',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','treatments','name','Treatment Plan',
            'section_type','object_list','selectable', true,
            'source', jsonb_build_object('from','recommendation','state','approved',
                                         'order_by','priority')),
          jsonb_build_object('key','evidence','name','Evidence Chain',
            'section_type','evidence_chain','included_by_default', false,
            'source', jsonb_build_object('from','recommendation','state','approved',
                                         'expand','citations'))
        )
      )
    )
  )
from public.methodologies m
where m.key = 'risk-iso31000'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('risk-iso31000');
