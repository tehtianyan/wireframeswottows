// The Executive Dashboard (wireframe §10).
//
// Two properties matter here and neither is obvious from reading the page:
// it must show ONLY approved output (§10.6 — "executives should consume
// synthesized intelligence rather than raw workshop outputs"), and it must
// refuse to claim a trend it cannot support (§10.15 asks for a direction;
// one workshop cannot give one).
import { runSuite, clients, cleanup } from "../lib/harness.js";

runSuite("executive", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, executive: E } = await clients(baseUrl, ["facilitator", "executive"]);

  try {
    r.section("unapproved work does not reach the executive brief");
    const factors = (await F("GET", `/workshops/${WS}/factors`)).data;
    const syn = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "EXEC theme", description: "seeded",
      evidence: { factor: [factors[0].id, factors[1].id] },
    });
    const ins = await F("POST", `/workshops/${WS}/insights`, {
      title: "EXEC insight", description: "seeded", evidence: { synthesis: [syn.data.id] },
    });
    const rec = await F("POST", `/workshops/${WS}/recommendations`, {
      title: "EXEC recommendation", description: "do it",
      fields: { priority: "critical", risks: "A real risk worth surfacing" },
      evidence: { insight: [ins.data.id] },
    });

    const beforeApproval = await F("GET", "/executive");
    r.ok(!beforeApproval.data.insights.some((i) => i.title === "EXEC insight"),
      "a submitted insight is absent from the brief");
    r.ok(!beforeApproval.data.recommendations.some((i) => i.title === "EXEC recommendation"),
      "a submitted recommendation is absent too");

    r.section("approved work appears");
    for (const [route, id] of [["syntheses", syn.data.id], ["insights", ins.data.id],
                               ["recommendations", rec.data.id]]) {
      await F("POST", `/workshops/${WS}/${route}/${id}/review`, { action: "approve" });
    }

    const brief = await F("GET", "/executive");
    r.ok(brief.success, "executive brief loads", brief.error?.message);
    r.ok(brief.data.themes.some((t) => t.title === "EXEC theme"), "the approved theme appears");
    r.ok(brief.data.insights.some((i) => i.title === "EXEC insight"), "the approved insight appears");

    const topRec = brief.data.recommendations[0];
    r.ok(topRec?.title === "EXEC recommendation",
      "a critical recommendation ranks first, not alphabetically", topRec?.extra);
    r.ok(brief.data.risks.some((x) => x.body.includes("A real risk")),
      "recorded risks surface in the risk panel");

    const theme = brief.data.themes.find((t) => t.title === "EXEC theme");
    r.ok(theme?.evidence_count === 2, "themes report how much evidence supports them",
      theme?.evidence_count);

    r.section("it refuses to claim a trend it cannot support");
    r.ok(brief.data.workshops < 2 ? brief.data.trend_note !== "" : true,
      "with one workshop, the brief says there is not enough history rather than drawing one",
      brief.data.trend_note || "(real trend shown)");

    r.section("an executive viewer can read it");
    const asExec = await E("GET", "/executive");
    r.ok(asExec.success, "executive_viewer role can load the brief", asExec.error?.message);
    // Deliberately not "sees the same totals": two users can belong to
    // different workshop sets, so equal counts is not a property of a correct
    // system. What must hold is that shared content is visible to both.
    r.ok(asExec.data.themes.some((t) => t.title === "EXEC theme"),
      "and sees the approved intelligence from the workshop they share");

    // The brief is a consumption surface: it must not become a back door to
    // mutation for a role that cannot mutate anywhere else.
    const write = await E("POST", `/workshops/${WS}/syntheses`, { title: "EXEC should fail" });
    r.ok(!write.success && write.error.code === "FORBIDDEN",
      "an executive viewer still cannot create anything", write.error?.message);
  } finally {
    await cleanup(c, { titlePrefixes: ["EXEC"] });
    r.note("test rows removed");
  }
});
