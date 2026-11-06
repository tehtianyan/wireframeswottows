-- THE TOWS MATRIX PAIRS THEMES (DECIDED 2026-11-06)
--
-- UAT: "modify the Relationship matrix under the TOWS Matrix stage to pair
-- Themes, not pair factors."
--
-- It follows the participant flow shipped in 20261106100000. A room now
-- captures strengths, groups them into themes on the same board, and rates
-- those themes — so by the time it reaches the matrix the unit of analysis is
-- a theme, and pairing one sticky note against another throws away the
-- grouping work the previous stage existed to do.
--
-- IT IS CONFIGURATION, NOT THE ENGINE'S NEW BEHAVIOUR, and that distinction is
-- the whole shape of this migration. Two other configured methodologies run a
-- relate stage over FACTORS:
--   * business-model  — revenue_streams x cost_structure, value_propositions
--                       x customer_segments;
--   * transformation  — depends_on, any category to any category.
-- Making the engine pair syntheses would have silently rewritten both. So
-- `factor_relationships` can now hold EITHER pair, the relate stage's own
-- config says which (`"pairs": "synthesis"`), and only swot-tows declares it.
--
-- A THEME HAS NO CATEGORY COLUMN, ON PURPOSE. `syntheses` stores a title and a
-- description; the category is DERIVED from the factors the theme cites through
-- `synthesis_factors`. Two reasons, and the first is a rule this codebase has
-- already settled: whether a theme may span categories is a METHODOLOGY
-- question the engine deliberately refuses to answer (see CLAUDE.md on
-- same-category stacking being a client affordance). Stamping a category at
-- creation would answer it, and would also go stale the moment notes are
-- regrouped. Go refuses a theme that spans two categories and names both,
-- rather than resolving to the first.

-- ---------------------------------------------------------------------------
-- 1. The second endpoint pair.
-- ---------------------------------------------------------------------------
alter table public.factor_relationships
  add column if not exists source_synthesis_id uuid references public.syntheses (id) on delete cascade,
  add column if not exists target_synthesis_id uuid references public.syntheses (id) on delete cascade;

create index if not exists factor_relationships_source_synthesis_idx
  on public.factor_relationships (source_synthesis_id);
create index if not exists factor_relationships_target_synthesis_idx
  on public.factor_relationships (target_synthesis_id);

-- EXACTLY ONE PAIR, ENFORCED BY THE DATABASE.
--
-- A relationship joining a factor to a theme, or joining nothing at all, is
-- not a thing that should be merely refused by a handler — it is a record that
-- contradicts itself, so it is made unrepresentable. Same reasoning as "an
-- approval names its reviewer" and "published with no snapshot".
--
-- Verified BEFORE the constraint is added, because a CHECK that fails to apply
-- rolls the whole migration back with a message about a constraint rather than
-- about the data. This says which rows are wrong.
do $$
declare
  bad int;
begin
  select count(*) into bad
    from public.factor_relationships
   where source_factor_id is null or target_factor_id is null;
  if bad > 0 then
    raise exception
      'relate_pairs_themes: % existing factor_relationships rows have an incomplete factor pair; '
      'the one-pair CHECK cannot be added until they are fixed or removed', bad;
  end if;
end $$;

alter table public.factor_relationships
  drop constraint if exists factor_relationships_one_pair_check;

alter table public.factor_relationships
  add constraint factor_relationships_one_pair_check check (
    (source_factor_id    is not null and target_factor_id    is not null
     and source_synthesis_id is null and target_synthesis_id is null)
    or
    (source_synthesis_id is not null and target_synthesis_id is not null
     and source_factor_id    is null and target_factor_id    is null)
  );

-- ---------------------------------------------------------------------------
-- 2. swot-tows pairs themes. One jsonb key, no code.
-- ---------------------------------------------------------------------------
update public.methodology_stages s
   set config = coalesce(s.config, '{}'::jsonb) || jsonb_build_object('pairs', 'synthesis')
  from public.methodologies m
 where m.id = s.methodology_id
   and m.key = 'swot-tows'
   and s.stage_type = 'relate';

-- The stage guidance says what the cells pair, and it said "factors".
update public.methodology_stages s
   set config = s.config || jsonb_build_object(
         'pair_noun', 'theme',
         'pair_noun_plural', 'themes')
  from public.methodologies m
 where m.id = s.methodology_id
   and m.key = 'swot-tows'
   and s.stage_type = 'relate';

-- ---------------------------------------------------------------------------
-- 3. Verify, and RAISE rather than warn.
--
-- The 20261106100000 migration's own first verification mistook Porter's
-- pre-existing synthesis weight for a leak and raised — which is how that was
-- found. These checks are therefore phrased about the SPECIFIC thing changed,
-- never "no other methodology has X".
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  -- swot-tows' relate stage pairs syntheses.
  select count(*) into n
    from public.methodology_stages s
    join public.methodologies m on m.id = s.methodology_id
   where m.key = 'swot-tows' and s.stage_type = 'relate'
     and s.config->>'pairs' = 'synthesis';
  if n <> 1 then
    raise exception 'relate_pairs_themes: expected 1 swot-tows relate stage pairing syntheses, found %', n;
  end if;

  -- AND NOBODY ELSE'S DOES. This is the genericity claim for this change: the
  -- other two methodologies with a relate stage must be untouched, or the
  -- "configuration not engine" reasoning above is not actually true.
  select count(*) into n
    from public.methodology_stages s
    join public.methodologies m on m.id = s.methodology_id
   where m.key <> 'swot-tows' and s.stage_type = 'relate'
     and s.config->>'pairs' is not null;
  if n <> 0 then
    raise exception 'relate_pairs_themes: % relate stages outside swot-tows declare a pairs target; '
      'this migration must change swot-tows only', n;
  end if;

  -- The relationship types themselves are UNCHANGED, and must be: a type still
  -- names factor CATEGORIES ("so" runs strength to opportunity), and a theme's
  -- category is derived from its notes. Had this needed new columns on
  -- methodology_relationship_types, the claim that a theme has a category at
  -- all would have been wrong.
  select count(*) into n
    from public.methodology_relationship_types t
    join public.methodologies m on m.id = t.methodology_id
   where m.key = 'swot-tows';
  if n <> 4 then
    raise exception 'relate_pairs_themes: expected swot-tows to still have its 4 relationship types, found %', n;
  end if;

  -- The one-pair CHECK is live.
  select count(*) into n
    from pg_constraint
   where conname = 'factor_relationships_one_pair_check';
  if n <> 1 then
    raise exception 'relate_pairs_themes: the one-pair CHECK was not created';
  end if;
end $$;
