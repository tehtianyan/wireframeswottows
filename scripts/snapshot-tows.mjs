#!/usr/bin/env node
// A before/after snapshot for the TOWS actions migration.
//
// The two snapshots are what make "nothing was lost" a fact rather than a
// hope. This migration renumbers every swot-tows stage and rewrites
// `activities.sequence_number` to match, so the counts that matter are the
// ones it touches plus the content that must be untouched.
//
//   SWOT_ENV_FILE=.env node scripts/snapshot-tows.mjs
import fs from "node:fs";
import { Client } from "pg";

const file = process.env.SWOT_ENV_FILE ?? ".env.dev";
const env = Object.fromEntries(
  fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const c = new Client({ connectionString: env.DATABASE_URL });
await c.connect();

const q = async (label, sql) => {
  const { rows } = await c.query(sql);
  console.log(`\n-- ${label}`);
  console.table(rows);
};

console.log(`snapshot · ${file} · ${env.SUPABASE_PROJECT_ID ?? "?"}`);

await q("content that must not change", `
  select
    (select count(*) from public.factors)              as factors,
    (select count(*) from public.syntheses)            as syntheses,
    (select count(*) from public.factor_relationships) as relationships,
    (select count(*) from public.insights)             as insights,
    (select count(*) from public.recommendations)      as recommendations,
    (select count(*) from public.weights)              as weights,
    (select count(*) from public.reports)              as reports,
    (select count(*) from public.workshops)            as workshops`);

await q("swot-tows stage order and visibility", `
  select s.sequence_number as seq, s.key, s.stage_type,
         coalesce(s.config -> 'visible_to_roles' ->> 0, 'everyone') as visible_to,
         (s.config ->> 'layout')      as layout,
         (s.config -> 'actions' is not null) as has_actions
    from public.methodology_stages s
    join public.methodologies m on m.id = s.methodology_id
   where m.key = 'swot-tows'
   order by s.sequence_number`);

await q("activities disagreeing with their stage (must be 0)", `
  select count(*) as mismatched
    from public.activities a
    join public.methodology_stages s on s.id = a.stage_id
   where a.sequence_number <> s.sequence_number`);

await q("weights defined per methodology", `
  select m.key as methodology, count(*) as weights,
         string_agg(w.key, ', ' order by w.key) as keys
    from public.methodology_weights w
    join public.methodologies m on m.id = w.methodology_id
   group by m.key order by m.key`);

// `to_regclass` does NOT save a subquery on a missing table: Postgres parses
// the whole statement before evaluating anything, so the guard is useless and
// the snapshot dies on the run that matters most — the one BEFORE the table
// exists. Counted dynamically instead.
{
  const { rows: [{ exists }] } = await c.query(
    `select to_regclass('public.initiatives') is not null as exists`);
  const count = exists
    ? (await c.query("select count(*) as n from public.initiatives")).rows[0].n
    : "n/a";
  console.log("\n-- initiatives table");
  console.table([{ table_exists: exists, rows: count }]);
}

await q("RLS gaps (must be empty)", `select * from public.rls_coverage_gaps`);

await c.end();
