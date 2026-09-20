-- ============================================================
-- Capability Assessment
--
-- What the business must be ABLE TO DO, independent of the org chart. Build a
-- capability map, rate each capability on current and target maturity, take
-- the gap, and direct investment where the gap is widest and the strategic
-- value highest. TOGAF is explicit that the heat map is the analytical
-- artefact; we render the same information as a table sorted by gap, because
-- the decision was to compose the existing renderers rather than add one.
--
-- TWO weights on the same object, which nothing else has needed yet: current
-- and target maturity, both on the 1-5 CMMI ladder. The GAP is deliberately
-- NOT stored — it is current minus target, and storing a derived value is how
-- two sources of truth start disagreeing. The report sorts by target because
-- that is a stored column; reading the gap is the reader's job, and both
-- numbers sit side by side to make it easy.
--
-- Reference: https://pubs.opengroup.org/togaf-standard/business-architecture/business-capabilities.html
-- Seeded inactive.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('capability', 'Capability Assessment',
        'Maps what the organisation must be able to do, rates each capability on current and target maturity, and directs investment at the widest gaps.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('customer', 'Customer', 1,
     'Capabilities that find, win and keep customers: segmentation, acquisition, service, retention.'),
    ('product', 'Product and Service', 2,
     'Capabilities that design, build and evolve what is sold: research, development, lifecycle management.'),
    ('operations', 'Operations', 3,
     'Capabilities that deliver and fulfil: supply, production, logistics, quality, support.'),
    ('technology', 'Technology and Data', 4,
     'Capabilities that run the platform and turn data into decisions: architecture, engineering, security, analytics.'),
    ('people', 'People and Organisation', 5,
     'Capabilities that attract, develop and organise people: hiring, learning, performance, culture.'),
    ('finance', 'Finance and Governance', 6,
     'Capabilities that fund, control and account: planning, treasury, risk, compliance, reporting.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'capability'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('customer_capabilities',   'Customer',               1, 'capture',    '{"factor_category_key":"customer"}'),
    ('product_capabilities',    'Product and Service',    2, 'capture',    '{"factor_category_key":"product"}'),
    ('operations_capabilities', 'Operations',             3, 'capture',    '{"factor_category_key":"operations"}'),
    ('technology_capabilities', 'Technology and Data',    4, 'capture',    '{"factor_category_key":"technology"}'),
    ('people_capabilities',     'People and Organisation',5, 'capture',    '{"factor_category_key":"people"}'),
    ('finance_capabilities',    'Finance and Governance', 6, 'capture',    '{"factor_category_key":"finance"}'),
    ('maturity_rating',         'Maturity Rating',        7, 'prioritize', '{"weights":["current_maturity","target_maturity"]}'),
    ('gap_analysis',            'Gap Analysis',           8, 'synthesize', '{"groups":"factor"}'),
    ('capability_implications', 'Implications',           9, 'interpret',  '{"cites":["synthesis"]}'),
    ('investment_priorities',   'Investment Priorities', 10, 'recommend',  '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'capability'
on conflict (methodology_id, key) do nothing;

-- The CMMI ladder, named. 1-5 because that is CMMI, not because the engine
-- knows anything about five.
insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, v.key, v.name, 'factor', 1, 5, 1,
       '["Initial","Managed","Defined","Quantitatively managed","Optimizing"]'::jsonb,
       'single', false, 'latest', array['facilitator','analyst'], v.guidance, v.sort_order
from public.methodologies m,
  (values
    ('current_maturity', 'Current maturity', 1,
     'How this capability actually performs today, evidenced rather than hoped.'),
    ('target_maturity',  'Target maturity',  2,
     'The level the strategy requires. Not every capability needs to reach five.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'capability'
on conflict (methodology_id, key) do nothing;

-- Note there is NO prioritize vote weight: the "Maturity Rating" stage is a
-- prioritize stage that declares two scale weights and no budget, which is the
-- first time a prioritize stage has meant something other than voting.
insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'capability_report', 'Capability Report', 11, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'capability_assessment',
        'name', 'Capability Assessment Report',
        'description', 'Current versus target maturity across the capability map, and where to invest.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','maturity_table','name','Capability Maturity',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('current_maturity','target_maturity'),
                                         'order_by','weight:target_maturity desc')),
          jsonb_build_object('key','capability_map','name','Capability Map',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'group_by','factor_category')),
          jsonb_build_object('key','gaps','name','Capability Gaps',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','implications','name','What the Gaps Mean',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','investments','name','Investment Priorities',
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
where m.key = 'capability'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('capability');
