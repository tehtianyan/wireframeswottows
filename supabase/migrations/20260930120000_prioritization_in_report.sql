-- ============================================================
-- The prioritization belongs in the report
--
-- UAT: "The prioritization is missing in the executive report because the
-- aggregated prioritization is not shown."
--
-- Correct, and worth being precise about what was missing. Factors WERE in the
-- report: the `factor_matrix` section lists approved factors grouped by
-- category and ordered by votes. But a category_matrix renders titles only, so
-- the ordering was the sole trace of the prioritization and nothing on the page
-- said what the group had actually decided. A reader could not tell a factor
-- everyone backed from one nobody voted for, and the whole point of Journey 9
-- (§4.12, "Top-ranked factors identified") is that distinction.
--
-- No renderer is needed. §14 already composes a rated table from `table` +
-- `"weights": [...]` + `"order_by": "weight:<key> desc"` — the same three keys
-- that make PESTLE's rated scan and ISO 31000's risk register. This is one
-- section of configuration.
--
-- Applied to every methodology that HAS a prioritize stage and a factor weight,
-- and to none that does not, so Business Model Canvas gains nothing.
-- ============================================================

-- ------------------------------------------------------------
-- Insert a "Prioritized Factors" section into each report type that does not
-- already have one, immediately before the factor overview it explains.
--
-- Written as a jsonb rewrite of the stage config rather than a hand-edited
-- blob per methodology, so the eight report stages stay in step and a
-- methodology configured later is unaffected rather than half-updated.
-- ------------------------------------------------------------

do $$
declare
  st record;
  types jsonb;
  new_types jsonb;
  t jsonb;
  sections jsonb;
  new_sections jsonb;
  sec jsonb;
  weight_key text;
  new_section jsonb;
  inserted boolean;
begin
  for st in
    select s.id, s.methodology_id, s.config, m.key as mkey
    from public.methodology_stages s
    join public.methodologies m on m.id = s.methodology_id
    where s.stage_type = 'report'
      -- Only where there is a prioritization to report.
      and exists (
        select 1 from public.methodology_stages p
        where p.methodology_id = s.methodology_id and p.stage_type = 'prioritize'
      )
  loop
    -- The weight to rank by is the methodology's own first factor weight, in
    -- its configured order. Nothing here assumes 'vote': Five Forces ranks by
    -- intensity, ISO 31000 by likelihood.
    select w.key into weight_key
    from public.methodology_weights w
    where w.methodology_id = st.methodology_id and w.applies_to = 'factor'
    order by w.sort_order, w.key
    limit 1;

    if weight_key is null then
      continue;
    end if;

    types := st.config -> 'report_types';
    if types is null or jsonb_typeof(types) <> 'array' then
      continue;
    end if;

    new_types := '[]'::jsonb;
    for t in select * from jsonb_array_elements(types)
    loop
      sections := t -> 'sections';
      if sections is null or jsonb_typeof(sections) <> 'array' then
        new_types := new_types || jsonb_build_array(t);
        continue;
      end if;

      -- Idempotent: re-running must not stack duplicate sections.
      if exists (
        select 1 from jsonb_array_elements(sections) x
        where x ->> 'key' = 'prioritized_factors'
      ) then
        new_types := new_types || jsonb_build_array(t);
        continue;
      end if;

      new_section := jsonb_build_object(
        'key', 'prioritized_factors',
        'name', 'Prioritized Factors',
        'section_type', 'table',
        'source', jsonb_build_object(
          'from', 'factor',
          'state', 'approved',
          'weights', jsonb_build_array(weight_key),
          'order_by', 'weight:' || weight_key || ' desc'
        )
      );

      new_sections := '[]'::jsonb;
      inserted := false;
      for sec in select * from jsonb_array_elements(sections)
      loop
        -- Placed just before the factor overview, so the reader meets what the
        -- group ranked highest before the full grouped list.
        if not inserted and sec ->> 'section_type' = 'category_matrix' then
          new_sections := new_sections || jsonb_build_array(new_section);
          inserted := true;
        end if;
        new_sections := new_sections || jsonb_build_array(sec);
      end loop;
      if not inserted then
        new_sections := new_sections || jsonb_build_array(new_section);
      end if;

      new_types := new_types || jsonb_build_array(jsonb_set(t, '{sections}', new_sections));
    end loop;

    update public.methodology_stages
    set config = jsonb_set(config, '{report_types}', new_types)
    where id = st.id;
  end loop;
end $$;

-- A check that the rewrite did what it claims, rather than trusting a loop that
-- silently did nothing. Every report stage of a methodology that prioritizes
-- must now carry the section in every one of its report types.
do $$
declare missing int;
begin
  select count(*) into missing
  from public.methodology_stages s
  join public.methodologies m on m.id = s.methodology_id
  cross join lateral jsonb_array_elements(s.config -> 'report_types') t
  where s.stage_type = 'report'
    and exists (
      select 1 from public.methodology_stages p
      where p.methodology_id = s.methodology_id and p.stage_type = 'prioritize'
    )
    and exists (
      select 1 from public.methodology_weights w
      where w.methodology_id = s.methodology_id and w.applies_to = 'factor'
    )
    and not exists (
      select 1 from jsonb_array_elements(t -> 'sections') x
      where x ->> 'key' = 'prioritized_factors'
    );
  if missing > 0 then
    raise exception 'prioritized_factors missing from % report type(s)', missing;
  end if;
end $$;
