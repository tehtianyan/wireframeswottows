-- ============================================================
-- recommendations.confidence_score
--
-- Every other reviewable object type (factors, syntheses,
-- factor_relationships, insights) carries confidence_score; recommendations
-- was the only one without it, which broke the generic list query with
-- 'column "confidence_score" does not exist'.
--
-- Adding the column rather than teaching the registry to skip it, because
-- this is a genuine gap and not a deliberate difference: the seeded
-- recommendation_generation AI prompt already returns confidence_score in its
-- output schema, so Phase 3 needs somewhere to put it.
-- ============================================================

alter table public.recommendations
  add column if not exists confidence_score numeric(4,2);
