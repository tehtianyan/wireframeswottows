-- ============================================================
-- Porter's Five Forces
--
-- Industry STRUCTURAL attractiveness, from Porter's 1979 HBR article and his
-- 2008 revision. The method is not "list things under five headings": for each
-- force you enumerate its DETERMINANTS — switching costs, capital
-- requirements, concentration, asset specificity — then rate the force weak to
-- strong, then read the five ratings together to judge whether the industry
-- can sustain profit, and only then choose where to position.
--
-- How that maps onto the engine, without inventing anything:
--   * a factor is a DETERMINANT, captured under the force it belongs to
--   * a synthesis is a FORCE ASSESSMENT, citing its determinants and carrying
--     the force's intensity as a weight — this is the rating step
--   * an insight is a judgement about industry attractiveness
--   * a recommendation is a positioning move
--
-- Two deliberate differences from every methodology configured so far:
--   * NO prioritize stage. Five Forces does not vote; the assessment is the
--     rating, not a poll. A methodology with no prioritize stage defines no
--     vote weight, and the vote endpoints correctly refuse.
--   * the rating sits on a SYNTHESIS, not a factor — the first weight that
--     does, which is what proves `applies_to` is real.
--
-- Reference: https://hbr.org/2008/01/the-five-competitive-forces-that-shape-strategy
-- Seeded inactive. Activate with:
--   update public.methodologies set is_active = true where key = 'five-forces';
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('five-forces', 'Porter''s Five Forces',
        'Assesses industry structural attractiveness by enumerating the determinants behind each of the five competitive forces, rating each force, and reading the pattern to choose where to position.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('rivalry', 'Competitive Rivalry', 1,
     'What determines how hard existing competitors fight? Industry growth, concentration, exit barriers, fixed costs, product differences.'),
    ('new_entrants', 'Threat of New Entrants', 2,
     'What makes entry easy or hard? Capital requirements, economies of scale, brand loyalty, access to distribution, regulation, expected retaliation.'),
    ('substitutes', 'Threat of Substitutes', 3,
     'What else can meet the same need? Relative price-performance of substitutes, buyer propensity to switch, switching costs.'),
    ('buyer_power', 'Bargaining Power of Buyers', 4,
     'What gives buyers leverage? Concentration, volume, switching costs, price sensitivity, ability to integrate backwards, information.'),
    ('supplier_power', 'Bargaining Power of Suppliers', 5,
     'What gives suppliers leverage? Concentration, uniqueness of input, switching costs, ability to integrate forwards, importance of our volume to them.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'five-forces'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('rivalry_determinants',        'Rivalry',              1, 'capture',    '{"factor_category_key":"rivalry"}'),
    ('new_entrant_determinants',    'New Entrants',         2, 'capture',    '{"factor_category_key":"new_entrants"}'),
    ('substitute_determinants',     'Substitutes',          3, 'capture',    '{"factor_category_key":"substitutes"}'),
    ('buyer_determinants',          'Buyer Power',          4, 'capture',    '{"factor_category_key":"buyer_power"}'),
    ('supplier_determinants',       'Supplier Power',       5, 'capture',    '{"factor_category_key":"supplier_power"}'),
    ('force_assessment',            'Force Assessment',     6, 'synthesize', '{"groups":"factor","weights":["intensity"]}'),
    ('industry_attractiveness',     'Industry Attractiveness', 7, 'interpret', '{"cites":["synthesis"]}'),
    ('positioning',                 'Positioning Moves',    8, 'recommend',  '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'five-forces'
on conflict (methodology_id, key) do nothing;

-- The rating, on the FORCE ASSESSMENT rather than on a determinant. One
-- agreed value per force, set by a facilitator or analyst.
insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, 'intensity', 'Force intensity', 'synthesis', 1, 5, 1,
       '["Very weak","Weak","Moderate","Strong","Very strong"]'::jsonb,
       'single', false, 'latest', array['facilitator','analyst'],
       'How much this force compresses profitability in this industry.', 1
from public.methodologies m
where m.key = 'five-forces'
on conflict (methodology_id, key) do nothing;

-- The report: the determinants by force, then the five ratings as a table,
-- then the judgement, then the moves. No new renderer.
insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'five_forces_report', 'Industry Report', 9, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'industry_structure',
        'name', 'Industry Structure Report',
        'description', 'The five forces, what drives each, and where that leaves us.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1),
          jsonb_build_object('kind', 'insight',   'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','scope','name','Industry Definition',
            'section_type','narrative',
            'source', jsonb_build_object('from','human')),
          jsonb_build_object('key','force_ratings','name','The Five Forces, Rated',
            'section_type','table',
            'source', jsonb_build_object('from','synthesis','state','approved',
                                         'weights', jsonb_build_array('intensity'),
                                         'order_by','weight:intensity desc')),
          jsonb_build_object('key','determinants','name','What Drives Each Force',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'group_by','factor_category')),
          jsonb_build_object('key','attractiveness','name','Industry Attractiveness',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','moves','name','Positioning Moves',
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
where m.key = 'five-forces'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('five-forces');
