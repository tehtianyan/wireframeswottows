// Phase 2 — the analysis object chain.
//
// Covers the registry-driven CRUD, the governance lifecycle shared by every
// object kind, and the two rules that are easy to regress: TOWS pairing comes
// from methodology config, and citations cannot cross a workshop boundary.
import { runSuite, clients, cleanup } from "../lib/harness.js";

runSuite("objects", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P } = await clients(baseUrl, ["facilitator", "participant"]);
  const created = { syntheses: [], relationships: [], insights: [], recommendations: [] };

  try {
    r.section("object-kinds catalogue drives the UI forms");
    const kinds = await F("GET", "/object-kinds");
    r.ok(kinds.success && kinds.data.length === 4, "four kinds registered",
      kinds.data && kinds.data.map((k) => k.key).join(", "));
    const rec = kinds.data?.find((k) => k.key === "recommendation");
    r.ok(rec?.fields?.some((f) => f.name === "priority" && f.type === "enum"),
      "recommendation declares its own fields", rec?.fields?.map((f) => f.name).join(","));
    r.ok(kinds.data?.find((k) => k.key === "factor_relationship")?.pairing?.pairs_kind === "factor",
      "relationship declares a pairing rather than a link table");

    r.section("the traceability chain, end to end");
    const factors = (await F("GET", `/workshops/${WS}/factors`)).data;
    const byCat = (k) => factors.filter((f) => f.category_key === k);
    const strength = byCat("strength")[0], opportunity = byCat("opportunity")[0];
    const weakness = byCat("weakness")[0], threat = byCat("threat")[0];

    const syn = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "VERIFY theme", description: "created by the objects suite",
      evidence: { factor: [strength.id, weakness.id] },
    });
    r.ok(syn.success, "create a theme citing two factors", syn.error?.message);
    if (syn.data) created.syntheses.push(syn.data.id);

    const listed = await F("GET", `/workshops/${WS}/syntheses`);
    const mine = listed.data?.find((s) => s.id === syn.data?.id);
    r.ok(mine?.evidence?.factor?.length === 2, "theme reports its cited factors",
      mine?.evidence?.factor?.length);

    const rel = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: strength.id, target_id: opportunity.id, relationship_type_key: "so",
      title: "VERIFY SO pairing", fields: { narrative: "n", strategic_option: "s" },
    });
    r.ok(rel.success, "create an SO relationship (strength x opportunity)", rel.error?.message);
    if (rel.data) created.relationships.push(rel.data.id);

    const ins = await F("POST", `/workshops/${WS}/insights`, {
      title: "VERIFY insight", description: "what it means",
      fields: { strategic_significance: "high" },
      evidence: { synthesis: [syn.data.id], factor_relationship: [rel.data.id] },
    });
    r.ok(ins.success, "create an insight citing a theme AND a relationship", ins.error?.message);
    if (ins.data) created.insights.push(ins.data.id);

    const recmd = await F("POST", `/workshops/${WS}/recommendations`, {
      title: "VERIFY recommendation", description: "do the thing",
      fields: { priority: "high", impact_score: 8 },
      evidence: { insight: [ins.data.id] },
    });
    r.ok(recmd.success, "create a recommendation citing the insight", recmd.error?.message);
    if (recmd.data) created.recommendations.push(recmd.data.id);

    r.section("every kind round-trips through its list endpoint");
    // A create-only test once let a broken GET /recommendations reach
    // production, so listing is checked explicitly for all four.
    for (const [route, id] of [
      ["syntheses", syn.data.id], ["relationships", rel.data.id],
      ["insights", ins.data.id], ["recommendations", recmd.data.id],
    ]) {
      const list = await F("GET", `/workshops/${WS}/${route}`);
      r.ok(list.success && list.data.some((x) => x.id === id),
        `list ${route} returns the created row`, list.success ? `n=${list.data.length}` : list.error.message);
    }
    const relRow = (await F("GET", `/workshops/${WS}/relationships`)).data.find((x) => x.id === rel.data.id);
    r.ok(relRow?.source_id === strength.id && relRow?.target_id === opportunity.id,
      "relationship round-trips its pairing");
    r.ok(relRow?.fields?.narrative === "n",
      "relationship round-trips narrative (it has no description column)");

    r.section("methodology config drives the pairing rules, not code");
    const bad = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: weakness.id, target_id: opportunity.id, relationship_type_key: "so",
    });
    r.ok(!bad.success && bad.error.code === "VALIDATION_ERROR",
      "a weakness is refused in an SO cell", bad.error?.message);

    const wo = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: weakness.id, target_id: opportunity.id, relationship_type_key: "wo",
    });
    r.ok(wo.success, "the same weakness is accepted in a WO cell", wo.error?.message);
    if (wo.data) created.relationships.push(wo.data.id);

    const wt = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: strength.id, target_id: threat.id, relationship_type_key: "wt",
    });
    r.ok(!wt.success, "a strength is refused in a WT cell", wt.error?.message);

    const self = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: strength.id, target_id: strength.id, relationship_type_key: "so",
    });
    r.ok(!self.success, "a factor cannot be paired with itself", self.error?.message);

    r.section("citation rules come from the registry");
    const illegal = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "VERIFY illegal", evidence: { insight: [ins.data.id] },
    });
    r.ok(!illegal.success, "a theme cannot cite an insight", illegal.error?.message);

    const foreign = await F("POST", `/workshops/${WS}/insights`, {
      title: "VERIFY foreign", description: "x",
      evidence: { synthesis: ["00000000-0000-4000-8000-000000000000"] },
    });
    r.ok(!foreign.success, "cannot cite evidence from outside the workshop", foreign.error?.message);

    r.section("governance applies to every kind");
    const pReview = await P("POST", `/workshops/${WS}/insights/${ins.data.id}/review`, { action: "approve" });
    r.ok(!pReview.success && pReview.error.code === "FORBIDDEN",
      "participant cannot approve an insight", pReview.error?.message);

    const noReason = await F("POST", `/workshops/${WS}/insights/${ins.data.id}/review`, { action: "reject" });
    r.ok(!noReason.success, "rejecting needs a reason", noReason.error?.message);

    const appr = await F("POST", `/workshops/${WS}/insights/${ins.data.id}/review`, { action: "approve" });
    r.ok(appr.success && appr.data.state === "approved", "facilitator approves the insight", appr.data?.state);

    const editAfter = await F("PATCH", `/workshops/${WS}/insights/${ins.data.id}`, { title: "changed" });
    r.ok(!editAfter.success && editAfter.error.code === "INVALID_STATE_TRANSITION",
      "an approved insight is frozen", editAfter.error?.message);

    const delAfter = await F("DELETE", `/workshops/${WS}/insights/${ins.data.id}`);
    r.ok(!delAfter.success, "an approved insight cannot be deleted", delAfter.error?.message);
  } finally {
    await cleanup(c, { titlePrefixes: ["VERIFY"] });
    r.note("test rows removed");
  }
});
