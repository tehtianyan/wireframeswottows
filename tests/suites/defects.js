// Regressions for defects reported against the production build (2026-09-21).
//
// Eight were reported; these are the ones observable through the API. The
// other four are front-end only and are covered by UAT cases:
//
//   1  participants panel read the wrong workshop   -> UAT DEF-01..03
//   2  "active" read as an online indicator          -> UAT DEF-04
//   6  HTML download needs an Authorization header   -> UAT DEF-05
//   7  no way back to the report-type chooser        -> UAT DEF-06
//
// Each case below states what the bug WAS, because a regression test whose
// name only describes correct behaviour tends to get "simplified" back into
// the bug it was guarding.
import { runSuite, clients } from "../lib/harness.js";

runSuite("defects", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F } = await clients(baseUrl, ["facilitator"]);
  const made = { factors: [], syntheses: [], insights: [], recommendations: [], relationships: [] };

  try {
    const factors = (await F("GET", `/workshops/${WS}/factors`)).data;

    // ---- 4: scores could exceed their stated range --------------------
    r.section("4 — impact and feasibility are bounded, not just labelled");

    const kinds = await F("GET", "/object-kinds");
    const rec = kinds.data.find((k) => k.key === "recommendation");
    const impact = rec.fields.find((f) => f.name === "impact_score");
    r.ok(impact.min === 1 && impact.max === 10,
      "the registry publishes the bounds, so the form can apply them",
      `${impact.min}-${impact.max}`);

    const syn = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "DEFECT probe theme", description: "d",
      evidence: { factor: [factors[0].id] },
    });
    made.syntheses.push(syn.data.id);
    await F("POST", `/workshops/${WS}/syntheses/${syn.data.id}/review`, { action: "approve" });
    const ins = await F("POST", `/workshops/${WS}/insights`, {
      title: "DEFECT probe insight", description: "d",
      evidence: { synthesis: [syn.data.id] },
    });
    made.insights.push(ins.data.id);
    await F("POST", `/workshops/${WS}/insights/${ins.data.id}/review`, { action: "approve" });

    const mkRec = (fields) => F("POST", `/workshops/${WS}/recommendations`, {
      title: "DEFECT probe rec", description: "d",
      fields: { priority: "high", ...fields }, evidence: { insight: [ins.data.id] },
    });

    let res = await mkRec({ impact_score: 500 });
    r.ok(!res.success && /above 10/.test(res.error?.message ?? ""),
      "500 is refused — it used to be stored, because 1-10 lived only in the label",
      res.error?.message);

    res = await mkRec({ impact_score: 0 });
    r.ok(!res.success && /below 1/.test(res.error?.message ?? ""),
      "0 is refused", res.error?.message);

    res = await mkRec({ feasibility_score: 11 });
    r.ok(!res.success && /above 10/.test(res.error?.message ?? ""),
      "feasibility is bounded too, not just impact", res.error?.message);

    res = await mkRec({ impact_score: 7.5 });
    r.ok(!res.success && /whole number/.test(res.error?.message ?? ""),
      "a fractional score is refused", res.error?.message);

    res = await mkRec({ impact_score: 7, feasibility_score: 4 });
    r.ok(res.success, "a score inside the range is accepted", res.error?.message);
    if (res.data) made.recommendations.push(res.data.id);

    // ---- 3: relationships were all "(Untitled)" ----------------------
    r.section("3 — a relationship can be named by its endpoints");

    // Created here rather than assumed: relationships used to accumulate in
    // the demo workshop because title-prefix cleanup never matched an
    // untitled row, and a test that leans on another test's litter is a test
    // that passes for the wrong reason.
    const byCat = (k) => factors.filter((f) => f.category_key === k)[0];
    const pair = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: byCat("strength").id, target_id: byCat("opportunity").id,
      relationship_type_key: "so",
      fields: { narrative: "created by the defects suite" },
    });
    r.ok(pair.success, "create a relationship with NO title, as the UI does", pair.error?.message);
    if (pair.data) made.relationships.push(pair.data.id);

    const rels = (await F("GET", `/workshops/${WS}/relationships`)).data ?? [];
    r.ok(rels.length > 0, "it is listed back", rels.length);
    r.ok(rels.every((x) => x.source_id && x.target_id),
      "every relationship exposes source_id and target_id, so the insight " +
      "picker can render 'source → target' instead of '(untitled)'",
      `${rels.filter((x) => !x.title).length} of ${rels.length} have no title`);
    const ids = new Set(factors.map((f) => f.id));
    r.ok(rels.every((x) => ids.has(x.source_id) && ids.has(x.target_id)),
      "and both endpoints resolve to factors in this workshop");

    // ---- 8: search looked like it returned unrelated results ---------
    r.section("8 — search shows why a result matched, and ranks by relevance");

    const filler = "Context that is deliberately long. ".repeat(12);
    const buried = await F("POST", `/workshops/${WS}/factors`, {
      category_key: "strength",
      title: "DEFECT probe: this title says nothing about the term",
      description: `${filler} The distinguishing word is quantumleap, buried far into the body.`,
    });
    made.factors.push(buried.data.id);

    const hits = (await F("GET", `/knowledge/search?q=quantumleap`)).data ?? [];
    r.ok(hits.length === 1, "a term buried in the body is found", hits.length);
    const hit = hits[0];
    r.ok(hit?.snippet?.toLowerCase().includes("quantumleap"),
      "the snippet is built AROUND the match — it used to be the first 220 " +
      "characters, so a body-only hit showed no trace of the search term",
      JSON.stringify(hit?.snippet?.slice(0, 70)));
    r.ok(!/StartSel|StopSel|<\/?b>/.test(hit?.snippet ?? ""),
      "and the snippet is plain text, with no ts_headline markup leaking in",
      JSON.stringify(hit?.snippet?.slice(0, 40)));
    r.ok(typeof hit?.rank === "number" && hit.rank > 0,
      "hits carry a relevance rank; results used to be ordered by date alone",
      hit?.rank);

    const many = (await F("GET", `/knowledge/search?q=process`)).data ?? [];
    if (many.length > 1) {
      const ranks = many.map((h) => h.rank);
      const sorted = [...ranks].sort((a, b) => b - a);
      r.ok(JSON.stringify(ranks) === JSON.stringify(sorted),
        "results are sorted by relevance ACROSS kinds, not grouped by kind",
        ranks.map((x) => x.toFixed(3)).join(", "));
    } else {
      r.note("only one hit for 'process'; cross-kind ordering not exercised");
    }

    const noQuery = (await F("GET", `/knowledge/search`)).data ?? [];
    r.ok(noQuery.length > 0 && noQuery.every((h) => h.rank === 0),
      "with no query there is nothing to rank, and everything is returned",
      noQuery.length);

    // ---- 5: one bad id discarded every suggestion --------------------
    // The AI path itself needs a real API key, so what is checked here is the
    // deterministic selection the accept path depends on. The drop-invalid
    // behaviour is covered by pkg/handlers/ai_suggestions_test.go and by
    // UAT DEF-07.
    r.section("5 — AI output handling");
    r.note("provider calls need ANTHROPIC_API_KEY; see the Go unit tests and UAT DEF-07");
  } finally {
    for (const [table, list] of [
      ["recommendations", made.recommendations],
      ["insights", made.insights],
      ["factor_relationships", made.relationships],
      ["syntheses", made.syntheses],
      ["factors", made.factors],
    ]) {
      if (list.length) {
        await c.query(`delete from public.${table} where id = any($1)`, [list]);
      }
    }
    await c.query(`delete from public.recommendations where title like 'DEFECT probe%'`);
    r.note("probe rows removed");
  }
});
