-- ============================================================
-- Transformation Planning
--
-- Turning conclusions into a SEQUENCED PORTFOLIO: initiatives with value and
-- effort, grouped into time-boxed waves, with explicit dependencies — what
-- must be true before this can start — and the benefits tracked against plan.
--
-- Three things here that nothing else has needed:
--
-- 1. An ANY-TO-ANY relate stage. A dependency joins two initiatives, which may
--    sit in any workstream, so its relationship type declares no source or
--    target category. The pairing validator already treats a null category as
--    "any" (pkg/handlers/objects.go), so this needed no code — it was latent
--    capability, discovered rather than built.
--
-- 2. Grouping a report by a WEIGHT. The roadmap is the initiative table
--    grouped by wave, which the section engine does with
--    "group_by": "weight:wave". That is how a roadmap gets rendered without a
--    timeline renderer, per the decision to compose rather than extend.
--
-- 3. A weight used as a BUCKET rather than a rating. `wave` is 1-4 on the same
--    mechanism as a maturity score, but it means "when", not "how much" — and
--    the engine does not need to care about the difference.
--
-- Reference: https://umbrex.com/resources/frameworks/organization-frameworks/mckinsey-transformation-office-wave-based-transformation-model/
-- Seeded inactive.
-- ============================================================

insert into public.methodologies (key, name, description, version, is_active)
values ('transformation', 'Transformation Planning',
        'Turns agreed conclusions into a sequenced portfolio: initiatives rated for value and effort, grouped into delivery waves, with the dependencies between them made explicit.',
        '1.0', false)
on conflict (key) do nothing;

insert into public.methodology_factor_categories
  (methodology_id, key, name, color_token, sort_order, guidance_text)
select m.id, v.key, v.name, 'category-' || v.sort_order, v.sort_order, v.guidance
from public.methodologies m,
  (values
    ('customer_experience', 'Customer Experience', 1,
     'Initiatives that change what the customer sees, feels or receives.'),
    ('operations', 'Operations', 2,
     'Initiatives that change how the work gets done: process, capacity, footprint.'),
    ('technology', 'Technology and Data', 3,
     'Initiatives in the platform: systems, architecture, data, security.'),
    ('organisation', 'Organisation and People', 4,
     'Initiatives that change structure, roles, skills or ways of working.'),
    ('commercial', 'Commercial', 5,
     'Initiatives in pricing, proposition, channel or partnership.'),
    ('foundations', 'Foundations', 6,
     'Enablers that unlock other initiatives and rarely deliver visible benefit alone: governance, data quality, tooling.')
  ) as v(key, name, sort_order, guidance)
where m.key = 'transformation'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, v.key, v.name, v.seq, v.stage_type, v.config::jsonb
from public.methodologies m,
  (values
    ('cx_initiatives',        'Customer Experience',    1, 'capture',    '{"factor_category_key":"customer_experience"}'),
    ('ops_initiatives',       'Operations',             2, 'capture',    '{"factor_category_key":"operations"}'),
    ('tech_initiatives',      'Technology and Data',    3, 'capture',    '{"factor_category_key":"technology"}'),
    ('org_initiatives',       'Organisation and People',4, 'capture',    '{"factor_category_key":"organisation"}'),
    ('commercial_initiatives','Commercial',             5, 'capture',    '{"factor_category_key":"commercial"}'),
    ('foundation_initiatives','Foundations',            6, 'capture',    '{"factor_category_key":"foundations"}'),
    ('portfolio_rating',      'Value and Effort',       7, 'prioritize', '{"weights":["value","effort","wave"]}'),
    ('dependencies',          'Dependencies',           8, 'relate',     '{}'),
    ('workstreams',           'Workstreams',            9, 'synthesize', '{"groups":"factor"}'),
    ('sequencing_logic',      'Sequencing Logic',      10, 'interpret',  '{"cites":["synthesis","factor_relationship"]}'),
    ('roadmap_commitments',   'Commitments',           11, 'recommend',  '{"cites":["insight"]}')
  ) as v(key, name, seq, stage_type, config)
where m.key = 'transformation'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_weights
  (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
   constraint_type, per_participant, aggregate, allowed_roles, guidance_text, sort_order)
select m.id, v.key, v.name, 'factor', v.lo, v.hi, 1, v.labels::jsonb,
       'single', false, 'latest', array['facilitator','analyst'], v.guidance, v.sort_order
from public.methodologies m,
  (values
    ('value', 'Value', 1, 1, 5,
     '["Marginal","Small","Material","Large","Transformative"]',
     'The benefit if delivered, in terms the sponsor would recognise.'),
    ('effort', 'Effort', 2, 1, 5,
     '["Days","Weeks","A quarter","Two quarters","A year or more"]',
     'What it will actually take, including the parts nobody wants to count.'),
    -- A four-wave horizon. Note this is a bucket, not a rating: the engine
    -- treats it identically, which is the point.
    ('wave', 'Wave', 3, 1, 4,
     '["Wave 1 — now","Wave 2 — next","Wave 3 — later","Wave 4 — horizon"]',
     'When this starts. Foundations usually land early and show little benefit until the waves that depend on them.')
  ) as v(key, name, sort_order, lo, hi, labels, guidance)
where m.key = 'transformation'
on conflict (methodology_id, key) do nothing;

-- A dependency joins two initiatives in ANY workstream, so no source or target
-- category is declared. The pairing validator reads a null category as "any".
insert into public.methodology_relationship_types
  (methodology_id, key, name, source_category_id, target_category_id, guidance_text)
select m.id, 'depends_on', 'Depends On', null, null,
  'The source initiative cannot start, or cannot deliver, until the target is in place. Keep these to real constraints — a dependency added for comfort turns into a delay.'
from public.methodologies m
where m.key = 'transformation'
on conflict (methodology_id, key) do nothing;

insert into public.methodology_stages
  (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'transformation_report', 'Roadmap Report', 12, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'roadmap',
        'name', 'Transformation Roadmap',
        'description', 'The initiative portfolio by wave, what depends on what, and what is being committed to.',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          -- The roadmap itself: the portfolio bucketed into waves. No timeline
          -- renderer; the grouping carries the sequence.
          jsonb_build_object('key','roadmap','name','Roadmap by Wave',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('wave','value','effort'),
                                         'group_by','weight:wave',
                                         'order_by','weight:value desc')),
          jsonb_build_object('key','portfolio','name','Initiative Portfolio',
            'section_type','table',
            'source', jsonb_build_object('from','factor','state','approved',
                                         'weights', jsonb_build_array('value','effort'),
                                         'order_by','weight:value desc')),
          jsonb_build_object('key','dependencies','name','Dependencies',
            'section_type','pair_matrix',
            'source', jsonb_build_object('from','factor_relationship','state','approved',
                                         'group_by','relationship_type')),
          jsonb_build_object('key','workstreams','name','Workstreams',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','sequencing','name','Why This Sequence',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved')),
          jsonb_build_object('key','commitments','name','Commitments',
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
where m.key = 'transformation'
on conflict (methodology_id, key) do nothing;

select public.seed_methodology_ai_prompts('transformation');
