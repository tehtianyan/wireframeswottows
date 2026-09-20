-- ============================================================
-- Business Model Assessment (Business Model Canvas)
--
-- Osterwalder's nine blocks. Map the current model block by block, then test
-- it for COHERENCE — does the value proposition actually fit the segment it
-- claims, do the revenue streams cover the cost structure — and redesign where
-- it does not.
--
-- The fit tests are a genuine RELATE stage, and this is what makes the canvas
-- worth configuring here: it pairs factors from two different blocks under a
-- named relationship type, exactly as TOWS pairs a strength with an
-- opportunity, from entirely different config and with no code in common
-- beyond the engine. Two relationship types, not four, and over different
-- categories.
--
-- NINE categories, which is why the neutral colour tokens were extended from
-- six to twelve. A methodology needing more than six categories was always
-- going to happen; the canvas is simply the first.
--
-- Reference: https://www.strategyzer.com/library/the-business-model-canvas
-- Seeded inactive.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('business-model', 'Business Model Assessment',
        'Maps the business model across the nine blocks of the Business Model Canvas, tests it for coherence between value propositions, segments, revenue and cost, and redesigns where it does not hold.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('customer_segments', 'Customer Segments', 1,
     'Who is being served, grouped by what actually differs about them — needs, channels, profitability.'),
    ('value_propositions', 'Value Propositions', 2,
     'What job is being done for each segment, and why they would choose this over the alternative.'),
    ('channels', 'Channels', 3,
     'How each segment is reached and served, from awareness through to after-sales.'),
    ('customer_relationships', 'Customer Relationships', 4,
     'What kind of relationship each segment expects: self-service, dedicated, community, automated.'),
    ('revenue_streams', 'Revenue Streams', 5,
     'What each segment actually pays for, how pricing works, and how predictable it is.'),
    ('key_resources', 'Key Resources', 6,
     'The assets the model cannot run without: physical, intellectual, human, financial.'),
    ('key_activities', 'Key Activities', 7,
     'The things the organisation must do well for the proposition to hold.'),
    ('key_partners', 'Key Partners', 8,
     'Who supplies or performs what is not done in-house, and how dependent the model is on them.'),
    ('cost_structure', 'Cost Structure', 9,
     'What the model costs to run, which costs are fixed against variable, and what drives them.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'business-model'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('segments_block',      'Customer Segments',       1, 'capture',    '{"factor_category_key":"customer_segments"}'),
    ('value_block',         'Value Propositions',      2, 'capture',    '{"factor_category_key":"value_propositions"}'),
    ('channels_block',      'Channels',                3, 'capture',    '{"factor_category_key":"channels"}'),
    ('relationships_block', 'Customer Relationships',  4, 'capture',    '{"factor_category_key":"customer_relationships"}'),
    ('revenue_block',       'Revenue Streams',         5, 'capture',    '{"factor_category_key":"revenue_streams"}'),
    ('resources_block',     'Key Resources',           6, 'capture',    '{"factor_category_key":"key_resources"}'),
    ('activities_block',    'Key Activities',          7, 'capture',    '{"factor_category_key":"key_activities"}'),
    ('partners_block',      'Key Partners',            8, 'capture',    '{"factor_category_key":"key_partners"}'),
    ('costs_block',         'Cost Structure',          9, 'capture',    '{"factor_category_key":"cost_structure"}'),
    ('fit_tests',           'Fit Tests',              10, 'relate',     '{}'),
    ('coherence_findings',  'Coherence Findings',     11, 'synthesize', '{"groups":"factor"}'),
    ('bm_implications',     'Implications',           12, 'interpret',  '{"cites":["synthesis","factor_relationship"]}'),
    ('redesign_moves',      'Redesign Moves',         13, 'recommend',  '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'business-model'
on conflict (methodology_id, key) do nothing;

-- The two coherence tests, expressed the same way TOWS quadrants are: a named
-- pairing between two configured categories. Nothing in Go knows what a value
-- proposition is.
insert into public.methodology_relationship_types
  (methodology_id, key, name, source_category_id, target_category_id, guidance_text)
select m.id, v.key, v.name, src.id, tgt.id, v.guidance
from public.methodologies m
cross join (values
    ('proposition_fit', 'Proposition Fit', 'value_propositions', 'customer_segments',
     'Does this value proposition actually address a job this segment has? A proposition that fits no segment is a product looking for a market.'),
    ('economic_fit', 'Economic Fit', 'revenue_streams', 'cost_structure',
     'Does this revenue stream cover the costs it drives? A stream that does not is either a loss leader on purpose or a mistake by accident.')
  ) as v(key, name, src_key, tgt_key, guidance)
join public.methodology_factor_categories src
  on src.methodology_id = m.id and src.key = v.src_key
join public.methodology_factor_categories tgt
  on tgt.methodology_id = m.id and tgt.key = v.tgt_key
where m.key = 'business-model'
on conflict (methodology_id, key) do nothing;

-- No weights at all. The canvas is a structural and relational assessment,
-- not a rated one, and adding a score would be decoration. A methodology with
-- no weights must render a prioritize-free flow correctly, which is its own
-- thing worth proving.
insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'bm_report', 'Business Model Report', 14, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'business_model',
        'name', 'Business Model Assessment',
        'description', 'The canvas as it stands, where it does not hold together, and what to change.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','canvas','name','The Canvas',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'group_by','factor_category')),
          jsonb_build_object('key','fit','name','Fit Tests',
            'section_type','pair_matrix',
            'source', jsonb_build_object('from','factor_relationship','state','approved',
                                         'group_by','relationship_type')),
          jsonb_build_object('key','coherence','name','Coherence Findings',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','implications','name','Implications',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','redesign','name','Redesign Moves',
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
where m.key = 'business-model'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('business-model');
