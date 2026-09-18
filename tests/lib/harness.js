// Shared harness for the API test suites.
//
// These are integration tests: they run against a real server (local or
// production) and a real Supabase database, signing in as the real demo
// accounts. There is no mocking, because the things most worth testing here —
// row-level security, role enforcement, database constraints and triggers —
// only exist when the real database is involved.
//
// No secrets are baked in. Everything is read from wireframeswottows/.env.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");

function env() {
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const DEMO_PASSWORD = "SwotDemo2026!";

/** The seeded demo workshop every suite works against. */
const DEMO_WORKSHOP = "52efe15a-9f32-4a03-86c9-51bc5c929314";

const ACCOUNTS = {
  facilitator: "jane.smith@example.com",
  analyst: "sarah.chen@example.com",
  participant: "dana.whitfield@example.com",
  executive: "ingrid.holm@example.com",
};

// ---- assertions ----

class Results {
  constructor() {
    this.passed = 0;
    this.failed = 0;
  }
  ok(condition, label, detail) {
    const mark = condition ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${label}${detail !== undefined ? ` -> ${detail}` : ""}`);
    condition ? this.passed++ : this.failed++;
    return Boolean(condition);
  }
  section(title) {
    console.log("");
    console.log(`=== ${title} ===`);
  }
  note(message) {
    console.log(`  (${message})`);
  }
  summary(name) {
    console.log("");
    const total = this.passed + this.failed;
    console.log(
      this.failed === 0
        ? `  RESULT: ${name} — all ${total} checks passed.`
        : `  RESULT: ${name} — ${this.failed} of ${total} checks FAILED.`,
    );
    return this.failed === 0;
  }
}

// ---- auth + HTTP ----

function supabaseClient() {
  const e = env();
  const url = e.SUPABASE_URL || e.VITE_SUPABASE_URL;
  const key = e.SUPABASE_PUBLISHABLE_KEY || e.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY missing from .env");
  return createClient(url, key);
}

// Supabase auth occasionally stalls rather than failing, so every attempt is
// raced against a timeout. A hung sign-in used to hang an entire suite.
async function token(email) {
  const sb = supabaseClient();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await Promise.race([
        sb.auth.signInWithPassword({ email, password: DEMO_PASSWORD }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 20000)),
      ]);
      if (!res.error) return res.data.session.access_token;
      if (attempt === 4) throw new Error(res.error.message);
    } catch (e) {
      console.log(`  (auth attempt ${attempt} for ${email} failed: ${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`could not authenticate ${email}`);
}

/** Returns an API caller bound to one account's token. */
function client(baseUrl, accessToken) {
  return async function call(method, apiPath, body, opts = {}) {
    const init = {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(`${baseUrl}/api/v1${apiPath}`, init);
    const text = await res.text();
    if (opts.raw) return { status: res.status, text, headers: res.headers };
    try {
      return Object.assign({ status: res.status }, JSON.parse(text));
    } catch {
      return { status: res.status, success: false, error: { code: "NON_JSON", message: text.slice(0, 160) } };
    }
  };
}

/** Signs in as several accounts at once and returns callers keyed by role. */
async function clients(baseUrl, roles) {
  const out = {};
  for (const role of roles) {
    const email = ACCOUNTS[role];
    if (!email) throw new Error(`unknown demo role ${role}`);
    out[role] = client(baseUrl, await token(email));
  }
  return out;
}

// ---- database ----

async function db() {
  const e = env();
  if (!e.DATABASE_URL) throw new Error("DATABASE_URL missing from .env");
  const c = new Client({ connectionString: e.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

/**
 * Removes rows a suite created.
 *
 * Published reports cannot be deleted by design — that is the whole point of
 * the reports_immutable trigger — so the harness disables the guard rather
 * than pretending it is not there.
 */
async function cleanup(c, { titlePrefixes = [], allReports = false } = {}) {
  if (allReports) {
    await c.query("alter table public.reports disable trigger reports_immutable");
    await c.query("alter table public.report_sections disable trigger report_sections_frozen");
    await c.query("delete from public.reports");
    await c.query("alter table public.reports enable trigger reports_immutable");
    await c.query("alter table public.report_sections enable trigger report_sections_frozen");
  }
  for (const prefix of titlePrefixes) {
    for (const table of ["recommendations", "insights", "factor_relationships", "syntheses", "factors"]) {
      await c.query(`delete from public.${table} where title like $1`, [`${prefix}%`]);
    }
  }
}

/** Restores the demo workshop to the state suites assume at start. */
async function resetDemoState(c) {
  await c.query("delete from public.knowledge_assets");
  await c.query("delete from public.notifications");
  await c.query("update public.profiles set global_role = 'user'");
  await c.query("update public.workshops set status = 'active' where status <> 'active'");
}

// ---- runner ----

/**
 * Wraps a suite: opens the database, runs it, always cleans up, and exits
 * non-zero on failure so CI can see it.
 */
async function runSuite(name, fn) {
  const baseUrl = process.argv[2] || "http://localhost:3000";
  console.log(`# ${name}  (${baseUrl})`);
  const results = new Results();
  const c = await db();
  try {
    await fn({ baseUrl, results, c, DEMO_WORKSHOP });
  } catch (e) {
    console.error(`HARNESS ERROR: ${e.message}`);
    results.failed++;
  } finally {
    await c.end().catch(() => {});
  }
  process.exitCode = results.summary(name) ? 0 : 1;
}

export {
  env,
  token,
  client,
  clients,
  db,
  cleanup,
  resetDemoState,
  runSuite,
  Results,
  ACCOUNTS,
  DEMO_PASSWORD,
  DEMO_WORKSHOP,
};

