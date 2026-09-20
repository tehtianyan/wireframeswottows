#!/usr/bin/env node
// Seeds a DEVELOPMENT database with the fixtures every suite assumes.
//
//   node tests/seed-dev.js [envFile]        # default .env.dev
//
// The suites are integration tests against a real database, so they need real
// accounts and a real workshop to work in. They create and clean up their own
// objects, but they all assume:
//   * the seven demo accounts exist and can sign in
//   * every one of them is in BOTH workspace_members and workshop_members,
//     because authz.RequireWorkshopRole enforces the first two levels of App
//     Spec 11.5 and a missing workspace membership reads as 403
//   * the demo workshop exists at the id the harness hardcodes
//   * it already holds approved factors in all four SWOT categories
//
// Idempotent: safe to re-run. It adds what is missing and leaves the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = process.argv[2] ?? ".env.dev";

// The live project. This script creates users and data, so running it against
// production would be a genuine incident rather than a mistake to tidy up.
const PRODUCTION_REF = "azbqapefetexjqefcdep";

const DEMO_PASSWORD = "SwotDemo2026!";
const DEMO_WORKSHOP = "52efe15a-9f32-4a03-86c9-51bc5c929314"; // hardcoded in tests/lib/harness.js

const PEOPLE = [
  { email: "jane.smith@example.com",      first: "Jane",   last: "Smith",     workshop: "facilitator",      workspace: "owner" },
  { email: "sarah.chen@example.com",      first: "Sarah",  last: "Chen",      workshop: "analyst",          workspace: "analyst" },
  { email: "alex.meyer@example.com",      first: "Alex",   last: "Meyer",     workshop: "analyst",          workspace: "analyst" },
  { email: "dana.whitfield@example.com",  first: "Dana",   last: "Whitfield", workshop: "participant",      workspace: "member" },
  { email: "john.okafor@example.com",     first: "John",   last: "Okafor",    workshop: "participant",      workspace: "member" },
  { email: "ingrid.holm@example.com",     first: "Ingrid", last: "Holm",      workshop: "executive_viewer", workspace: "viewer" },
  { email: "ravi.menon@example.com",      first: "Ravi",   last: "Menon",     workshop: "executive_viewer", workspace: "viewer" },
];

// Three per category so a suite can pick one without exhausting the set, and
// so prioritization has something to rank.
const FACTORS = {
  strength: [
    ["Established enterprise client base", "Roughly 400 accounts with multi-year contracts."],
    ["Strong engineering retention", "Attrition well below the sector average."],
    ["Proprietary data on claims patterns", "Fifteen years of labelled outcomes."],
  ],
  weakness: [
    ["Manual onboarding process", "Six weeks from signature to first value."],
    ["Fragmented reporting stack", "Four tools produce four different revenue numbers."],
    ["Thin bench in data engineering", "Two people carry most of the pipeline knowledge."],
  ],
  opportunity: [
    ["Regulatory push toward transparency", "New disclosure rules favour instrumented vendors."],
    ["Mid-market segment underserved", "Competitors price for enterprise only."],
    ["Partner channel in Southeast Asia", "Two integrators have asked to resell."],
  ],
  threat: [
    ["Incumbent bundling the same capability", "Offered at no additional cost inside a larger suite."],
    ["Rising cost of compliance", "Audit burden grows with every jurisdiction."],
    ["Key supplier concentration", "One vendor underpins the document pipeline."],
  ],
};

function readEnv(file) {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) {
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = readEnv(ENV_FILE);
for (const key of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!env[key]) {
    console.error(`${ENV_FILE} is missing ${key}.`);
    process.exit(1);
  }
}

if (env.DATABASE_URL.includes(PRODUCTION_REF) || env.SUPABASE_URL.includes(PRODUCTION_REF)) {
  console.error(
    `Refusing to run: ${ENV_FILE} points at the production project (${PRODUCTION_REF}).\n` +
    `This script creates accounts and workshop data. Point it at a development project.`,
  );
  process.exit(1);
}

console.log(`Seeding ${env.SUPABASE_URL}`);
console.log("");

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const c = new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

try {
  // ---- accounts -------------------------------------------------------
  // createUser is the only path that sets a usable password; the profiles row
  // arrives via the on_auth_user_created trigger.
  const existing = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listing users: ${error.message}`);
    for (const u of data.users) existing.set(u.email, u.id);
    if (data.users.length < 200) break;
  }

  const ids = {};
  for (const p of PEOPLE) {
    if (existing.has(p.email)) {
      ids[p.email] = existing.get(p.email);
      console.log(`  have  ${p.email}`);
      continue;
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: p.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { first_name: p.first, last_name: p.last },
    });
    if (error) throw new Error(`creating ${p.email}: ${error.message}`);
    ids[p.email] = data.user.id;
    console.log(`  made  ${p.email}`);
  }

  // The trigger may not copy names out of user_metadata, and the admin screens
  // list people by display name, so set them explicitly.
  for (const p of PEOPLE) {
    await c.query(
      `insert into public.profiles (id, email, first_name, last_name, display_name, global_role, status)
       values ($1, $2, $3, $4, $5, 'user', 'active')
       on conflict (id) do update set
         email = excluded.email, first_name = excluded.first_name,
         last_name = excluded.last_name, display_name = excluded.display_name`,
      [ids[p.email], p.email, p.first, p.last, `${p.first} ${p.last}`],
    );
  }
  console.log(`  ${PEOPLE.length} profiles in place`);

  // ---- organization, workspace, memberships ---------------------------
  const org = (await c.query(
    `insert into public.organizations (name, description, industry, status)
     select 'Northwind Group', 'Demo organization for development', 'Professional services', 'active'
     where not exists (select 1 from public.organizations where name = 'Northwind Group')
     returning id`,
  )).rows[0]?.id
    ?? (await c.query(`select id from public.organizations where name = 'Northwind Group'`)).rows[0].id;

  const ws = (await c.query(
    `insert into public.workspaces (organization_id, name, description, owner_id, status)
     select $1, 'Strategy Office', 'Demo workspace for development', $2, 'active'
     where not exists (select 1 from public.workspaces where name = 'Strategy Office')
     returning id`,
    [org, ids["jane.smith@example.com"]],
  )).rows[0]?.id
    ?? (await c.query(`select id from public.workspaces where name = 'Strategy Office'`)).rows[0].id;

  for (const p of PEOPLE) {
    await c.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       select $1, $2, $3
       where not exists (
         select 1 from public.workspace_members where workspace_id = $1 and user_id = $2)`,
      [ws, ids[p.email], p.workspace],
    );
  }
  console.log(`  workspace Strategy Office with ${PEOPLE.length} members`);

  // ---- the demo workshop ----------------------------------------------
  const methodologyId = (await c.query(
    `select id from public.methodologies where key = 'swot-tows'`,
  )).rows[0]?.id;
  if (!methodologyId) throw new Error("swot-tows methodology missing — run the migrations first");

  await c.query(
    `insert into public.workshops
       (id, workspace_id, name, description, objective, facilitator_id, status, created_by, methodology_id)
     values ($1, $2, 'Digital Transformation Strategy Workshop',
             'The demo workshop the test suites and the UAT script both work in.',
             'Decide where to invest over the next four quarters.',
             $3, 'active', $3, $4)
     on conflict (id) do update set
       workspace_id = excluded.workspace_id, methodology_id = excluded.methodology_id,
       status = 'active'`,
    [DEMO_WORKSHOP, ws, ids["jane.smith@example.com"], methodologyId],
  );

  for (const p of PEOPLE) {
    await c.query(
      `insert into public.workshop_members (workshop_id, user_id, role, joined_at)
       select $1, $2, $3, now()
       where not exists (
         select 1 from public.workshop_members where workshop_id = $1 and user_id = $2)`,
      [DEMO_WORKSHOP, ids[p.email], p.workshop],
    );
  }
  console.log(`  workshop ${DEMO_WORKSHOP} with ${PEOPLE.length} members`);

  // ---- one activity per stage -----------------------------------------
  // activities.stage_id is NOT NULL, so activities are derived from the
  // methodology's own stage list rather than written out here.
  await c.query(
    `insert into public.activities (workshop_id, title, description, sequence_number, status, stage_id)
     select $1, s.name, s.name, s.sequence_number, 'pending', s.id
     from public.methodology_stages s
     where s.methodology_id = $2
       and not exists (
         select 1 from public.activities a where a.workshop_id = $1 and a.stage_id = s.id)`,
    [DEMO_WORKSHOP, methodologyId],
  );
  const activityCount = (await c.query(
    `select count(*)::int n from public.activities where workshop_id = $1`, [DEMO_WORKSHOP],
  )).rows[0].n;
  console.log(`  ${activityCount} activities`);

  // ---- approved factors in every category ------------------------------
  // Approved rather than submitted, because the analysis suites build themes
  // and relationships on them and the API refuses rejected or missing
  // evidence. The review attribution CHECK means an approval must name a
  // reviewer, so these are attributed to the facilitator.
  const reviewer = ids["jane.smith@example.com"];
  const authors = [ids["dana.whitfield@example.com"], ids["john.okafor@example.com"], reviewer];

  for (const [categoryKey, rows] of Object.entries(FACTORS)) {
    const catId = (await c.query(
      `select id from public.methodology_factor_categories
       where methodology_id = $1 and key = $2`, [methodologyId, categoryKey],
    )).rows[0]?.id;
    if (!catId) throw new Error(`category ${categoryKey} missing from swot-tows config`);

    for (let i = 0; i < rows.length; i++) {
      const [title, description] = rows[i];
      await c.query(
        `insert into public.factors
           (workshop_id, title, description, factor_category_id, created_by,
            state, reviewed_by, reviewed_at)
         select $1, $2, $3, $4, $5, 'approved', $6, now()
         where not exists (
           select 1 from public.factors where workshop_id = $1 and title = $2)`,
        [DEMO_WORKSHOP, title, description, catId, authors[i % authors.length], reviewer],
      );
    }
  }

  const byCat = await c.query(
    `select fc.key, count(*)::int n
     from public.factors f
     join public.methodology_factor_categories fc on fc.id = f.factor_category_id
     where f.workshop_id = $1
     group by fc.key order by fc.key`, [DEMO_WORKSHOP],
  );
  console.log(`  factors: ${byCat.rows.map((r) => `${r.key} ${r.n}`).join(", ")}`);

  console.log("");
  console.log("Seeded. Sign in with any of the accounts above, password " + DEMO_PASSWORD);
} catch (err) {
  console.error(`\nSEED FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
