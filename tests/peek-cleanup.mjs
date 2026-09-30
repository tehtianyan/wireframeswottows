// Ad-hoc probe for "Merge and Fix": builds a deliberately messy board, runs
// the real tidy-up, prints what it changed and what it refused, then undoes
// the run and deletes the fixtures.
//
// Not part of run-all.js — it makes a paid model call and is here for judging
// whether the prompt produces sensible edits, which no assertion can do.
//
//   SWOT_ENV_FILE=.env.dev node tests/peek-cleanup.mjs http://localhost:3001
import { db, clients, cleanup, DEMO_WORKSHOP as WS } from "./lib/harness.js";

const baseUrl = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3001";
const PREFIX = "PEEK probe";

const c = await db();
const { facilitator: F } = await clients(baseUrl, ["facilitator"]);
const made = [];
let synthesisId = null;

const mk = async (category, title, description) => {
  const res = await F("POST", `/workshops/${WS}/factors`, {
    category_key: category,
    title: `${PREFIX} ${title}`,
    ...(description ? { description } : {}),
  });
  if (!res.success) throw new Error(res.error?.message);
  made.push(res.data.id);
  return res.data.id;
};

try {
  // Two near-duplicates, a typo, a vague note and one in the wrong panel.
  const cited = await mk("strength", "we have a realy strong brand");
  const dupe = await mk("strength", "brand is well recognised in market");
  const vague = await mk("opportunity", "do more with AI stuff maybe");
  await mk("strength", "billing system is slow and breaks often");
  await mk("threat", "competitors are cheaper");

  // The cited one is now evidence for a theme, which must make it unmergeable.
  const syn = await F("POST", `/workshops/${WS}/syntheses`, {
    title: `${PREFIX} brand theme`,
    description: "grouped",
    evidence: { factor: [cited] },
  });
  synthesisId = syn.data?.id;
  console.log(`fixtures: cited=${cited.slice(0, 8)} dupe=${dupe.slice(0, 8)} vague=${vague.slice(0, 8)}\n`);

  const run = await F("POST", `/workshops/${WS}/cleanup`, { stage_key: "strength_discovery" }, { timeoutMs: 120000 });
  if (!run.success) throw new Error(run.error?.message);

  console.log(`APPLIED (${run.data.changes.length}):`);
  for (const ch of run.data.changes) {
    const detail =
      ch.change_type === "reword"
        ? `"${ch.before.title}" -> "${ch.after.title}"`
        : ch.change_type === "move"
          ? `${ch.factor_title}: ${ch.before.category_key} -> ${ch.after.category_key}`
          : `${ch.factor_title} folded into ${ch.after.merged_into.slice(0, 8)}`;
    console.log(`  ${ch.change_type.padEnd(7)} ${detail}\n          why: ${ch.reason}`);
  }

  console.log(`\nREFUSED (${run.data.skipped.length}):`);
  for (const s of run.data.skipped) {
    console.log(`  ${s.change_type.padEnd(7)} ${s.title}\n          refused: ${s.refused}\n          it said: ${s.reason}`);
  }

  const citedStill = (await c.query("select state from public.factors where id = $1", [cited])).rows[0];
  console.log(`\nthe cited note is still ${citedStill.state} — merging it would have broken the theme's evidence`);

  const undo = await F("POST", `/workshops/${WS}/cleanup/runs/${run.data.id}/undo`, {});
  console.log(`undo: ${undo.data.undone} reversed, ${undo.data.refused.length} refused`);

  await c.query("delete from public.board_cleanup_runs where id = $1", [run.data.id]);
} finally {
  if (synthesisId) await c.query("delete from public.syntheses where id = $1", [synthesisId]);
  await cleanup(c, { titlePrefixes: [PREFIX], ids: { factors: made } });
  await c.end();
}
