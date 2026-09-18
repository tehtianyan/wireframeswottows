-- ============================================================
-- PESTLE gets its own colour tokens
--
-- The PESTLE proof stub was seeded reusing SWOT's tokens — Political carried
-- color_token 'strength', Economic carried 'weakness', and so on. That worked
-- visually, but it meant SWOT vocabulary travelled inside PESTLE's API
-- responses, and a PESTLE report literally contained the word "strength".
--
-- Caught by the Phase 4 genericity check, which asserts no SWOT/TOWS
-- vocabulary appears anywhere in a PESTLE report. The check was right and the
-- seed data was wrong.
--
-- styles.css now defines six methodology-neutral hues (--category-1..6) in
-- both the dark and light palettes, so a methodology whose categories are not
-- SWOT's four no longer has to borrow a token named after someone else's
-- concept.
-- ============================================================

update public.methodology_factor_categories mfc
set color_token = 'category-' || mfc.sort_order
from public.methodologies m
where mfc.methodology_id = m.id
  and m.key = 'pestle'
  and mfc.sort_order between 1 and 6;
