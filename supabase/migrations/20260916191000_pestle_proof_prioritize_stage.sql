-- ============================================================
-- Extend the PESTLE proof stub to cover Phase 1's surface.
--
-- The stub exists to prove the engine is generic. Phase 1 added a review
-- board and a prioritization stage, so the stub has to exercise those too or
-- it stops being a proof of anything.
--
-- Deliberately DIFFERENT from SWOT-TOWS in the ways that would break a
-- hardcoded implementation:
--   * six factor categories, not four
--   * a vote budget of 6, not 20
--   * a review stage sequenced between capture and prioritize
--
-- If rendering this requires a code change, the architecture is wrong.
-- PESTLE stays is_active = false: it is a test fixture, not a product.
-- ============================================================

insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.sequence_number, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('economic_discovery',      'Economic Discovery',      2, 'capture',    '{"factor_category_key":"economic"}'),
    ('social_discovery',        'Social Discovery',        3, 'capture',    '{"factor_category_key":"social"}'),
    ('technological_discovery', 'Technological Discovery', 4, 'capture',    '{"factor_category_key":"technological"}'),
    ('legal_discovery',         'Legal Discovery',         5, 'capture',    '{"factor_category_key":"legal"}'),
    ('environmental_discovery', 'Environmental Discovery', 6, 'capture',    '{"factor_category_key":"environmental"}'),
    ('pestle_prioritization',   'Prioritization',          7, 'prioritize', '{"votes_per_participant":6}')
  ) as v(key, name, sequence_number, stage_type, config)
where m.key = 'pestle'
  and not exists (
    select 1 from public.methodology_stages s
    where s.methodology_id = m.id and s.key = v.key
  );
