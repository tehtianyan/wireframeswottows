-- ============================================================
-- Operating Model Assessment (Ashridge POLISM)
--
-- How the organisation actually RUNS, against Andrew Campbell's POLISM:
-- Processes, Organisation, Locations, Information, Suppliers, Management
-- system — anchored to the value proposition the model exists to deliver.
-- Assess current state per element, surface the pain points and
-- misalignments, define target state, read the gap.
--
-- This is the one methodology of the seven that needed NO new capability from
-- the engine at all: it would have run on the platform as it stood before the
-- weight abstraction. It carries a single pain-severity rating, which is
-- honest to the method rather than added to make a point.
--
-- The report opens with a human-written value proposition narrative, because
-- POLISM without the value proposition is six boxes with nothing holding them
-- together — Campbell's own emphasis.
--
-- Reference: https://ashridgeonoperatingmodels.com/tag/polism/
-- Seeded inactive.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('operating-model', 'Operating Model Assessment',
        'Assesses how the organisation runs across processes, organisation, locations, information, suppliers and management system, anchored to the value proposition it delivers.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('processes', 'Processes', 1,
     'The work that delivers the value proposition: the value chains and the handoffs between them.'),
    ('organisation', 'Organisation', 2,
     'How people are grouped, who decides what, spans and layers, and where accountability sits.'),
    ('locations', 'Locations', 3,
     'Where the work happens, and why there: sites, time zones, proximity to customers or talent.'),
    ('information', 'Information', 4,
     'The data and systems the work depends on, and whether they tell one story or several.'),
    ('suppliers', 'Suppliers', 5,
     'What is sourced outside, from whom, and how dependent the model is on them.'),
    ('management_system', 'Management System', 6,
     'How performance is planned, measured, reviewed and corrected: targets, cadence, incentives.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'operating-model'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('processes_review',    'Processes',          1, 'capture',    '{"factor_category_key":"processes"}'),
    ('organisation_review', 'Organisation',       2, 'capture',    '{"factor_category_key":"organisation"}'),
    ('locations_review',    'Locations',          3, 'capture',    '{"factor_category_key":"locations"}'),
    ('information_review',  'Information',        4, 'capture',    '{"factor_category_key":"information"}'),
    ('suppliers_review',    'Suppliers',          5, 'capture',    '{"factor_category_key":"suppliers"}'),
    ('management_review',   'Management System',  6, 'capture',    '{"factor_category_key":"management_system"}'),
    ('severity_rating',     'Pain Severity',      7, 'prioritize', '{"weights":["pain_severity"]}'),
    ('design_themes',       'Design Themes',      8, 'synthesize', '{"groups":"factor"}'),
    ('om_implications',     'Implications',       9, 'interpret',  '{"cites":["synthesis"]}'),
    ('target_state',        'Target State Moves', 10, 'recommend', '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'operating-model'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, 'pain_severity', 'Pain severity', 'factor', 1, 5, 1,
       '["Irritant","Friction","Costly","Blocking","Critical"]'::jsonb,
       'single', false, 'latest', array['facilitator','analyst'],
       'How much this is actually costing the organisation today, not how annoying it feels.', 1
from public.methodologies m
where m.key = 'operating-model'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'om_report', 'Operating Model Report', 11, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'operating_model',
        'name', 'Operating Model Assessment',
        'description', 'The current model across all six elements, what hurts, and what to change.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','value_proposition','name','Value Proposition',
            'section_type','narrative',
            'source', jsonb_build_object('from','human')),
          jsonb_build_object('key','model_overview','name','The Operating Model',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'group_by','factor_category')),
          jsonb_build_object('key','pain_points','name','Where It Hurts',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('pain_severity'),
                                         'order_by','weight:pain_severity desc')),
          jsonb_build_object('key','design_themes','name','Design Themes',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','implications','name','Implications',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','moves','name','Target State Moves',
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
where m.key = 'operating-model'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('operating-model');
