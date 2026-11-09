// The strategy matrix: a relate stage drawn with its categories on the axes,
// holding the work the room does about what to DO.
//
// TWO KINDS OF CHECK, for two kinds of risk.
//
// The SOURCE checks are here for the reason board-ui.js and shell-ui.js read
// source: the 3x3 layout is a RENDERING decision and every endpoint involved
// is correct whether the grid is drawn from the categories or hardcoded. An
// API-only suite would report this feature healthy while the screen named
// SWOT in its markup — which is the one thing the engine may never do.
//
// The API checks are here because the rest is a claim about the ENGINE: that
// a fifth object kind arrived without a second kind claiming a stage type,
// that hosting is something a methodology opts into rather than something
// every relate stage now gets, and that an action is rated and ranked by two
// different people with two different permissions. Only the real database
// can answer those.
import fs from "node:fs";
import path from "node:path";
import { runSuite, clients } from "../lib/harness.js";

const SRC = (p) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");

/** The same file with comments stripped — see participant-flow.js for why. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

const PROBE = "tows-matrix probe";

runSuite("tows-matrix", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P, analyst: A } =
    await clients(baseUrl, ["facilitator", "participant", "analyst"]);

  await clearProbes(c);
  const created = { initiatives: [], actions: [], workshops: [] };

  try {
    // ================================================================
    r.section("the grid is derived from config, not drawn from a list");
    // ================================================================
    //
    // THE CLAIM THE WHOLE LAYOUT RESTS ON. The axes are a pivot of
    // `methodology_relationship_types`, which has carried source and target
    // categories since Phase 0. If a type ever lost one, the grid would lose
    // a row or a column and render a hole — indistinguishable from a
    // quadrant nobody has filled in.
    const detail = await F("GET", `/workshops/${WS}`);
    const m = detail.data?.methodology;
    const types = m?.relationship_types ?? [];
    r.ok(types.length > 0, "the methodology declares relationship types", types.length);
    r.ok(types.every((t) => t.source_category_id && t.target_category_id),
      "every type names BOTH categories, so the axes can be derived",
      types.filter((t) => !(t.source_category_id && t.target_category_id)).map((t) => t.key).join(",") || "all complete");

    const cols = new Set(types.map((t) => t.source_category_id));
    const rows = new Set(types.map((t) => t.target_category_id));
    r.ok(cols.size * rows.size === types.length,
      "...and they form a COMPLETE grid, so there is no empty cell",
      `${cols.size} x ${rows.size} = ${cols.size * rows.size} against ${types.length} types`);

    const relStage = (m?.stages ?? []).find((s) => s.stage_type === "relate");
    r.ok(relStage?.config?.layout === "axis",
      "the relate stage opts into the axis layout in CONFIG", relStage?.config?.layout);
    r.ok(relStage?.config?.actions?.kind && relStage?.config?.actions?.group_kind,
      "...and declares which registry kinds its cells hold",
      JSON.stringify(relStage?.config?.actions ?? null));

    // ================================================================
    r.section("a fifth object kind, without two kinds claiming one stage");
    // ================================================================
    const kinds = (await F("GET", "/object-kinds")).data ?? [];
    const init = kinds.find((k) => k.key === "initiative");
    r.ok(Boolean(init), "the registry carries the initiative kind");
    // THE BUG THIS AVOIDS IS INTERMITTENT. `ByStageType` scans a Go map,
    // whose iteration order is randomised, so a second kind claiming
    // "relate" would resolve to a relationship on some requests and an
    // initiative on others — with nothing in the logs either way.
    r.ok(init?.stage_type === "",
      "it claims NO stage type, because the relate stage already produces relationships",
      JSON.stringify(init?.stage_type));
    r.ok((init?.hosted_by ?? []).some((h) => h.stage_type === "relate" && h.requires_config_key),
      "it is hosted by a relate stage that DECLARES the config key",
      JSON.stringify(init?.hosted_by ?? []));
    r.ok(init?.ordered === true, "and it carries a hand-set order");

    const rec = kinds.find((k) => k.key === "recommendation");
    r.ok(rec?.parent?.kind === "initiative",
      "an action is CONTAINED by an initiative — a column, not a citation link",
      JSON.stringify(rec?.parent ?? null));

    // ================================================================
    r.section("pairing, then the work the pairing produces");
    // ================================================================
    const themes = (await F("GET", `/workshops/${WS}/syntheses`)).data ?? [];
    const type = types[0];
    r.ok(Boolean(type), "a quadrant to work in", type?.key);

    const mk = await F("POST", `/workshops/${WS}/initiatives`, {
      title: `${PROBE} invest in partners`,
      relationship_type_key: type.key,
    });
    r.ok(mk.success, "an initiative is created in a quadrant", mk.error?.message);
    if (mk.success) created.initiatives.push(mk.data.id);

    // A NAME IS ENOUGH. `initiatives.description` is nullable, and Go must
    // not invent a requirement the schema does not have — the exact defect
    // that made stacking two notes impossible ("What this theme says is
    // required"). The request above deliberately sends no description.
    const noType = await F("POST", `/workshops/${WS}/initiatives`, { title: `${PROBE} homeless` });
    r.ok(!noType.success && /relationship type/i.test(noType.error?.message ?? ""),
      "an initiative with no quadrant is refused, and the message says why",
      noType.error?.message);

    const listed = (await F("GET", `/workshops/${WS}/initiatives`)).data ?? [];
    const mine = listed.find((i) => i.id === mk.data?.id);
    r.ok(mine?.relationship_type_id === type.id,
      "it reports the quadrant it belongs to", mine?.relationship_type_id);

    const act1 = await F("POST", `/workshops/${WS}/recommendations`, {
      title: `${PROBE} run a partner steering committee`,
      description: "quarterly, with the top five partners",
      fields: { priority: "high" },
      parent_id: mk.data.id,
    });
    r.ok(act1.success, "an action is created under it", act1.error?.message);
    if (act1.success) created.actions.push(act1.data.id);

    const act2 = await F("POST", `/workshops/${WS}/recommendations`, {
      title: `${PROBE} certify delivery partners`,
      description: "regional, to reduce churn",
      fields: { priority: "medium" },
      parent_id: mk.data.id,
    });
    if (act2.success) created.actions.push(act2.data.id);

    // AN ACTION IS ONE LINE, and this posts EXACTLY what the quick-add posts.
    //
    // Both probes above send a description, so they were testing a request the
    // form does not make — the same trap the capture board's stacking check
    // fell into, where the suite passed throughout because it sent a field the
    // board had no way to supply. The form's second box says "More detail
    // (optional)" and submits with just a title, and until 2026-11-09 the
    // column was NOT NULL, so that submission failed with "What to do is
    // required." Found by a browser probe, not by any check.
    const oneLine = await F("POST", `/workshops/${WS}/recommendations`, {
      title: `${PROBE} build out AI messaging that differentiates us`,
      fields: { priority: "high" },
      parent_id: mk.data.id,
    });
    r.ok(oneLine.success,
      "an action is created from a title alone, which is all the quick-add sends",
      oneLine.error?.message);
    if (oneLine.success) created.actions.push(oneLine.data.id);
    r.ok(oneLine.success && !oneLine.data.description,
      "and stores no description rather than inventing one from the title",
      oneLine.data?.description);

    // The paired negative, so the fix above cannot become "nothing is ever
    // required": an insight's description IS its claim and its column is
    // still NOT NULL. Matched on the message, so a refusal for some other
    // reason would not pass as this one.
    const bareInsight = await F("POST", `/workshops/${WS}/insights`, {
      title: `${PROBE} an insight with no body`,
    });
    r.ok(!bareInsight.success && /required/i.test(bareInsight.error?.message ?? ""),
      "an insight with no description is still refused — the asymmetry is deliberate",
      bareInsight.error?.message);

    const actions = (await F("GET", `/workshops/${WS}/recommendations`)).data ?? [];
    const got = actions.find((a) => a.id === act1.data?.id);
    r.ok(got?.parent_id === mk.data?.id,
      "and reports the initiative it sits under", got?.parent_id);

    // A FOREIGN PARENT IS A VALIDATION FAILURE, not a row quietly joining two
    // workshops' content. Scoped in the query, never filtered afterwards.
    // IT CREATES THE FOREIGN PARENT rather than looking for one. The first
    // version skipped when it found none and reported a note instead of an
    // answer — and on a fresh database it would ALWAYS have skipped, so the
    // cross-workshop rule would have been permanently unchecked. A check
    // that can vanish is not a check (see branding.js's export case).
    const otherWs = (await c.query(
      `select id from public.workshops where id <> $1 limit 1`, [WS])).rows[0];
    if (otherWs) {
      const foreign = (await c.query(
        `insert into public.initiatives (workshop_id, relationship_type_id, title, state)
         values ($1, $2, $3, 'submitted') returning id`,
        [otherWs.id, type.id, `${PROBE} foreign`])).rows[0];
      const cross = await F("POST", `/workshops/${WS}/recommendations`, {
        title: `${PROBE} cross-workshop`, description: "should be refused",
        fields: { priority: "low" }, parent_id: foreign.id,
      });
      r.ok(!cross.success && /not part of this workshop/i.test(cross.error?.message ?? ""),
        "an initiative from another workshop is refused, scoped in the query",
        cross.error?.message);
    } else {
      r.ok(false, "needs a second workshop to test the cross-workshop refusal");
    }

    // ================================================================
    r.section("participants rate; the facilitator ranks; both are visible");
    // ================================================================
    //
    // The user asked for exactly this split, and for the two to be allowed to
    // DISAGREE: the facilitator drags the order "even if it disagrees with
    // the aggregated ranking during a live discussion". So both must exist
    // and neither may overwrite the other.
    const weightKey = relStage?.config?.actions?.weight;
    const defs = (await F("GET", `/workshops/${WS}/weights`)).data?.definitions ?? [];
    const def = defs.find((d) => d.key === weightKey);
    r.ok(def?.applies_to === "recommendation",
      "the action weight applies to the action kind", def?.applies_to);
    // THE SCALE IS CONFIGURATION. Asserted as a relationship against the
    // definition the server returned, never as a literal 1 and 5 here.
    r.ok(def && def.scale_max > def.scale_min && def.per_participant && def.aggregate === "mean",
      "...is per-participant and averaged",
      def && `${def.scale_min}-${def.scale_max} ${def.aggregate} per_participant=${def.per_participant}`);
    r.ok(def?.allowed_roles?.includes("participant") && !def?.allowed_roles?.includes("facilitator"),
      "...and is the room's to set, not the facilitator's",
      JSON.stringify(def?.allowed_roles));

    const rated = await P("PUT",
      `/workshops/${WS}/recommendations/${act1.data.id}/weights/${weightKey}`, { value: def.scale_max });
    r.ok(rated.success, "a participant rates an action", rated.error?.message);

    const refusedRate = await F("PUT",
      `/workshops/${WS}/recommendations/${act1.data.id}/weights/${weightKey}`, { value: def.scale_min });
    r.ok(!refusedRate.success, "the facilitator is refused — their rating would count twice",
      refusedRate.error?.message);

    const after = (await F("GET", `/workshops/${WS}/weights`)).data ?? {};
    const total = (after.totals ?? []).find(
      (t) => t.weight_key === weightKey && t.object_id === act1.data.id);
    // TWO NUMBERS, NEVER ONE — the rule the leaderboard, the report and the
    // capture board already follow. A figure with no backing reads as
    // agreement when one enthusiast produced it.
    r.ok(total && total.value === def.scale_max && total.voters === 1,
      "the group figure carries HOW MANY PEOPLE are behind it",
      total && `${total.value} from ${total.voters}`);

    if (act2.success) {
      const order = await F("PUT", `/workshops/${WS}/recommendations/order`, {
        scope_id: mk.data.id,
        ids: [act2.data.id, act1.data.id],
      });
      r.ok(order.success, "the facilitator sets the running order", order.error?.message);

      const reordered = (await F("GET", `/workshops/${WS}/recommendations`)).data ?? [];
      const pos = Object.fromEntries(
        reordered.filter((a) => a.parent_id === mk.data.id).map((a) => [a.id, a.board_position]));
      r.ok(pos[act2.data.id] === 0 && pos[act1.data.id] === 1,
        "...and it is stored as a position, 0..n-1", JSON.stringify(pos));

      // THE DISAGREEMENT SURVIVES, which is the whole point of showing both.
      // The action the room rated highest is now SECOND, because a person
      // decided so in the room. If ranking ever started following the
      // average, this check goes red.
      const topRated = act1.data.id;
      r.ok(pos[topRated] === 1,
        "the rating did NOT re-sort the order — the two may disagree on purpose",
        `top-rated action sits at position ${pos[topRated]}`);

      const byParticipant = await P("PUT", `/workshops/${WS}/recommendations/order`, {
        scope_id: mk.data.id, ids: [act1.data.id, act2.data.id],
      });
      r.ok(!byParticipant.success,
        "a participant cannot resequence what the room is looking at — a boundary, not an affordance",
        byParticipant.error?.message);

      const bogus = await F("PUT", `/workshops/${WS}/recommendations/order`, {
        scope_id: mk.data.id, ids: [act1.data.id, act1.data.id],
      });
      r.ok(!bogus.success, "the same action twice is refused rather than half-applied",
        bogus.error?.message);
    }

    // ================================================================
    r.section("two things made in the same second keep their order");
    // ================================================================
    //
    // FOUND BY LOOKING AT A SCREENSHOT while every assertion was green. Two
    // initiatives typed seconds apart drew in reverse, because the server
    // formatted `created_at` with second precision: identical strings, a
    // stable client sort, and so the API's own `created_at desc` showed
    // through as newest-first — the exact opposite of the oldest-first rule
    // the board and this matrix both follow.
    const a1 = await F("POST", `/workshops/${WS}/initiatives`,
      { title: `${PROBE} first`, relationship_type_key: type.key });
    const a2 = await F("POST", `/workshops/${WS}/initiatives`,
      { title: `${PROBE} second`, relationship_type_key: type.key });
    if (a1.success) created.initiatives.push(a1.data.id);
    if (a2.success) created.initiatives.push(a2.data.id);
    const both = (await F("GET", `/workshops/${WS}/initiatives`)).data ?? [];
    const t1 = both.find((i) => i.id === a1.data?.id)?.created_at ?? "";
    const t2 = both.find((i) => i.id === a2.data?.id)?.created_at ?? "";
    r.ok(t1 !== "" && t1 !== t2,
      "their timestamps are distinguishable, so oldest-first has something to sort on",
      `${t1} vs ${t2}`);
    r.ok(t1.localeCompare(t2) < 0,
      "...and the one made first sorts first as TEXT, which is how the client compares them",
      `${t1} < ${t2}`);

    // ================================================================
    r.section("deleting an initiative takes its actions with it");
    // ================================================================
    const doomed = await F("POST", `/workshops/${WS}/initiatives`, {
      title: `${PROBE} to be removed`, relationship_type_key: type.key,
    });
    const child = await F("POST", `/workshops/${WS}/recommendations`, {
      title: `${PROBE} child action`, description: "should go with its parent",
      fields: { priority: "low" }, parent_id: doomed.data.id,
    });
    await F("DELETE", `/workshops/${WS}/initiatives/${doomed.data.id}`);
    const survivors = (await F("GET", `/workshops/${WS}/recommendations`)).data ?? [];
    r.ok(!survivors.some((a) => a.id === child.data?.id),
      "the action is gone too — an orphan would sit in a quadrant under no heading");

    // ================================================================
    r.section("GENERICITY: hosting is opted into, not granted to every relate stage");
    // ================================================================
    //
    // Business Model Canvas and Transformation Planning both have relate
    // stages and neither asked for actions in their cells. A bare "hosted by
    // a relate stage" would have handed them a fifth object kind silently,
    // which is the exact shape of leak this suite family exists to find.
    const workspaces = await F("GET", "/workspaces");
    const wsId = workspaces.data?.[0]?.id;
    const others = (await c.query(`
      select distinct m.key
        from public.methodologies m
        join public.methodology_stages s on s.methodology_id = m.id
       where s.stage_type = 'relate' and m.key <> 'swot-tows'`)).rows;
    r.ok(others.length > 0, "another methodology has a relate stage to compare against",
      others.map((o) => o.key).join(", "));

    for (const other of others) {
      const was = (await c.query("select is_active from public.methodologies where key = $1",
        [other.key])).rows[0]?.is_active;
      await c.query("update public.methodologies set is_active = true where key = $1", [other.key]);
      try {
        const made = await F("POST", "/workshops", {
          workspace_id: wsId,
          name: `${other.key} ${PROBE}`,
          methodology_key: other.key,
          objective: "prove the matrix layout did not leak",
        });
        if (!made.success) {
          r.note(`could not create a ${other.key} workshop: ${made.error?.message}`);
          continue;
        }
        created.workshops.push(made.data.id);

        const od = await F("GET", `/workshops/${made.data.id}`);
        const oStage = (od.data?.methodology?.stages ?? []).find((s) => s.stage_type === "relate");
        r.ok(oStage && oStage.config?.layout !== "axis" && !oStage.config?.actions,
          `${other.key}'s relate stage declares neither the axis layout nor actions`,
          JSON.stringify(oStage?.config ?? null));

        const leak = await F("POST", `/workshops/${made.data.id}/initiatives`, {
          title: `${PROBE} should not exist`,
          relationship_type_key: od.data?.methodology?.relationship_types?.[0]?.key,
        });
        // THE MESSAGE MUST NOT LIE. These methodologies DO have relate
        // stages; what they lack is one that declares initiatives. An
        // earlier message said "has no relate stage", which would send
        // somebody looking for a stage that is right there.
        r.ok(!leak.success,
          `${other.key} cannot hold an initiative — it never declared one`,
          leak.error?.message);
        r.ok(!/no relate stage/i.test(leak.error?.message ?? ""),
          `...and the refusal does not claim ${other.key} has no relate stage, because it has one`,
          leak.error?.message);
      } finally {
        await c.query("update public.methodologies set is_active = $1 where key = $2",
          [was ?? false, other.key]);
      }
    }

    // ================================================================
    r.section("the screen is drawn from the categories, and names no methodology");
    // ================================================================
    const matrix = SRC("components/methodology/TowsMatrix.tsx");
    const body = code(matrix);

    // The file ARGUES at length that it must name no methodology, so the raw
    // text is full of the words. Only the code is asked.
    for (const word of ["swot", "strength", "weakness", "opportunity", "threat", "\"so\"", "'so'"]) {
      r.ok(!new RegExp(word, "i").test(body.replace(/TowsMatrix/g, "")),
        `the component's code does not name ${word}`);
    }
    r.ok(/source_category_id/.test(body) && /target_category_id/.test(body),
      "the axes are derived from the relationship types' own categories");
    r.ok(/cols\.length \* rows\.length !== types\.length/.test(body),
      "an incomplete cross-product is detected rather than drawn with a hole");
    r.ok(/<RelationshipMatrix/.test(body),
      "...and it falls back to the flat matrix instead of failing");
    r.ok(/readActionsConfig/.test(body) && !/"recommendation"|'recommendation'/.test(body.replace(/kindByKey\.get\("factor_relationship"\)/, "")),
      "the kinds in a cell come from stage config, not from literals in the component");

    // THE SCALE AND THE WEIGHT KEY ARE CONFIG. A literal here is the same bug
    // the weights package forbids and a literal 'vote' on the capture board
    // would have been.
    r.ok(!/action_priority/.test(body), "the weight key is not hardcoded");
    r.ok(!/scale_(min|max|step)/.test(body),
      "and no bound is read here — WeightControl owns the range");

    const drag = code(SRC("lib/usePointerDrag.ts"));
    // THE TWO RULES THAT MAKE A DRAG FEEL LIKE A DRAG. Pointer coordinates in
    // React state re-render the whole surface on every mouse move, which is
    // the stutter HTML5 drag-and-drop was replaced to fix.
    r.ok(/requestAnimationFrame\(paint\)/.test(drag),
      "the ghost is painted in a rAF callback");
    r.ok(/node\.style\.transform/.test(drag),
      "...written to the NODE, never held in state");
    r.ok(/sameTarget\(next, live\.current\.target\)/.test(drag),
      "target state changes only when the target changes");
    // THE HOOK DELEGATES HIT-TESTING, so this property lives in the caller.
    // The first version of this check looked in the hook and failed on a
    // correct implementation — a check aimed at the wrong file reports a
    // defect that is not there, which costs as much as missing a real one.
    r.ok(/elementsFromPoint/.test(body),
      "hit-testing reads the live document rather than cached rectangles");
    r.ok(/pointerType === "touch"/.test(drag),
      "touch requires a hold, or the board could never be scrolled");
    r.ok(/createPortal/.test(code(matrix)),
      "the ghost is portalled, so a scrolling cell cannot clip it");

    // THE WHOLE CARD IS THE HANDLE on an axis theme. The capture board
    // shipped with only a ~10px rim draggable, which on a small card is
    // indistinguishable from "this cannot be moved".
    r.ok(/\{\.\.\.dragHandlers\(\{ \.\.\.t, label: t\.title \}\)\}/.test(matrix),
      "an axis theme spreads the drag handlers onto the whole card");

    // ---- the hidden notes are reachable (UAT 2026-11-10) ----
    //
    // The card summarised a theme as four notes and "+3 more", and the three
    // were unreachable from this screen: the only way to read them was to
    // leave the matrix for the capture stage. It is now a control.
    r.ok(/aria-expanded=\{expanded\.has\(t\.id\)\}/.test(matrix),
      "the hidden notes are behind a real control, not a label");
    r.ok(/show fewer/.test(matrix),
      "...which closes again, so one long theme cannot strand the cell open");
    // PER THEME, not per cell: opening one to read it must not unfold the
    // three below it and push them out of a panel that scrolls.
    r.ok(/useState<Set<string>>\(new Set\(\)\)/.test(matrix),
      "...and it opens one theme at a time");
    // A BUTTON INSIDE A DRAG SOURCE has to tell a drag from a click, or
    // dropping a theme into a quadrant would also unfold its note list —
    // the gesture this cell exists for.
    r.ok(/if \(didMove\(\)\) return;/.test(matrix),
      "...and a drag that ends on it does not also expand it");
    // One statement of how many notes the summary shows: the slice, the
    // count in "+N more" and the test that offers it must agree.
    const summaryLiterals = (matrix.match(/\.slice\(0, SUMMARY_NOTES\)/g) ?? []).length;
    r.ok(summaryLiterals === 1 && /const SUMMARY_NOTES = \d+;/.test(matrix),
      "the summary length is stated once, not repeated in three places",
      `${summaryLiterals} use of the constant`);
  } finally {
    // Restore what was found. This suite writes to the DEMO workshop, so
    // anything it leaves behind becomes part of what the next UAT session
    // sees — the same reason invites.js restores every template it edits.
    await clearProbes(c);
    for (const id of created.workshops) {
      await c.query("delete from public.workshops where id = $1", [id]).catch(() => {});
    }
  }
});

async function clearProbes(c) {
  // Actions first would be redundant — the FK cascades — but a probe action
  // can also exist with no initiative if a create half-failed.
  await c.query(`delete from public.recommendations where title like '%' || $1 || '%'`, [PROBE]);
  await c.query(`delete from public.initiatives where title like '%' || $1 || '%'`, [PROBE]);
  await c.query(`delete from public.workshops where name like '%' || $1 || '%'`, [PROBE]);
}
