-- ============================================================
-- SWOT-TOWS captures on the board
--
-- The capture board renders every factor category at once, laid out from the
-- COUNT of categories: four produce the 2x2 a SWOT wall is expected to be,
-- PESTLE's six produce 3x2, the Business Model Canvas's nine produce 3x3 —
-- one component, no methodology named anywhere in it.
--
-- Opting in is a stage parameter, exactly like votes_per_participant and
-- cites. SWOT-TOWS turns it on here; the other seven methodologies keep the
-- single-category canvas until somebody decides otherwise. That is the whole
-- change: no code is conditional on a methodology key.
-- ============================================================

update public.methodology_stages ms
set config = ms.config || jsonb_build_object('layout', 'board')
from public.methodologies m
where ms.methodology_id = m.id
  and m.key = 'swot-tows'
  and ms.stage_type = 'capture';
