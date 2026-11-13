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
    // A COUNT WAS THE WRONG QUESTION, and it broke the day `initiative` was
    // added — a correct change failing a check that was really pinning the
    // number 4. Replacing it with 5 rebuilds the same trap one kind along, so
    // this asks what the catalogue is FOR: the UI builds every object form
    // from it, so each entry must be renderable.
    r.ok(kinds.success && kinds.data.length > 0, "the catalogue lists the registered kinds",
      kinds.data && kinds.data.map((k) => k.key).join(", "));
    r.ok(
      (kinds.data ?? []).every((k) => k.key && k.route && k.label),
      "every kind carries the key, route and label a form needs",
      (kinds.data ?? []).filter((k) => !(k.key && k.route && k.label)).map((k) => k.key).join(",") || "all complete",
    );

    // THE INVARIANT `ByStageType` DEPENDS ON, asserted rather than assumed.
    //
    // That lookup scans a Go MAP, whose iteration order is randomised, and
    // returns the first kind whose stage_type matches. Two kinds claiming one
    // stage type would therefore resolve differently between requests — the
    // dashboard counting relationships on one call and initiatives on the
    // next, intermittently and with nothing in the logs. It is exactly the
    // shortcut `initiative` was tempted into taking (it is created inside the
    // relate stage), and it declares an empty stage_type with `hosted_by`
    // instead for this reason.
    const claimed = (kinds.data ?? []).filter((k) => k.stage_type).map((k) => k.stage_type);
    r.ok(new Set(claimed).size === claimed.length,
      "no two kinds claim the same stage type", claimed.join(", "));
    const hosted = (kinds.data ?? []).filter((k) => !k.stage_type);
    r.ok(hosted.every((k) => (k.hosted_by ?? []).length > 0),
      "a kind no stage produces says which stages may host it",
      hosted.map((k) => `${k.key}:${(k.hosted_by ?? []).join("/") || "NONE"}`).join(", ") || "none");
    const rec = kinds.data?.find((k) => k.key === "recommendation");
    r.ok(rec?.fields?.some((f) => f.name === "priority" && f.type === "enum"),
      "recommendation declares its own fields", rec?.fields?.map((f) => f.name).join(","));
    const relKind = kinds.data?.find((k) => k.key === "factor_relationship");
    r.ok(Boolean(relKind?.pairing),
      "relationship declares a pairing rather than a link table");

    // WHAT IT PAIRS IS METHODOLOGY CONFIG, SO THIS ASSERTS THE RELATIONSHIP.
    // The registry's own default is `factor` — that is the PLATFORM's answer,
    // and Business Model Canvas and Transformation Planning rely on it. This
    // workshop's relate stage overrides it to `synthesis`. Asserting the
    // literal "factor" here is what broke when SWOT-TOWS moved to themes, and
    // replacing it with the literal "synthesis" would rebuild the same trap
    // one methodology along — the same mistake as pinning a magic section
    // count. See the magic-number note in CLAUDE.md.
    r.ok(relKind?.pairing?.default_target === "factor",
      "...whose PLATFORM default is factors", relKind?.pairing?.default_target);
    const relStage = (await F("GET", `/workshops/${WS}`)).data?.methodology?.stages
      ?.find((s) => s.stage_type === "relate");
    r.ok(relStage?.config?.pairs === "synthesis",
      "...and this methodology's relate stage overrides it in CONFIG, with no code",
      relStage?.config?.pairs);

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

    // SWOT-TOWS PAIRS THEMES FROM 2026-11-06, so the matrix needs one theme
    // per category. The pairing rules below are unchanged — a weakness is
    // still refused in an SO cell — but a THEME's category is DERIVED from the
    // notes it cites rather than read off a column, which is the new property
    // these cases actually exercise.
    const themeFor = async (label, factor) => {
      const t = await F("POST", `/workshops/${WS}/syntheses`, {
        title: `VERIFY ${label} theme`,
        evidence: { factor: [factor.id] },
      });
      r.ok(t.success, `create a ${label} theme (category derived from its notes)`, t.error?.message);
      if (t.data) created.syntheses.push(t.data.id);
      return t.data;
    };
    const sTheme = await themeFor("strength", strength);
    const wTheme = await themeFor("weakness", weakness);
    const oTheme = await themeFor("opportunity", opportunity);
    const tTheme = await themeFor("threat", threat);

    const rel = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: sTheme.id, target_id: oTheme.id, relationship_type_key: "so",
      title: "VERIFY SO pairing", fields: { narrative: "n", strategic_option: "s" },
    });
    r.ok(rel.success, "create an SO relationship (strength theme x opportunity theme)", rel.error?.message);
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
    r.ok(relRow?.source_id === sTheme.id && relRow?.target_id === oTheme.id,
      "relationship round-trips its pairing");
    // THE ROW SAYS WHAT IT JOINS, not the stage. Relationships created before
    // 2026-11-06 pair factors and are approved analysis; reading the pair kind
    // from the stage's current config would render every one of them with two
    // empty endpoints — work appearing to have been lost.
    r.ok(relRow?.pairs_kind === "synthesis",
      "and reports the KIND of its endpoints, per row", relRow?.pairs_kind);
    r.ok(relRow?.fields?.narrative === "n",
      "relationship round-trips narrative (it has no description column)");

    r.section("methodology config drives the pairing rules, not code");
    const bad = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: wTheme.id, target_id: oTheme.id, relationship_type_key: "so",
    });
    r.ok(!bad.success && bad.error.code === "VALIDATION_ERROR",
      "a weakness theme is refused in an SO cell", bad.error?.message);

    const wo = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: wTheme.id, target_id: oTheme.id, relationship_type_key: "wo",
    });
    r.ok(wo.success, "the same weakness theme is accepted in a WO cell", wo.error?.message);
    if (wo.data) created.relationships.push(wo.data.id);

    const wt = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: sTheme.id, target_id: tTheme.id, relationship_type_key: "wt",
    });
    r.ok(!wt.success, "a strength theme is refused in a WT cell", wt.error?.message);

    const self = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: sTheme.id, target_id: sTheme.id, relationship_type_key: "so",
    });
    r.ok(!self.success, "a theme cannot be paired with itself", self.error?.message);

    // A THEME SPANNING CATEGORIES HAS NO CATEGORY TO PAIR ON. `syn` above
    // cites a strength AND a weakness, which the capture board would not
    // produce (same-category stacking is a client affordance) but which the
    // API allows on purpose — whether a theme may span categories is a
    // methodology question the engine refuses to answer. So it is refused
    // HERE, at the pairing, and the refusal has to name both categories: told
    // only "invalid category", somebody goes looking for a mistake they did
    // not make.
    const spanning = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: syn.data.id, target_id: oTheme.id, relationship_type_key: "so",
    });
    r.ok(!spanning.success, "a theme spanning two categories is refused", spanning.error?.message);
    r.ok(/spans/i.test(spanning.error?.message ?? "") &&
      /\band\b/.test(spanning.error?.message ?? ""),
      "...and the refusal names the categories it spans, not just 'invalid'",
      spanning.error?.message);

    // WRONG KIND IS NOT WRONG WORKSHOP. A factor id here used to be refused
    // with "Both themes must belong to this workshop" — the factor IS in the
    // workshop, so that sends somebody checking membership for a problem that
    // is really "this stage pairs themes now".
    const wrongKind = await F("POST", `/workshops/${WS}/relationships`, {
      source_id: strength.id, target_id: oTheme.id, relationship_type_key: "so",
    });
    r.ok(!wrongKind.success, "a factor is refused where the stage pairs themes",
      wrongKind.error?.message);
    r.ok(/is a factor/i.test(wrongKind.error?.message ?? "") &&
      !/belong to this workshop/i.test(wrongKind.error?.message ?? ""),
      "...and the refusal says it is the wrong KIND, not the wrong workshop",
      wrongKind.error?.message);

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

    // ================================================================
    r.section("who may write an object is PER KIND (UAT 2026-11-14)");
    // ================================================================
    //
    // One list governed every kind and it refused participants, while the
    // capture board offered them the stacking gesture — so dragging one note
    // onto another, naming the theme and getting a 403 was the shipped
    // behaviour. The participant flow had made grouping their job on
    // 2026-11-06 and the server was never told.
    //
    // BOTH HALVES ARE ASSERTED. A check that only proved a participant can now
    // make a theme would pass just as happily if the rule had been deleted
    // outright, which is the thing that must not happen: an insight is a claim
    // about the evidence and a recommendation commits the organisation to
    // work, so App Spec §3.17 still holds for those.
    const pTheme = await P("POST", `/workshops/${WS}/syntheses`, {
      title: "VERIFY participant theme",
      evidence: {},
    });
    r.ok(
      pTheme.success,
      "a participant can create a theme — the gesture the capture board offers",
      pTheme.error?.message,
    );
    if (pTheme.success) created.syntheses.push(pTheme.data.id);

    // ...and can go on editing the one they made, or the drop that adds a
    // second note to an existing stack fails where the first one worked.
    if (pTheme.success) {
      const pEdit = await P("PATCH", `/workshops/${WS}/syntheses/${pTheme.data.id}`, {
        title: "VERIFY participant theme renamed",
      });
      r.ok(pEdit.success, "...and can rename it", pEdit.error?.message);
    }

    const pInsight = await P("POST", `/workshops/${WS}/insights`, {
      title: "VERIFY participant insight",
      description: "should be refused",
      evidence: {},
    });
    r.ok(
      !pInsight.success && pInsight.error.code === "FORBIDDEN",
      "a participant still cannot author an insight",
      pInsight.error?.message ?? `created ${pInsight.data?.id}`,
    );
    if (pInsight.success) created.insights.push(pInsight.data.id);

    const pRec = await P("POST", `/workshops/${WS}/recommendations`, {
      title: "VERIFY participant recommendation",
      fields: { priority: "low" },
      evidence: {},
    });
    r.ok(
      !pRec.success && pRec.error.code === "FORBIDDEN",
      "...nor a recommendation",
      pRec.error?.message ?? `created ${pRec.data?.id}`,
    );
    if (pRec.success) created.recommendations.push(pRec.data.id);
  } finally {
    // The relationships created here have no title by design, so they must
    // be removed by id — a title prefix never matches them.
    await cleanup(c, {
      titlePrefixes: ["VERIFY"],
      ids: {
        recommendations: created.recommendations,
        insights: created.insights,
        factor_relationships: created.relationships,
        syntheses: created.syntheses,
      },
    });
    r.note("test rows removed");
  }
});
