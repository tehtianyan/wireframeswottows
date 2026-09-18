#!/usr/bin/env node
// Runs every suite in sequence against one target.
//
//   node tests/run-all.js                              # local dev server
//   node tests/run-all.js https://your-deployment      # a deployment
//   node tests/run-all.js http://localhost:3000 --with-ai
//
// The AI suite is opt-in because every run makes real, paid Anthropic calls.
//
// Suites share one database and clean up after themselves, so they run in
// sequence rather than in parallel — running two at once means one suite's
// cleanup deletes the other's fixtures.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseUrl = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3000";
const withAI = process.argv.includes("--with-ai");

const suites = [
  ["objects", "Phase 2 — analysis objects and governance"],
  ["reporting", "Phase 4 — reports, versioning, export"],
  ["knowledge", "Phase 5 — knowledge, notifications, admin"],
  ["executive", "Phase 5 — executive dashboard"],
  ["scoping", "Security — workspace scoping"],
  ["genericity", "Architecture — PESTLE needs no code"],
];
if (withAI) suites.push(["ai", "Phase 3 — AI assistant (real API calls)"]);

console.log(`Running ${suites.length} suites against ${baseUrl}`);
if (!withAI) console.log("(AI suite skipped — pass --with-ai to include it; it costs real money)");
console.log("");

const failed = [];
for (const [name, description] of suites) {
  console.log("─".repeat(70));
  console.log(`${description}`);
  const res = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "suites", `${name}.js`), baseUrl], {
    stdio: "inherit",
  });
  if (res.status !== 0) failed.push(name);
  console.log("");
}

console.log("═".repeat(70));
if (failed.length === 0) {
  console.log(`All ${suites.length} suites passed.`);
} else {
  console.log(`FAILED: ${failed.join(", ")}`);
}
process.exit(failed.length === 0 ? 0 : 1);
