// The architecture's central claim, tested directly.
//
// CLAUDE.md: "A new methodology must require CONFIGURATION ONLY — no new Go
// handlers, no new SQL, no new React components." This suite activates the
// deliberately-inactive PESTLE stub and drives it through every surface,
// asserting that nothing SWOT-shaped leaks in.
//
// PESTLE is shaped to break a hardcoded implementation: six factor categories
// instead of four, a six-vote budget instead of twenty, NO relate stage and
// NO recommend stage. If any of this needs code, the architecture is wrong.
//
// This suite has caught nine real leaks so far, including a hardcoded
// 'swot-tows' default, a hardcoded vote budget, a missing column assumption,
// a nil-slice crash, and PESTLE categories borrowing SWOT's colour tokens.
import { runSuite, clients, token, client, ACCOUNTS } from "../lib/harness.js";

runSuite("genericity (PESTLE)", async ({ baseUrl, results: r, c }) => {
  const { facilitator: F } = await clients(baseUrl, ["facilitator"]);
  let workshopId = null;
  let wasActive = false;

  try {
    // A previous interrupted run can leave a probe workshop behind, which then
    // skews other suites' counts. Clear any before starting.
    await c.query("alter table public.reports disable trigger reports_immutable");
    await c.query("alter table public.report_sections disable trigger report_sections_frozen");
    await c.query(`delete from public.reports where workshop_id in
                   (select id from public.workshops where name like '%genericity probe%')`);
    await c.query("alter table public.reports enable trigger reports_immutable");
    await c.query("alter table public.report_sections enable trigger report_sections_frozen");
    await c.query("delete from public.workshops where name like '%genericity probe%'");

    // Remember what it was, rather than assuming inactive. PESTLE may be live
    // deliberately — the suite must leave the picker as it found it.
    wasActive = (await c.query(
      "select is_active from public.methodologies where key = 'pestle'")).rows[0]?.is_active ?? false;
    await c.query("update public.methodologies set is_active = true where key = 'pestle'");

    r.section("PESTLE appears from configuration alone");
    const cat = await F("GET", "/methodologies");
    const pestle = cat.data.find((m) => m.key === "pestle");
    r.ok(!!pestle, "PESTLE is offered once activated — no deployment needed",
      pestle && `${pestle.category_count} categories, ${pestle.stage_count} stages`);
    r.ok(pestle?.category_count === 6, "six factor categories, not four", pestle?.category_count);

    const workspaces = await F("GET", "/workspaces");
    const created = await F("POST", "/workshops", {
      workspace_id: workspaces.data[0].id, name: "PESTLE genericity probe",
      methodology_key: "pestle", objective: "prove the engine is generic",
    });
    r.ok(created.success, "create a PESTLE workshop through the same wizard endpoint",
      created.error?.message);
    workshopId = created.data.id;

    const detail = await F("GET", `/workshops/${workshopId}`);
    const stages = detail.data.methodology.stages;
    r.ok(detail.data.votes_per_participant === 6,
      "vote budget is 6 from PESTLE config, not the 20 default",
      detail.data.votes_per_participant);
    r.ok(detail.data.methodology.relationship_types.length === 0,
      "PESTLE defines NO relationship types");
    r.ok(!stages.some((s) => s.stage_type === "relate"), "and has no relate stage");
    r.ok(stages.filter((s) => s.stage_type === "capture").length === 6,
      "six capture stages from config", stages.filter((s) => s.stage_type === "capture").length);

    r.section("capture, synthesize and interpret work unchanged");
    const f1 = await F("POST", `/workshops/${workshopId}/factors`,
      { category_key: "environmental", title: "Carbon disclosure tightens" });
    const f2 = await F("POST", `/workshops/${workshopId}/factors`,
      { category_key: "legal", title: "New reporting statute" });
    r.ok(f1.success && f2.success, "capture factors in categories SWOT has no concept of");

    const syn = await F("POST", `/workshops/${workshopId}/syntheses`, {
      title: "Regulatory pressure", description: "grouped driver",
      evidence: { factor: [f1.data.id, f2.data.id] },
    });
    r.ok(syn.success, "the same synthesize endpoint groups PESTLE factors", syn.error?.message);
    await F("POST", `/workshops/${workshopId}/syntheses/${syn.data.id}/review`, { action: "approve" });

    const ins = await F("POST", `/workshops/${workshopId}/insights`, {
      title: "Compliance cost will rise", description: "implication",
      evidence: { synthesis: [syn.data.id] },
    });
    r.ok(ins.success, "the same interpret endpoint creates a PESTLE insight", ins.error?.message);
    await F("POST", `/workshops/${workshopId}/insights/${ins.data.id}/review`, { action: "approve" });

    const rel = await F("POST", `/workshops/${workshopId}/relationships`, {
      source_id: f1.data.id, target_id: f2.data.id, relationship_type_key: "so",
    });
    r.ok(!rel.success, "relationships are refused — PESTLE has no relationship types",
      rel.error?.message);

    r.section("the board tidy-up is opt-in, per methodology");

    // "Merge and Fix" is a `changeset` prompt row seeded for SWOT-TOWS only.
    // PESTLE has capture stages and a capture board, but no such row — so it
    // must offer no button and refuse the endpoint. If this ever starts
    // passing by accident, the feature has been wired to a stage TYPE in code
    // instead of to config, and every methodology would inherit it.
    const captureStage = stages.find((s) => s.stage_type === "capture").key;
    const aiStatus = await F("GET", `/workshops/${workshopId}/ai?stage_key=${captureStage}`);
    r.ok(aiStatus.data.board_cleanup === false,
      "PESTLE offers no board tidy-up — it has no changeset prompt configured",
      aiStatus.data.board_cleanup);

    const tidy = await F("POST", `/workshops/${workshopId}/cleanup`, { stage_key: captureStage });
    r.ok(!tidy.success, "and the endpoint refuses rather than running SWOT's prompt against it",
      tidy.error?.message);

    // The three functions App Spec §13.10-13.12 places away from the stage
    // panel must be placed the same way for every methodology. If PESTLE
    // inherited them with scope defaulted to 'stage', Challenge would be back
    // on a stage button with no object to act on — the exact bug UAT found.
    const scopes = Object.fromEntries(
      (aiStatus.data.functions ?? []).map((f) => [f.function_key, f.scope]),
    );
    r.ok(scopes["challenge"] === "object" && scopes["traceability_explanation"] === "object",
      "PESTLE's Challenge and Explain Why are object-scoped too — seeding carries scope",
      `${scopes["challenge"]}/${scopes["traceability_explanation"]}`);
    r.ok(scopes["workshop_summary"] === "workshop",
      "and its workshop summary is workshop-scoped", scopes["workshop_summary"]);
    r.ok(
      !(aiStatus.data.functions ?? []).some((f) => f.function_key === "duplicate_detection"),
      "duplicate_detection is gone from PESTLE as well as SWOT",
    );

    // §4.12's prioritization review follows the STAGE, not the methodology:
    // PESTLE has a prioritize stage so it gets one, and a methodology without
    // that stage must be offered nothing.
    const prioritize = stages.find((s) => s.stage_type === "prioritize");
    const prioStatus = (await F("GET", `/workshops/${workshopId}/ai?stage_key=${prioritize.key}`)).data;
    r.ok(prioStatus.functions.some((f) => f.function_key === "prioritization_review"),
      "PESTLE's prioritize stage gets the §4.12 review from config, with no code written for it",
    );

    r.section("reporting renders PESTLE's own template");
    const types = await F("GET", `/workshops/${workshopId}/report-types`);
    r.ok(types.data.length === 1 && types.data[0].key === "driver_scan",
      "one PESTLE-specific report type", types.data.map((t) => t.key).join(","));
    r.ok(types.data[0].can_generate === true,
      "its gate asks only for a theme — no recommendation, since PESTLE has no recommend stage",
      JSON.stringify(types.data[0].missing));

    const rep = await F("POST", `/workshops/${workshopId}/reports`, { report_type: "driver_scan" });
    r.ok(rep.success, "create the PESTLE report", rep.error?.message);
    const got = await F("GET", `/workshops/${workshopId}/reports/${rep.data.id}`);
    const matrix = got.data.sections.find((s) => s.section_type === "category_matrix");
    r.ok(matrix.groups.length === 6,
      "the SAME category_matrix renderer produces SIX groups", matrix.groups.map((g) => g.key).join(","));
    r.ok(!got.data.sections.some((s) => s.section_type === "pair_matrix"),
      "NO strategy matrix — there are no relationship types to render");
    // Asserted on the SOURCE, not the renderer. It used to check that no
    // `table` section existed at all, which meant the same thing only while
    // the recommendation table was the sole use of that renderer. PESTLE now
    // has a rated scan table of its own, and the claim being made here is
    // that no RECOMMENDATION content appears — which is what this checks.
    r.ok(!got.data.sections.some((s) => s.source?.from === "recommendation"),
      "NO recommendation content — PESTLE has no recommend stage",
      got.data.sections.map((s) => `${s.section_type}:${s.source?.from ?? "-"}`).join(", "));

    const rated = got.data.sections.find((s) => s.section_key === "rated_scan");
    r.ok(rated?.weight_columns?.length === 2,
      "the rated scan declares its weight columns from config",
      rated?.weight_columns?.map((c) => c.name).join(", "));

    r.section("no SWOT vocabulary leaks anywhere");
    const blob = JSON.stringify(got.data).toLowerCase();
    r.ok(!blob.includes("swot") && !blob.includes("tows") &&
         !blob.includes("strength") && !blob.includes("weakness"),
      "the report contains no SWOT/TOWS vocabulary, including colour tokens");

    await F("POST", `/workshops/${workshopId}/reports/${rep.data.id}/review`, { action: "submit" });
    await F("POST", `/workshops/${workshopId}/reports/${rep.data.id}/review`, { action: "approve" });
    const pub = await F("POST", `/workshops/${workshopId}/reports/${rep.data.id}/publish`);
    r.ok(pub.success, "publish works identically", pub.error?.message);

    const html = await F("GET", `/workshops/${workshopId}/reports/${rep.data.id}/export.html`,
      undefined, { raw: true });
    r.ok(html.status === 200 && html.text.includes("PESTLE Overview"),
      "the HTML export names PESTLE's own sections", html.status);
    r.ok(!html.text.toLowerCase().includes("tows"), "and contains no TOWS");
  } finally {
    if (workshopId) {
      await c.query("alter table public.reports disable trigger reports_immutable");
      await c.query("alter table public.report_sections disable trigger report_sections_frozen");
      await c.query("delete from public.reports where workshop_id = $1", [workshopId]);
      await c.query("alter table public.reports enable trigger reports_immutable");
      await c.query("alter table public.report_sections enable trigger report_sections_frozen");
      await c.query("delete from public.workshops where id = $1", [workshopId]);
    }
    await c.query("update public.methodologies set is_active = $1 where key = 'pestle'", [wasActive]);
    r.note(`probe workshop deleted; PESTLE restored to is_active = ${wasActive}`);
  }
});
