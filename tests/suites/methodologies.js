// The methodology-agnostic claim, tested against seven real methodologies.
//
// CLAUDE.md: "A new methodology must require CONFIGURATION ONLY — no new Go
// handlers, no new SQL, no new React components." PESTLE has proved that for
// one deliberately easy case. These seven are not easy:
//
//   methodology       categories  weights  relate types  notes
//   PESTLE                     6        3             0  no recommend stage
//   Five Forces                5        1             0  NO prioritize stage;
//                                                        its weight is on a
//                                                        synthesis, not a factor
//   Capability                 6        2             0  two weights, one object
//   Operating Model            6        1             0  needs nothing new
//   Risk (ISO 31000)           6        4             0  inherent AND residual
//   Business Model Canvas      9        0             2  no weights; nine
//                                                        categories; fit tests
//   Transformation             6        3             1  any-to-any dependency;
//                                                        report grouped BY a weight
//
// Each is driven through its own declared chain and then checked for the one
// thing that matters most: that no OTHER methodology's vocabulary appears
// anywhere in its responses. A leak there means a methodology is baked into
// the engine, and is Critical.
//
// Every methodology is activated, driven and deactivated again in `finally`.
import { runSuite, clients } from "../lib/harness.js";

// Words unique to exactly one methodology's configuration. Deliberately narrow:
// "technology" and "operations" appear in several, so they prove nothing.
const MARKERS = {
  "swot-tows": ["swot", "tows"],
  "pestle": ["pestle"],
  "five-forces": ["rivalry", "bargaining"],
  "capability": ["maturity"],
  "operating-model": ["polism", "pain severity"],
  "risk-iso31000": ["residual", "catastrophic"],
  "business-model": ["canvas"],
  "transformation": ["wave"],
};

const PLAN = [
  { key: "pestle", cats: 6, weights: 3, rels: 0, prioritize: true, recommend: false },
  { key: "five-forces", cats: 5, weights: 1, rels: 0, prioritize: false, recommend: true },
  { key: "capability", cats: 6, weights: 2, rels: 0, prioritize: true, recommend: true },
  { key: "operating-model", cats: 6, weights: 1, rels: 0, prioritize: true, recommend: true },
  { key: "risk-iso31000", cats: 6, weights: 4, rels: 0, prioritize: true, recommend: true },
  { key: "business-model", cats: 9, weights: 0, rels: 2, prioritize: false, recommend: true },
  { key: "transformation", cats: 6, weights: 3, rels: 1, prioritize: true, recommend: true },
];

const PROBE_NAME = "methodology probe";

runSuite("methodologies", async ({ baseUrl, results: r, c }) => {
  const { facilitator: F } = await clients(baseUrl, ["facilitator"]);
  const workspaces = await F("GET", "/workspaces");
  const workspaceId = workspaces.data[0].id;
  const created = [];

  try {
    await clearProbes(c);

    for (const spec of PLAN) {
      await c.query("update public.methodologies set is_active = true where key = $1", [spec.key]);
      try {
        const id = await driveOne(F, c, r, workspaceId, spec);
        if (id) created.push(id);
      } finally {
        await c.query("update public.methodologies set is_active = false where key = $1", [spec.key]);
      }
    }
  } finally {
    await clearProbes(c);
    await c.query(
      `update public.methodologies set is_active = false where key <> 'swot-tows'`,
    );
    r.note("probe workshops removed; every methodology deactivated again");
  }
});

async function clearProbes(c) {
  await c.query("alter table public.reports disable trigger reports_immutable");
  await c.query("alter table public.report_sections disable trigger report_sections_frozen");
  await c.query(
    `delete from public.reports where workshop_id in
     (select id from public.workshops where name like '%' || $1 || '%')`, [PROBE_NAME]);
  await c.query("alter table public.reports enable trigger reports_immutable");
  await c.query("alter table public.report_sections enable trigger report_sections_frozen");
  await c.query(`delete from public.workshops where name like '%' || $1 || '%'`, [PROBE_NAME]);
}

async function driveOne(F, c, r, workspaceId, spec) {
  r.section(spec.key);

  // ---- create, and read back what the methodology declares ----
  const made = await F("POST", "/workshops", {
    workspace_id: workspaceId,
    name: `${spec.key} ${PROBE_NAME}`,
    methodology_key: spec.key,
    objective: "drive this methodology end to end with no code written for it",
  });
  if (!r.ok(made.success, "create a workshop through the same endpoint", made.error?.message)) {
    return null;
  }
  const ws = made.data.id;

  const detail = await F("GET", `/workshops/${ws}`);
  const m = detail.data.methodology;
  const stages = m.stages;
  const stageTypes = new Set(stages.map((s) => s.stage_type));

  r.ok(m.factor_categories.length === spec.cats,
    `${spec.cats} factor categories from config`, m.factor_categories.length);
  r.ok((m.weights ?? []).length === spec.weights,
    `${spec.weights} weight definition(s)`, (m.weights ?? []).length);
  r.ok(m.relationship_types.length === spec.rels,
    `${spec.rels} relationship type(s)`, m.relationship_types.length);
  r.ok(stageTypes.has("prioritize") === spec.prioritize,
    spec.prioritize ? "has a prioritize stage" : "has NO prioritize stage",
    [...stageTypes].sort().join(","));

  // A methodology with no prioritize stage defines no vote budget, and the
  // vote endpoint must say so rather than silently accepting.
  if (!spec.prioritize) {
    const factorsFirst = m.factor_categories[0].key;
    const probe = await F("POST", `/workshops/${ws}/factors`,
      { category_key: factorsFirst, title: "Vote refusal probe" });
    const voted = await F("PUT", `/workshops/${ws}/factors/${probe.data.id}/vote`, { value: 1 });
    r.ok(!voted.success, "voting is refused where the methodology has no prioritize stage",
      voted.error?.message);
    await F("DELETE", `/workshops/${ws}/factors/${probe.data.id}`);
  }

  // ---- capture, in this methodology's own categories ----
  const factors = [];
  for (const cat of m.factor_categories.slice(0, 3)) {
    const f = await F("POST", `/workshops/${ws}/factors`, {
      category_key: cat.key,
      title: `${cat.name} item`,
      description: `Captured under ${cat.name}.`,
    });
    if (!f.success) {
      r.ok(false, `capture in ${cat.key}`, f.error?.message);
      return ws;
    }
    await F("POST", `/workshops/${ws}/factors/${f.data.id}/review`, { action: "approve" });
    factors.push(f.data.id);
  }
  r.ok(factors.length === 3, "capture and approve factors in its own categories", factors.length);

  // ---- weigh, on whatever scales it declares ----
  const factorWeights = (m.weights ?? []).filter((w) => w.applies_to === "factor");
  for (const w of factorWeights) {
    // The midpoint of whatever range was configured — never a literal.
    const value = w.scale_max === null
      ? w.scale_min + w.scale_step
      : w.scale_min + Math.floor((w.scale_max - w.scale_min) / w.scale_step / 2) * w.scale_step;
    const set = await F("PUT", `/workshops/${ws}/factors/${factors[0]}/weights/${w.key}`, { value });
    r.ok(set.success, `set ${w.key} to ${value} on its ${w.scale_min}-${w.scale_max ?? "∞"} scale`,
      set.error?.message);

    if (w.scale_max !== null) {
      const over = await F("PUT", `/workshops/${ws}/factors/${factors[0]}/weights/${w.key}`,
        { value: w.scale_max + w.scale_step });
      r.ok(!over.success, `${w.key} refuses a value above its configured maximum`,
        over.error?.message);
    }
  }

  // ---- synthesize ----
  const syn = await F("POST", `/workshops/${ws}/syntheses`, {
    title: "A grouping", description: "grouped from captured factors",
    evidence: { factor: factors.slice(0, 2) },
  });
  r.ok(syn.success, "the same synthesize endpoint groups its factors", syn.error?.message);
  if (!syn.success) return ws;

  // Five Forces rates the SYNTHESIS, which is the only reason applies_to exists.
  const synWeights = (m.weights ?? []).filter((w) => w.applies_to === "synthesis");
  for (const w of synWeights) {
    const value = w.scale_min + w.scale_step;
    const set = await F("PUT", `/workshops/${ws}/syntheses/${syn.data.id}/weights/${w.key}`, { value });
    r.ok(set.success, `set ${w.key} on a SYNTHESIS, not a factor`, set.error?.message);
  }
  await F("POST", `/workshops/${ws}/syntheses/${syn.data.id}/review`, { action: "approve" });

  // ---- relate, where the methodology has pairings ----
  let relationshipId = null;
  if (spec.rels > 0) {
    const rt = m.relationship_types[0];
    const src = rt.source_category_id
      ? factors[m.factor_categories.findIndex((cc) => cc.id === rt.source_category_id)]
      : factors[0];
    const tgt = rt.target_category_id
      ? factors[m.factor_categories.findIndex((cc) => cc.id === rt.target_category_id)]
      : factors[1];
    const rel = await F("POST", `/workshops/${ws}/relationships`, {
      source_id: src, target_id: tgt, relationship_type_key: rt.key,
      fields: { narrative: "why this pairing matters" },
    });
    r.ok(rel.success, `pair two factors under "${rt.name}"`, rel.error?.message);
    if (rel.success) {
      relationshipId = rel.data.id;
      await F("POST", `/workshops/${ws}/relationships/${relationshipId}/review`, { action: "approve" });
    }
  } else {
    const rel = await F("POST", `/workshops/${ws}/relationships`, {
      source_id: factors[0], target_id: factors[1], relationship_type_key: "so",
    });
    r.ok(!rel.success, "relationships are refused where the methodology declares none",
      rel.error?.message);
  }

  // ---- interpret ----
  const interpret = stages.find((s) => s.stage_type === "interpret");
  const cites = Array.isArray(interpret?.config?.cites) ? interpret.config.cites : ["synthesis"];
  const evidence = { synthesis: [syn.data.id] };
  if (cites.includes("factor_relationship") && relationshipId) {
    evidence.factor_relationship = [relationshipId];
  }
  const ins = await F("POST", `/workshops/${ws}/insights`, {
    title: "What this means", description: "an interpretation", evidence,
  });
  r.ok(ins.success, "the same interpret endpoint creates its insight", ins.error?.message);
  if (!ins.success) return ws;
  await F("POST", `/workshops/${ws}/insights/${ins.data.id}/review`, { action: "approve" });

  // ---- recommend, where it has that stage ----
  if (spec.recommend) {
    const rec = await F("POST", `/workshops/${ws}/recommendations`, {
      title: "What to do about it", description: "a move",
      fields: { priority: "high" }, evidence: { insight: [ins.data.id] },
    });
    r.ok(rec.success, "the same recommend endpoint creates its recommendation", rec.error?.message);
    if (rec.success) {
      await F("POST", `/workshops/${ws}/recommendations/${rec.data.id}/review`, { action: "approve" });
    }
  } else {
    // Sent COMPLETE on purpose. An earlier version of this omitted the
    // description, and passed on a NOT NULL constraint rather than on the
    // rule it claimed to test — which is how the missing stage check stayed
    // hidden. The message must name the stage, not merely be a failure.
    const rec = await F("POST", `/workshops/${ws}/recommendations`, {
      title: "Should not exist",
      description: "a complete request, so only the stage rule can refuse it",
      fields: { priority: "high" },
      evidence: { insight: [ins.data.id] },
    });
    r.ok(!rec.success && /no recommend stage/.test(rec.error?.message ?? ""),
      "recommendations are refused where the methodology has no recommend stage",
      rec.error?.message);

    const listed = await F("GET", `/workshops/${ws}/recommendations`);
    r.ok((listed.data ?? []).length === 0, "and none exist to be listed", listed.data?.length);
  }

  // ---- report ----
  const types = await F("GET", `/workshops/${ws}/report-types`);
  r.ok(types.success && types.data.length >= 1, "it declares its own report type(s)",
    types.data?.map((t) => t.key).join(","));

  const rep = await F("POST", `/workshops/${ws}/reports`, { report_type: types.data[0].key });
  r.ok(rep.success, "create its report", rep.error?.message);
  if (!rep.success) return ws;

  const got = await F("GET", `/workshops/${ws}/reports/${rep.data.id}`);
  const sections = got.data.sections;

  // A category_matrix must produce one group per configured category — the
  // single strongest signal that nothing is hardcoded to four.
  const matrix = sections.find((s) => s.section_type === "category_matrix");
  if (matrix) {
    r.ok(matrix.groups.length === spec.cats,
      `the same category_matrix renderer produces ${spec.cats} groups`, matrix.groups.length);
  }

  // A pair_matrix renders nothing when there are no relationship types.
  const pair = sections.find((s) => s.section_type === "pair_matrix");
  if (spec.rels === 0) {
    r.ok(!pair, "NO pair matrix, because it declares no relationship types");
  } else if (pair) {
    r.ok(pair.groups.length === spec.rels,
      `the pair matrix produces ${spec.rels} group(s)`, pair.groups.length);
  }

  // Weight columns come from config, in config order.
  const rated = sections.filter((s) => (s.weight_columns ?? []).length > 0);
  if (factorWeights.length > 0 || synWeights.length > 0) {
    r.ok(rated.length > 0, "at least one section declares weight columns",
      rated.map((s) => s.weight_columns.map((cc) => cc.name).join("+")).join(" | "));
  } else {
    r.ok(rated.length === 0, "no weight columns, because it declares no weights");
  }

  // Transformation groups its roadmap BY a weight rather than by category.
  const grouped = sections.find((s) => String(s.source?.group_by ?? "").startsWith("weight:"));
  if (grouped) {
    r.ok(Array.isArray(grouped.groups),
      "a section grouped by a weight renders groups, not a flat list",
      grouped.groups?.map((g) => g.name).join(" | "));
  }

  await F("POST", `/workshops/${ws}/reports/${rep.data.id}/review`, { action: "submit" });
  await F("POST", `/workshops/${ws}/reports/${rep.data.id}/review`, { action: "approve" });
  const pub = await F("POST", `/workshops/${ws}/reports/${rep.data.id}/publish`);
  r.ok(pub.success, "publish works identically", pub.error?.message);

  const html = await F("GET", `/workshops/${ws}/reports/${rep.data.id}/export.html`,
    undefined, { raw: true });
  r.ok(html.status === 200, "the HTML export renders", html.status);

  // ---- the load-bearing check ----
  const blob = (JSON.stringify(got.data) + JSON.stringify(detail.data) + html.text).toLowerCase();
  const foreign = [];
  for (const [key, words] of Object.entries(MARKERS)) {
    if (key === spec.key) continue;
    for (const w of words) if (blob.includes(w)) foreign.push(`${w} (${key})`);
  }
  r.ok(foreign.length === 0,
    "no other methodology's vocabulary appears anywhere in it",
    foreign.length ? foreign.join(", ") : "none");

  // And its own vocabulary DOES appear — otherwise the check above passes
  // trivially for a methodology that rendered nothing at all.
  const own = MARKERS[spec.key] ?? [];
  r.ok(own.length === 0 || own.some((w) => blob.includes(w)),
    "and its own vocabulary does appear, so the check above is not vacuous",
    own.join(", "));

  return ws;
}
