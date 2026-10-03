#!/usr/bin/env node
// Applies pending migrations against one environment, tracked in the
// public._migrations ledger CLAUDE.md describes.
//
//   node scripts/migrate.mjs                  # dry run against .env.dev
//   node scripts/migrate.mjs --apply          # apply to .env.dev
//   SWOT_ENV_FILE=.env node scripts/migrate.mjs --apply   # production
//
// Two guards, both deliberate:
//   * The default is a DRY RUN. Listing what would change is the common case;
//     changing it should be typed on purpose.
//   * Production is refused unless I_MEAN_PRODUCTION=1 is also set, because
//     production and the live UAT site share one Supabase project and people
//     are using it.
//
// Each file runs in its own transaction and is recorded only if it committed,
// so a failure half way leaves a ledger that still tells the truth.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_REF = "azbqapefetexjqefcdep";

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(path.resolve(ROOT, file), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const envFile = process.env.SWOT_ENV_FILE || ".env.dev";
const apply = process.argv.includes("--apply");
const env = readEnv(envFile);
if (!env.DATABASE_URL) throw new Error(`DATABASE_URL missing from ${envFile}`);

const ref = (env.SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\./)?.[1] ?? "unknown";
if (ref === PRODUCTION_REF && !process.env.I_MEAN_PRODUCTION) {
  console.error(
    `Refusing to touch the production project (${ref}).\n` +
      "Set I_MEAN_PRODUCTION=1 as well if that is genuinely what you want.",
  );
  process.exit(1);
}
console.log(`${apply ? "Applying" : "Dry run"} · ${envFile} · project ${ref}\n`);

const dir = path.join(ROOT, "supabase", "migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const c = new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
// The ledger is created SECURED, in the same breath as the table.
//
// It was not, originally, and that was the one table in `public` without RLS —
// because every other table is created by a migration, which enables RLS as a
// matter of course, while this one is created by the runner, outside the system
// that would have secured it. Supabase served it to anyone holding the
// publishable key, which ships in the browser bundle by design.
//
// Securing it HERE as well as in 20261003100000 is not belt-and-braces for its
// own sake: on a brand-new project this runs BEFORE any migration, so without
// it a fresh database is exposed for the length of the first deploy.
//
// No policies, deliberately — the runner connects as `postgres` (rolbypassrls),
// so RLS with zero policies denies every client and costs the runner nothing.
await c.query(`
  create table if not exists public._migrations (
    name text primary key,
    applied_at timestamptz not null default now());
  alter table public._migrations enable row level security;
  revoke all on public._migrations from public;
  do $$
  begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke all on public._migrations from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke all on public._migrations from authenticated;
    end if;
  end $$;`);
const done = new Set((await c.query("select name from public._migrations")).rows.map((r) => r.name));

const pending = files.filter((f) => !done.has(f));
if (pending.length === 0) {
  console.log(`Nothing pending — all ${files.length} migrations are applied.`);
  await c.end();
  process.exit(0);
}

for (const f of pending) {
  if (!apply) {
    console.log(`  pending  ${f}`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, f), "utf8");
  await c.query("begin");
  try {
    await c.query(sql);
    await c.query("insert into public._migrations (name) values ($1)", [f]);
    await c.query("commit");
    console.log(`  applied  ${f}`);
  } catch (e) {
    await c.query("rollback");
    console.error(`  FAILED   ${f}\n           ${e.message}`);
    await c.end();
    process.exit(1);
  }
}

console.log(
  apply
    ? `\n${pending.length} applied. ${files.length} of ${files.length} migrations are now in place.`
    : `\n${pending.length} pending. Re-run with --apply to apply them.`,
);
await c.end();
