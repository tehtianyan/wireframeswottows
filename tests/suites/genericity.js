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
    r.ok(!got.data.sections.some((s) => s.section_type === "table"),
      "NO recommendation table — PESTLE has no recommend stage");

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
    await c.query("update public.methodologies set is_active = false where key = 'pestle'");
    r.note("probe workshop deleted; PESTLE deactivated again");
  }
});
