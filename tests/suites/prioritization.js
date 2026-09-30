// The aggregated prioritization: the group's ranking, and its appearance in
// the report.
//
// WHAT THIS GUARDS. UAT: "Every participant and facilitator could add votes to
// the prioritization. However there is no leaderboard that shows the aggregated
// votes from all the contributors. The prioritization is also missing in the
// executive report."
//
// The totals were being computed correctly all along — they were just never
// added up across categories on screen, and the report's factor section is a
// category_matrix, which renders titles only. So the numbers existed and
// nothing showed them.
//
// Two things are asserted that a naive version would miss:
//   * the TOTAL and the CONTRIBUTOR COUNT are both reported, because a total
//     alone reads as agreement even when one person produced it;
//   * `participation.contributors` counts DISTINCT PEOPLE, not rows — someone
//     voting on four factors is one contributor, and getting that wrong would
//     inflate every denominator on the leaderboard.
import { runSuite, clients, cleanup } from "../lib/harness.js";

const PREFIX = "PRIO probe";

runSuite("prioritization", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P, analyst: A } = await clients(baseUrl, [
    "facilitator",
    "participant",
    "analyst",
  ]);
  const made = [];
  let priorWeights = [];

  try {
    // The suites share a database, so the workshop may already carry weights.
    // Snapshot and restore rather than leaving it emptied.
    priorWeights = (
      await c.query(
        `select weight_key, object_kind, object_id, user_id, value
         from public.weights where workshop_id = $1`,
        [WS],
      )
    ).rows;
    await c.query("delete from public.weights where workshop_id = $1", [WS]);

    const mk = async (category, title) => {
      const res = await F("POST", `/workshops/${WS}/factors`, {
        category_key: category,
        title: `${PREFIX} ${title}`,
      });
      if (!res.success) throw new Error(res.error?.message);
      made.push(res.data.id);
      await F("POST", `/workshops/${WS}/factors/${res.data.id}/review`, { action: "approve" });
      return res.data.id;
    };

    // The shape that matters: one factor backed WIDELY, one backed HARD by a
    // single person to a similar total, and one ignored.
    const broad = await mk("strength", "backed by three people");
    const narrow = await mk("strength", "backed by one person only");
    const ignored = await mk("weakness", "nobody allocated to this");

    for (const [who, id, v] of [
      [F, broad, 4],
      [P, broad, 3],
      [A, broad, 3],
      [P, narrow, 9],
    ]) {
      const res = await who("PUT", `/workshops/${WS}/factors/${id}/vote`, { value: v });
      if (!res.success) throw new Error(`vote failed: ${res.error?.message}`);
    }

    // ---- the aggregate the leaderboard reads ----
    r.section("the group's totals are available, with who is behind them");

    const weights = (await F("GET", `/workshops/${WS}/weights`)).data;
    const vote = weights.definitions.find((d) => d.applies_to === "factor");
    r.ok(Boolean(vote), "the methodology defines a factor weight", vote?.key);

    const agg = Object.fromEntries(
      weights.totals.filter((t) => t.weight_key === vote.key).map((t) => [t.object_id, t]),
    );

    r.ok(agg[broad]?.value === 10, "the widely-backed factor totals 10", agg[broad]?.value);
    r.ok(agg[broad]?.voters === 3, "and reports THREE contributors", agg[broad]?.voters);
    r.ok(agg[narrow]?.value === 9, "the narrowly-backed factor totals 9", agg[narrow]?.value);
    r.ok(agg[narrow]?.voters === 1,
      "and reports ONE — the whole point: 9 from one person is not 10 from three, and a total alone cannot say so",
      agg[narrow]?.voters);
    r.ok(agg[ignored] === undefined, "the ignored factor has no aggregate at all");

    // ---- participation: the denominator ----
    r.section("participation counts people, not rows");

    const part = weights.participation?.[vote.key];
    r.ok(Boolean(part), "the endpoint reports group participation for the weight", JSON.stringify(part));
    r.ok(part.contributors === 3,
      "three DISTINCT people have allocated — the participant voted on two factors and must still count once",
      part.contributors);
    r.ok(part.allocated === 19, "and 19 has been allocated in total", part.allocated);

    // A weight nobody has touched must still be reported, so a leaderboard
    // shows "0 people have allocated" rather than rendering nothing.
    r.ok(
      weights.definitions
        .filter((d) => d.applies_to === "factor")
        .every((d) => weights.participation?.[d.key] !== undefined),
      "every factor weight has a participation entry, even an untouched one",
    );

    // ---- the ranking a leaderboard would draw ----
    r.section("ranking across categories, not only within one");

    const ranked = weights.totals
      .filter((t) => t.weight_key === vote.key)
      .sort((a, b) => b.value - a.value || b.voters - a.voters);
    r.ok(ranked[0].object_id === broad,
      "the top of the cross-category ranking is the widely-backed factor",
      ranked[0].value);
    // The two probe factors sit in DIFFERENT categories from each other and
    // from the ignored one, so a per-column ranking could never produce this.
    const cats = (await F("GET", `/workshops/${WS}/factors`)).data;
    const catOf = Object.fromEntries(cats.map((f) => [f.id, f.category_key]));
    r.ok(catOf[broad] !== catOf[ignored],
      "the ranked factors span more than one category, which is what the column view cannot show",
      `${catOf[broad]} vs ${catOf[ignored]}`);

    // ---- the report ----
    r.section("the prioritization reaches the report");

    const types = (await F("GET", `/workshops/${WS}/report-types`)).data;
    const exec = types.find((t) => t.key === "executive") ?? types[0];

    const created = await F("POST", `/workshops/${WS}/reports`, {
      report_type: exec.key,
      title: `${PREFIX} report`,
    });
    if (!r.ok(created.success, "create the report", created.error?.message)) return;
    const report = (await F("GET", `/workshops/${WS}/reports/${created.data.id}`)).data;

    const section = (report.sections ?? []).find((s) => s.section_key === "prioritized_factors");
    r.ok(Boolean(section),
      "the executive report carries a Prioritized Factors section — configuration, not a new renderer",
      section?.section_type);
    r.ok(section?.section_type === "table",
      "rendered as a table, so the figures are on the page rather than implied by the ordering alone",
      section?.section_type);
    r.ok((section.weight_columns ?? []).length === 1,
      "it declares one weight column, from config",
      (section.weight_columns ?? []).map((col) => col.name).join(","));
    r.ok((section.weight_columns ?? [])[0]?.key === vote.key,
      "and the column is the methodology's OWN weight, never a hardcoded 'votes'",
      (section.weight_columns ?? [])[0]?.key);

    // It must be positioned before the grouped factor overview it explains.
    const keys = (report.sections ?? []).map((s) => s.section_key);
    r.ok(keys.indexOf("prioritized_factors") < keys.indexOf("factor_matrix"),
      "and sits before the factor overview, so the ranking is read first",
      keys.join(" > "));

    const items = section.items ?? [];
    r.ok(items.length > 0, "and carries rows", items.length);
    r.ok(items[0].id === broad,
      "ordered with the group's top factor first — the report now SAYS what was prioritized",
      items[0].title);

    const cell = items[0].weights?.[vote.key];
    r.ok(cell?.value === 10, "the row carries the aggregated figure", cell?.value);
    r.ok(cell?.voters === 3,
      "and how many people are behind it — a report that prints only a total invites one enthusiast to be read as the group",
      cell?.voters);

    const narrowRow = items.find((i) => i.id === narrow);
    r.ok(narrowRow?.weights?.[vote.key]?.voters === 1,
      "the narrowly-backed factor is distinguishable in the report too",
      narrowRow?.weights?.[vote.key]?.voters);

    // The HTML export renders from the same section data, so the figure must
    // survive into the file people actually send.
    const html = await F("GET", `/workshops/${WS}/reports/${created.data.id}/export.html`, undefined, { raw: true });
    r.ok(html.status === 200, "the standalone HTML export renders", html.status);
    r.ok(/Prioritized Factors/.test(html.text), "and contains the prioritization section");
    r.ok(/3 contributors/.test(html.text),
      "including the contributor count, not just the total",
      /3 contributors/.test(html.text) ? "found" : "MISSING");
  } finally {
    await c.query("alter table public.reports disable trigger reports_immutable");
    await c.query("alter table public.report_sections disable trigger report_sections_frozen");
    await c.query("delete from public.reports where title like $1", [`${PREFIX}%`]);
    await c.query("alter table public.reports enable trigger reports_immutable");
    await c.query("alter table public.report_sections enable trigger report_sections_frozen");

    await c.query("delete from public.weights where workshop_id = $1", [WS]);
    for (const w of priorWeights) {
      await c.query(
        `insert into public.weights (workshop_id, weight_key, object_kind, object_id, user_id, value)
         values ($1, $2, $3, $4, $5, $6)`,
        [WS, w.weight_key, w.object_kind, w.object_id, w.user_id, w.value],
      );
    }
    await cleanup(c, { titlePrefixes: [PREFIX], ids: { factors: made } });
  }
});
