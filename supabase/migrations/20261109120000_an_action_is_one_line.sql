-- An action is ONE LINE, so `recommendations.description` becomes nullable.
--
-- THE DEFECT, found by a browser probe and by nothing else. The TOWS matrix's
-- quick-add offers a second box labelled "More detail (optional)", submits
-- with just a title when it is left blank, and the server answers
-- **"What to do is required."** So adding an action — the thing the whole
-- matrix exists to collect — failed unless you also wrote a paragraph.
--
-- THIS IS THE SAME BUG AS THE THEME-NAMING PROMPT, one kind along. That one
-- was: `insertObject` required a description from every kind with
-- `HasDescription`, justified as "it is NOT NULL for every kind that has one"
-- — true of two kinds out of three — so Go invented a requirement the schema
-- did not have and the capture board's naming prompt could never satisfy it.
-- `objects.Kind.DescriptionRequired` was added to mirror the COLUMN, and it
-- does: `recommendations.description` really is NOT NULL. So this time Go is
-- right about the schema and the SCHEMA is wrong about the product.
--
-- WHY THE COLUMN IS WHAT CHANGES, and not the form. The alternative was to
-- make the second box required, and it would have been wrong for the same
-- reason `syntheses.description` is nullable: in the mockup the room asked
-- for, each action IS a single line of text — "Build out AI messaging that
-- differentiates us" — typed fast, in front of everybody, one per line. The
-- title is the instruction; the body is elaboration somebody may add later.
-- Refusing the line for want of a paragraph makes the screen unusable for the
-- thing it is for, and a form that calls a field optional while the server
-- requires it is the defect, not the form.
--
-- `insights.description` stays NOT NULL. An insight is a CLAIM and its
-- description is what the claim says; the asymmetry is real and is exactly
-- what `DescriptionRequired` exists to carry. Nothing is uniform here on
-- purpose.
--
-- NOTHING IS LOST: relaxing NOT NULL cannot invalidate an existing row, and
-- every recommendation that has a description keeps it. The write path already
-- stores NULL for an absent one (`trimPtr`, the same shape a theme uses), so
-- no Go read path changes — `Description` has been a `*string` since Phase 2.

alter table public.recommendations
  alter column description drop not null;

comment on column public.recommendations.description is
  'Optional elaboration. The TITLE is the instruction — an action is one line, typed in the room — so this is nullable, like syntheses.description and unlike insights.description.';

-- ------------------------------------------------------------
-- Verify, including the asymmetry
-- ------------------------------------------------------------

do $$
declare
  n int;
begin
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'recommendations'
         and column_name = 'description') <> 'YES' then
    raise exception 'recommendations.description is still NOT NULL';
  end if;

  -- An insight's description is its claim and must stay required. If this
  -- ever flips, "nothing is uniform here on purpose" has quietly stopped
  -- being true and objects.Kind.DescriptionRequired is lying about one kind.
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'insights'
         and column_name = 'description') <> 'NO' then
    raise exception 'insights.description became nullable — that is a different decision, not this one';
  end if;

  select count(*) into n from public.recommendations where description is not null;
  raise notice 'an action is one line; % recommendation(s) keep their description', n;
end $$;
