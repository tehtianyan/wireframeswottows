// Where each AI function is offered, and that nothing is offered where it
// cannot work.
//
// THE BUG THIS GUARDS. UAT reported that only "Generate Artifact Suggestions"
// worked in the AI panel. Every function was in fact calling the model
// successfully; the panel offered all of them as stage buttons and could only
// render one shape. Two distinct faults:
//
//   * Challenge (§13.11) and Explain Why (§13.12) act on a SELECTED insight or
//     recommendation. As stage buttons they had no object, so their prompts
//     interpolated nothing and their answers were about the whole workshop.
//   * Summarize Workshop (§13.10) belongs on the Workshop Overview.
//   * All three return one nested OBJECT, and the panel rendered only arrays of
//     titled suggestions — so it said "The assistant had nothing to add" after a
//     paid call that had produced a complete answer.
//
// These checks are deliberately SHAPE checks, not model calls: they assert what
// the server offers, what it refuses, and that every declared output_kind can
// be rendered. That is free, deterministic, and is where the bug actually was.
import { runSuite, clients } from "../lib/harness.js";

// One section makes a real, paid model call, so it is opt-in like the ai suite.
// Everything else is a shape check against what the server offers and refuses —
// free, deterministic, and where the reported bug actually lived.
const withAI = process.argv.includes("--with-ai");

// Mirrors aiSuggestions() / aiNarrative() in src/lib/api.ts, so a shape the
// suite calls renderable is one the UI really can draw.
const arrayKeys = (c) => Object.keys(c ?? {}).filter((k) => Array.isArray(c[k])).sort();
const objectKeys = (c) =>
  Object.keys(c ?? {})
    .filter((k) => c[k] !== null && typeof c[k] === "object" && !Array.isArray(c[k]))
    .sort();

runSuite("ai-scope", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F } = await clients(baseUrl, ["facilitator"]);

  const workshop = (await F("GET", `/workshops/${WS}`)).data;
  const stages = workshop.methodology.stages;
  const captureStage = stages.find((s) => s.stage_type === "capture").key;

  // ---- every function declares where it belongs ----
  r.section("placement is configuration, not code");

  const all = new Map();
  for (const st of stages) {
    const status = (await F("GET", `/workshops/${WS}/ai?stage_key=${st.key}`)).data;
    for (const fn of status.functions) all.set(fn.function_key, fn);
  }

  r.ok(all.size > 0, "the workshop offers AI functions", all.size);
  r.ok(
    [...all.values()].every((f) => ["stage", "object", "workshop"].includes(f.scope)),
    "every function declares a scope",
    [...new Set([...all.values()].map((f) => f.scope))].sort().join(","),
  );
  r.ok(
    [...all.values()].every((f) => ["suggestions", "narrative"].includes(f.output_kind)),
    "every offered function declares a renderable output_kind",
    [...new Set([...all.values()].map((f) => f.output_kind))].sort().join(","),
  );
  r.ok(
    [...all.values()].every((f) => f.scope !== "object" || f.applies_to.length > 0),
    "an object-scoped function names the kinds it applies to — otherwise it would appear on no card at all",
  );

  // The three the spec places away from the stage panel.
  for (const [key, scope] of [
    ["challenge", "object"],
    ["traceability_explanation", "object"],
    ["workshop_summary", "workshop"],
  ]) {
    const fn = all.get(key);
    r.ok(fn?.scope === scope,
      `${key} is ${scope}-scoped, not a stage button — App Spec §13.10-13.12 fixes its trigger`,
      fn?.scope);
  }
  r.ok(all.get("challenge")?.output_kind === "narrative",
    "challenge is declared narrative — its schema was always an object, while the label said suggestions",
    all.get("challenge")?.output_kind);

  // ---- the capture stage panel now offers only what it can render ----
  r.section("the stage panel offers only stage actions");

  const capture = (await F("GET", `/workshops/${WS}/ai?stage_key=${captureStage}`)).data;
  const stageOnly = capture.functions.filter((f) => f.scope === "stage");
  r.ok(stageOnly.length >= 1, "the capture stage has at least one stage action", stageOnly.length);
  r.ok(
    !stageOnly.some((f) => ["challenge", "traceability_explanation", "workshop_summary"].includes(f.function_key)),
    "and none of the three misplaced functions is among them",
    stageOnly.map((f) => f.function_key).join(","),
  );
  r.ok(
    !capture.functions.some((f) => f.function_key === "duplicate_detection"),
    "duplicate_detection is gone — 'Merge and Fix' does §4.11's duplicate detection, merge suggestions and language normalization, with an undo",
  );

  // ---- §4.12, the gap in the journeys ----
  r.section("§4.12 Prioritization has an AI action at all");

  const prioritizeStage = stages.find((s) => s.stage_type === "prioritize");
  r.ok(Boolean(prioritizeStage), "SWOT-TOWS has a prioritize stage", prioritizeStage?.key);
  const prio = (await F("GET", `/workshops/${WS}/ai?stage_key=${prioritizeStage.key}`)).data;
  const review = prio.functions.find((f) => f.function_key === "prioritization_review");
  r.ok(Boolean(review),
    "the prioritize stage offers a review — §4.12 asks for anomalies and voting patterns, and there was no prioritize prompt at all",
    review?.name);
  r.ok(review?.scope === "stage" && review?.output_kind === "narrative",
    "it is a stage action returning a narrative — an anomaly is an observation, not an object to create",
    `${review?.scope}/${review?.output_kind}`);
  r.ok(
    !capture.functions.some((f) => f.function_key === "prioritization_review"),
    "and it is not offered on a capture stage",
  );

  // ---- object actions demand their object ----
  r.section("an object action refuses to run without an object");

  const noTarget = await F("POST", `/workshops/${WS}/ai/execute`, {
    stage_key: "",
    function_key: "challenge",
  });
  r.ok(!noTarget.success && noTarget.status === 400,
    "Challenge with no selected object is refused — this is exactly what it used to do silently",
    noTarget.error?.message);
  r.ok(/insight or recommendation/.test(noTarget.error?.message ?? ""),
    "and the message says where to run it from", noTarget.error?.message);

  const wrongKind = await F("POST", `/workshops/${WS}/ai/execute`, {
    stage_key: "",
    function_key: "challenge",
    object_kind: "factor",
    object_id: (await F("GET", `/workshops/${WS}/factors`)).data[0].id,
  });
  r.ok(!wrongKind.success,
    "and it is refused on a kind it does not apply to, from applies_to rather than a hardcoded list",
    wrongKind.error?.message);

  // A target outside the workshop must not be readable, even by a facilitator
  // of this one. buildObjectContext scopes by workshop_id for that reason.
  const foreign = await F("POST", `/workshops/${WS}/ai/execute`, {
    stage_key: "",
    function_key: "challenge",
    object_kind: "insight",
    object_id: "00000000-0000-0000-0000-000000000000",
  });
  r.ok(!foreign.success && foreign.status === 404,
    "an object outside this workshop is a 404, never a context the model gets to see",
    foreign.error?.message);

  // ---- the narrative shape the renderer depends on ----
  if (!withAI) {
    r.note("live narrative render check skipped — pass --with-ai to include it; it costs real money");
    return;
  }
  r.section("a narrative really is the one shape the renderer draws");

  const viaStage = await F("POST", `/workshops/${WS}/ai/execute`, {
    stage_key: captureStage,
    function_key: "workshop_summary",
  });
  // workshop_summary needs no target, so it runs — the point is that the UI no
  // longer OFFERS it there, and the server records the scope it ran under.
  r.ok(viaStage.success || viaStage.status === 429,
    "the workshop summary runs",
    viaStage.error?.message ?? viaStage.status);
  if (viaStage.success) {
    r.ok(objectKeys(viaStage.data.content).length === 1 && arrayKeys(viaStage.data.content).length === 0,
      "and it returns exactly the one nested object the narrative renderer draws",
      Object.keys(viaStage.data.content).join(","));

    // §12.19 has nothing to accept here, and the refusal should say so rather
    // than implying the suggestion vanished.
    const accept = await F("POST", `/workshops/${WS}/ai/outputs/${viaStage.data.output_id}/review`, {
      action: "accept",
      index: 0,
      stage_key: captureStage,
    });
    r.ok(!accept.success && /something to read/.test(accept.error?.message ?? ""),
      "accepting a narrative is refused with an honest message, not 'that suggestion no longer exists'",
      accept.error?.message);
  }
});
