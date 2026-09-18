-- ============================================================
-- Report templates as methodology configuration
--
-- A "report type" is a configured list of sections, which gives App Spec
-- §14.4-14.8's five report types as config rather than code, and lets any
-- future methodology define its own.
--
-- This lives in the report stage's `config` jsonb rather than a new
-- methodology_report_templates table, because the other methodology_* tables
-- exist to be referenced by FOREIGN KEY from object tables
-- (factors -> factor_categories, factor_relationships -> relationship_types,
-- activities -> stages). Nothing references a report type by FK; it is a
-- stage parameter, exactly like votes_per_participant and cites.
--
-- Section vocabulary — every value is something the engine already knows:
--   section_type  a platform renderer (narrative, category_matrix, ...)
--   source.from   an object registry key, or 'factor', or 'ai'
--   group_by      'factor_category' or 'relationship_type', resolved from
--                 methodology config at render time
--
-- This is how "the SWOT matrix" and "the TOWS matrix" are expressed without
-- either word appearing: a category_matrix grouped by factor_category, and a
-- pair_matrix grouped by relationship_type. SWOT-TOWS has four categories and
-- four relationship types, so those come out as the familiar 2x2 grids —
-- emergent from data, not from code. PESTLE's six categories produce six
-- groups from the same section, and its lack of relationship types means a
-- pair_matrix simply has nothing to render.
-- ============================================================

update public.methodology_stages ms
set config = ms.config || jsonb_build_object(
  -- The report stage's AI needs the approved analysis as context. Declaring
  -- it as `cites` reuses the existing generic context builder rather than
  -- adding a report branch to Go.
  'cites', jsonb_build_array('synthesis', 'insight'),
  'report_types', jsonb_build_array(

    jsonb_build_object(
      'key', 'executive',
      'name', 'Executive Summary Report',
      'description', 'Decision-ready summary for senior leaders. Target 2-5 pages.',
      'default', true,
      -- §14.12: "The report should not be generated if required inputs are
      -- missing." Expressed generically as counts of approved objects.
      'requires', jsonb_build_array(
        jsonb_build_object('kind', 'synthesis',      'state', 'approved', 'min', 1),
        jsonb_build_object('kind', 'insight',        'state', 'approved', 'min', 1),
        jsonb_build_object('kind', 'recommendation', 'state', 'approved', 'min', 1)
      ),
      'sections', jsonb_build_array(
        jsonb_build_object('key','exec_summary','name','Executive Summary',
          'section_type','narrative',
          'source', jsonb_build_object('from','ai','function_key','executive_summary_generation',
                                       'path','executive_summary.situation_summary')),
        jsonb_build_object('key','key_findings','name','Key Findings',
          'section_type','narrative',
          'source', jsonb_build_object('from','ai','function_key','executive_summary_generation',
                                       'path','executive_summary.key_findings')),
        jsonb_build_object('key','factor_matrix','name','Factor Overview',
          'section_type','category_matrix',
          'source', jsonb_build_object('from','factor','state','approved',
                                       'group_by','factor_category','order_by','votes')),
        jsonb_build_object('key','strategy_matrix','name','Strategy Matrix',
          'section_type','pair_matrix',
          'source', jsonb_build_object('from','factor_relationship','state','approved',
                                       'group_by','relationship_type')),
        jsonb_build_object('key','themes','name','Strategic Themes',
          'section_type','bullet_list',
          'source', jsonb_build_object('from','synthesis','state','approved')),
        jsonb_build_object('key','insights','name','Strategic Insights',
          'section_type','bullet_list',
          'source', jsonb_build_object('from','insight','state','approved')),
        jsonb_build_object('key','recommendations','name','Top Recommendations',
          'section_type','object_list','selectable', true,
          'source', jsonb_build_object('from','recommendation','state','approved',
                                       'order_by','priority')),
        jsonb_build_object('key','next_steps','name','Recommended Next Steps',
          'section_type','narrative',
          'source', jsonb_build_object('from','ai','function_key','executive_summary_generation',
                                       'path','executive_summary.next_steps')),
        jsonb_build_object('key','evidence','name','Evidence Chain',
          'section_type','evidence_chain','included_by_default', false,
          'source', jsonb_build_object('from','recommendation','state','approved','expand','citations'))
      )
    ),

    jsonb_build_object(
      'key', 'factor_analysis',
      'name', 'Factor Analysis Report',
      'description', 'The full captured picture, by category, with priorities.',
      'requires', jsonb_build_array(
        jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
      ),
      'sections', jsonb_build_array(
        jsonb_build_object('key','factor_matrix','name','Factor Overview',
          'section_type','category_matrix',
          'source', jsonb_build_object('from','factor','state','approved',
                                       'group_by','factor_category','order_by','votes')),
        jsonb_build_object('key','themes','name','Themes',
          'section_type','bullet_list',
          'source', jsonb_build_object('from','synthesis','state','approved')),
        jsonb_build_object('key','appendix','name','Appendix — All Factors',
          'section_type','appendix',
          'source', jsonb_build_object('from','factor','state','approved','group_by','factor_category'))
      )
    ),

    jsonb_build_object(
      'key', 'recommendations',
      'name', 'Recommendation Report',
      'description', 'The recommendation table and the evidence beneath it.',
      'requires', jsonb_build_array(
        jsonb_build_object('kind', 'recommendation', 'state', 'approved', 'min', 1)
      ),
      'sections', jsonb_build_array(
        -- §14.23 mandates this table's columns.
        jsonb_build_object('key','rec_table','name','Recommendations',
          'section_type','table','selectable', true,
          'source', jsonb_build_object('from','recommendation','state','approved',
                                       'order_by','priority')),
        jsonb_build_object('key','evidence','name','Evidence Chain',
          'section_type','evidence_chain',
          'source', jsonb_build_object('from','recommendation','state','approved','expand','citations'))
      )
    )
  )
)
from public.methodologies m
where ms.methodology_id = m.id
  and m.key = 'swot-tows'
  and ms.stage_type = 'report'
  and not (ms.config ? 'report_types');

-- ------------------------------------------------------------
-- PESTLE proof: a report stage whose shape would break any hardcoding.
--
-- PESTLE has no relate stage and no recommend stage, so its template has NO
-- strategy matrix and NO recommendation section, and its `requires` gate asks
-- only for themes. If reporting renders this correctly with no code change,
-- the section engine is genuinely config-driven.
-- ------------------------------------------------------------

insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
select m.id, 'pestle_reporting', 'Driver Report', 10, 'report',
  jsonb_build_object(
    'cites', jsonb_build_array('synthesis', 'insight'),
    'report_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'driver_scan',
        'name', 'Driver Scan Report',
        'default', true,
        'requires', jsonb_build_array(
          jsonb_build_object('kind', 'synthesis', 'state', 'approved', 'min', 1)
        ),
        'sections', jsonb_build_array(
          jsonb_build_object('key','factor_matrix','name','PESTLE Overview',
            'section_type','category_matrix',
            'source', jsonb_build_object('from','factor','state','approved','group_by','factor_category')),
          jsonb_build_object('key','drivers','name','Key Drivers',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','synthesis','state','approved')),
          jsonb_build_object('key','implications','name','Implications',
            'section_type','bullet_list',
            'source', jsonb_build_object('from','insight','state','approved'))
        )
      )
    )
  )
from public.methodologies m
where m.key = 'pestle'
  and not exists (
    select 1 from public.methodology_stages s
    where s.methodology_id = m.id and s.key = 'pestle_reporting'
  );

-- ------------------------------------------------------------
-- The executive summary prompt returns named narrative fields, not a list of
-- suggestions to accept one by one. Both aiSuggestions() in the client and
-- firstArray() in Go look for the first ARRAY in the output, so without this
-- the report prompt would silently render "nothing to add".
--
-- Declaring the shape in config beats sniffing it at runtime.
-- ------------------------------------------------------------

alter table public.methodology_ai_prompts
  add column if not exists output_kind text not null default 'suggestions';

alter table public.methodology_ai_prompts drop constraint if exists methodology_ai_prompts_output_kind_check;
alter table public.methodology_ai_prompts add constraint methodology_ai_prompts_output_kind_check
  check (output_kind in ('suggestions', 'narrative'));

update public.methodology_ai_prompts
set output_kind = 'narrative'
where function_key in ('executive_summary_generation', 'workshop_summary', 'traceability_explanation');
