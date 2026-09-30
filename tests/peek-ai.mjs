// Ad-hoc: runs EVERY AI function the workshop offers, on the surface it is
// configured for, and reports whether the UI could actually render the result.
// Makes real paid calls; not part of run-all.js.
//
//   SWOT_ENV_FILE=.env.dev node tests/peek-ai.mjs http://localhost:3001
//
// This exists because UAT reported "only Generate Artifact Suggestions works".
// The server was fine for all of them; three were on the wrong surface and four
// returned a shape the panel could not draw. A probe that reports what the UI
// would show — not just whether the call returned 200 — is what catches that.
import { clients, DEMO_WORKSHOP as WS } from "./lib/harness.js";

const baseUrl = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3001";
const { facilitator: F } = await clients(baseUrl, ["facilitator"]);

const workshop = (await F("GET", `/workshops/${WS}`)).data;
const stages = workshop.methodology.stages;

// Mirrors aiSuggestions() / aiNarrative() in src/lib/api.ts.
const arrays = (c) => Object.keys(c ?? {}).filter((k) => Array.isArray(c[k])).sort();
const objects_ = (c) =>
  Object.keys(c ?? {})
    .filter((k) => c[k] !== null && typeof c[k] === "object" && !Array.isArray(c[k]))
    .sort();

function verdict(fn, content) {
  if (fn.output_kind === "narrative") {
    const k = objects_(content)[0];
    if (!k) return "BROKEN — declared narrative but returned no object";
    const filled = Object.values(content[k]).filter((v) =>
      Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "",
    ).length;
    return `renders ${Object.keys(content[k]).length} section(s), ${filled} with content`;
  }
  const k = arrays(content)[0];
  if (!k) return "BROKEN — declared suggestions but returned no array";
  const items = content[k];
  const titled = items.filter((x) => typeof x?.title === "string" && x.title).length;
  if (items.length > 0 && titled === 0) return `BROKEN — ${items.length} row(s), none with a title`;
  return `renders ${items.length} row(s), ${titled} titled`;
}

async function run(fn, body, where) {
  const res = await F("POST", `/workshops/${WS}/ai/execute`, body, { timeoutMs: 120000 });
  if (!res.success) {
    console.log(`  ${fn.function_key.padEnd(28)} SERVER FAILED — ${res.error?.message}`);
    return;
  }
  console.log(`  ${fn.function_key.padEnd(28)} ${where.padEnd(22)} ${verdict(fn, res.data.content)}`);
}

// ---- stage-scoped, on every stage that offers one ----
console.log("STAGE ACTIONS");
const seen = new Set();
for (const st of stages) {
  const status = (await F("GET", `/workshops/${WS}/ai?stage_key=${st.key}`)).data;
  for (const fn of status.functions.filter((f) => f.scope === "stage")) {
    if (seen.has(fn.function_key)) continue;
    seen.add(fn.function_key);
    await run(fn, { stage_key: st.key, function_key: fn.function_key }, st.stage_type);
  }
}

// ---- object-scoped, on a real insight and recommendation ----
console.log("\nOBJECT ACTIONS (App Spec §13.11, §13.12)");
const anyStatus = (await F("GET", `/workshops/${WS}/ai`)).data;
const objectFns = anyStatus.functions.filter((f) => f.scope === "object");
for (const kindRoute of ["insights", "recommendations"]) {
  const kindKey = kindRoute === "insights" ? "insight" : "recommendation";
  const list = (await F("GET", `/workshops/${WS}/${kindRoute}`)).data ?? [];
  const target = list[0];
  if (!target) {
    console.log(`  (no ${kindKey} in the workshop to act on)`);
    continue;
  }
  for (const fn of objectFns.filter((f) => f.applies_to.includes(kindKey))) {
    await run(
      fn,
      { stage_key: "", function_key: fn.function_key, object_kind: kindKey, object_id: target.id },
      kindKey,
    );
  }
}

// An object action with no target must be refused, not answered vaguely.
if (objectFns.length > 0) {
  const res = await F("POST", `/workshops/${WS}/ai/execute`, {
    stage_key: "",
    function_key: objectFns[0].function_key,
  });
  console.log(`  no-target guard: ${res.success ? "NOT REFUSED (bug)" : res.error?.message}`);
}

// ---- workshop-scoped ----
console.log("\nWORKSHOP ACTIONS (App Spec §13.10)");
for (const fn of anyStatus.functions.filter((f) => f.scope === "workshop")) {
  await run(fn, { stage_key: "", function_key: fn.function_key }, "overview");
}
