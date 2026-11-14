// The participant flow — capture, theme and prioritise one category at a time.
//
// UAT asked for a flow a room can follow without being taught the methodology:
// Stage 1 is Strengths and everything done to strengths happens there, then
// Stage 2, and so on, with the TOWS matrix as Stage 5. Prioritization, Theme
// Analysis and Insight Generation leave everybody's navigation but a
// facilitator's.
//
// TWO KINDS OF CHECK HERE, because the change has two kinds of risk.
//
// The SOURCE checks exist for the same reason board-ui.js and brand-display.js
// read source: hiding a stage is a RENDERING decision, and every endpoint
// involved was correct before and after. An API suite would have reported this
// whole feature healthy while a participant still saw ten stages in the nav.
// They also pin the rule to ONE module, because the defect this shape produces
// is two surfaces disagreeing about what is visible.
//
// The API checks exist because the rest of it is a claim about CONFIG: that a
// theme became rateable 1-5 by participants with no Go written, that the scale
// is enforced from the definition, and that a role not in `allowed_roles` is
// refused. Those are only true if the real database says so.
import fs from "node:fs";
import path from "node:path";
import { runSuite, clients } from "../lib/harness.js";

const SRC = (p) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");

/**
 * The same file with comments removed.
 *
 * Needed because the checks below ask "does this module NAME a methodology?",
 * and the modules explain at length WHY they must not — so matching the raw
 * text failed on the prose arguing for the property it was testing. A check
 * that cannot tell an identifier from an explanation is testing the comments.
 *
 * Crude on purpose: there is no `//` inside a string literal in these files,
 * and a parser here would be more machinery than the question deserves.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

// Rated from two roles, which SWOT-TOWS's own weight deliberately forbids —
// see the section that uses it for why it has to be a separate definition.
const PROBE_WEIGHT = "flow_probe_rating";

runSuite("participant-flow", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { participant: P, facilitator: F, analyst: A } =
    await clients(baseUrl, ["participant", "facilitator", "analyst"]);

  // An interrupted earlier run can leave the probe definition behind, and it
  // would then be read by the checks below as though it were configuration.
  // Cleared on START as well as in `finally`, the way genericity.js does.
  await c.query(`delete from public.weights where weight_key = $1`, [PROBE_WEIGHT]);
  await c.query(`delete from public.methodology_weights where key = $1`, [PROBE_WEIGHT]);

  const created = { syntheses: [] };

  try {
    // ================================================================
    // The rule lives in one module
    // ================================================================
    r.section("the visibility rule is stated once");

    const stages = SRC("lib/stages.ts");
    r.ok(stages.includes("export function visibleStages("),
      "src/lib/stages.ts owns visibleStages");
    r.ok(stages.includes("export function stageAsideFromFlow("),
      "and the marker for a stage outside the flow");
    r.ok(stages.includes("export function splitStages("),
      "and the one partition into the flow and the facilitator's tools");
    r.ok(stages.includes("export function synthesisWeightKeys("),
      "and which weights a synthesize stage declares");

    // ONE PASS, ONE PUSH SITE — which is what makes "a stage is in exactly one
    // of the two lists" true BY CONSTRUCTION rather than by both filters
    // agreeing. Two filters over the same predicate is two places for the rule
    // to drift, and the failure is a stage in NEITHER list: reachable by URL,
    // listed nowhere, which is the shape of every "rendered and wired to
    // nothing" defect in this project. So this asserts the structure, not a
    // spelling: if the split is ever rewritten as a pair of filters, this goes
    // red on purpose.
    const splitBody = code(stages).slice(
      code(stages).indexOf("export function splitStages("),
      code(stages).indexOf("export function firstStageFor("),
    );
    r.ok((splitBody.match(/for \(/g) ?? []).length === 1,
      "the split walks the visible stages exactly once",
      `${(splitBody.match(/for \(/g) ?? []).length} loops`);
    r.ok((splitBody.match(/\.push\(/g) ?? []).length === 1,
      "...with a single push site, so nothing can land in neither list or both",
      `${(splitBody.match(/\.push\(/g) ?? []).length} pushes`);
    r.ok(/visibleStages\(/.test(splitBody),
      "...over the role-filtered list, not the methodology's whole set");

    // READ FROM CONFIG, NOT NAMED. A stage key or a methodology name here
    // would make the flow SWOT-TOWS knowledge in the platform engine, which
    // is the one thing this codebase forbids throughout.
    r.ok(stages.includes('stage.config["visible_to_roles"]'),
      "the rule reads visible_to_roles from stage config");
    // Checked against CODE, not prose: the module argues at length for this
    // very property, so the words appear in its comments by design.
    const stagesCode = code(stages).toLowerCase();
    for (const forbidden of ["swot", "prioritization", "theme_generation", "insight_generation"]) {
      r.ok(!stagesCode.includes(forbidden),
        `stages.ts never names ${forbidden} in code`);
    }

    r.section("every surface that lists stages goes through it");

    const shell = SRC("components/methodology/StageShell.tsx");
    r.ok(shell.includes("splitStages(workshop.methodology.stages, workshop.my_role)"),
      "the stage header takes its nav from the one partition");
    r.ok(shell.includes("stageAsideFromFlow(s)"),
      "and still marks a stage outside the participant flow when it shows one");
    // The real assertion: the unfiltered list is no longer reachable. A
    // `.stages.map(` left anywhere here is the bug coming back.
    r.ok(!/methodology\.stages\.map\(/.test(shell),
      "the header no longer maps the unfiltered stage list");

    const overview = SRC("routes/w.$workshopId.overview.tsx");
    r.ok(overview.includes("splitStages("),
      "the workshop overview reads the same partition");
    r.ok(!/methodology\.stages\.map\(/.test(overview),
      "the overview no longer maps the unfiltered list");
    // A count of ten above a list of six reads as a rendering fault.
    r.ok(/\$\{flowStages\.length\}/.test(overview),
      "and counts what the caller can actually reach");

    const search = SRC("components/GlobalSearch.tsx");
    r.ok(search.includes("visibleStages(d.methodology.stages, d.my_role)"),
      "search obeys the rule too — it is how somebody finds a hidden screen");

    // ================================================================
    // The tools are a SECOND LIST, not a styled member of the first
    // ================================================================
    //
    // UAT 2026-11-14: "take the orphaned Stage 7 (Recommendations) to Stage 10
    // (Insight Generation) from the Stages panel and put it in the Overview
    // page. Create a button to the Overview page for the Facilitator."
    //
    // Marking them in place was the previous answer and it only explained the
    // numbering. These checks READ SOURCE, because the API was correct
    // throughout both versions: every one of those stages returned the right
    // data before and after, and WHERE a correct list is drawn is invisible to
    // an HTTP check. Six UAT reports in this project have turned out to be
    // exactly that.
    r.section("the facilitator's tools have a panel of their own");

    r.ok(/title="Facilitator tools"/.test(overview),
      "the overview carries a tools panel");
    r.ok(/stages=\{flowStages\}/.test(overview) && /stages=\{toolStages\}/.test(overview),
      "the Stages panel gets the flow and the tools panel gets the tools");
    // ABSENT, NOT EMPTY, for the other seven methodologies — a titled panel
    // with nothing in it reads as something that failed to load.
    r.ok(/toolStages\.length > 0 &&/.test(code(overview)),
      "and it does not render at all when the methodology declares no tool stage");
    // The dash answered "why does this list run past everybody else's?". In a
    // list of nothing but tools, under a heading that has already said so,
    // every tile dashed is every tile unmarked.
    r.ok(/markAside=\{false\}/.test(overview),
      "the tools are not each dashed as well as grouped and labelled");

    // A TILE MUST NOT SAY "NOT STARTED" ABOUT A STAGE WITH FIVE NOTES IN IT.
    // The statuses are a SECOND request and `activity?.status ?? "not_started"`
    // read an absent answer as a negative one, so every tile on this panel
    // claimed the stage was untouched until it landed — on a workshop whose
    // API was reporting nine of its ten stages in progress with real counts.
    // ABSENT IS HONEST, A GUESS IS NOT, which is the rule the presence dot
    // already follows when the socket is down. Found by photographing the
    // panel; nothing in the API could see it.
    const list = SRC("components/methodology/StageList.tsx");
    r.ok(/statusKnown/.test(list),
      "the stage list knows whether the statuses have arrived");
    r.ok(/statusKnown \? \(/.test(code(list)),
      "...and withholds the status rather than defaulting it to Not started");
    r.ok((code(overview).match(/statusKnown=\{activitiesQuery\.isSuccess\}/g) ?? []).length === 2,
      "...and BOTH panels are told, not just the one that was being looked at",
      `${(code(overview).match(/statusKnown=/g) ?? []).length} panels told`);

    // THE STRIP IS THE FLOW NOW. Leaving them inline above every stage would
    // have moved the clutter rather than removed it.
    r.ok(/navStages\.map\(/.test(code(shell)),
      "the stage strip draws the flow, not everything the role may see");
    // ...BUT THE STAGE YOU ARE ON IS ALWAYS IN IT. `visible_to_roles` is an
    // affordance and a pasted URL still opens, so a facilitator sent straight
    // to Theme Analysis must not land on a strip with nothing highlighted and
    // no way back into the flow.
    r.ok(/tools\.some\(\(s\) => s\.key === stage\.key\)/.test(code(shell)),
      "...plus the current stage when that stage is one of the tools");

    // THE BUTTON. The workshop's name has linked here since the redirect into
    // stage 1 landed, but it reads as a breadcrumb — where you are, not
    // somewhere to go — and now that the tools live on that page the route to
    // them has to look like one.
    r.ok(/<LayoutPanelLeft/.test(shell) && />\s*Overview\s*</.test(shell),
      "the stage header carries a labelled Overview control");
    // It is a CONTROL, beside Review mode, not a third breadcrumb. The two
    // existing links on the workshop's name stay — this adds one, and the
    // count is asserted so the slice below cannot silently anchor on the wrong
    // element the way a bare indexOf would.
    const shellCode = code(shell);
    const overviewLinks = (shellCode.match(/to="\/w\/\$workshopId\/overview"/g) ?? []).length;
    r.ok(overviewLinks === 3,
      "...alongside the two breadcrumbs on the workshop's name, not replacing them",
      `${overviewLinks} links to the overview`);
    // NOT FACILITATOR-ONLY: the overview is also the only route to the roster,
    // the objective and the archived-workshop notice. Gating the button would
    // leave a participant reaching that page only through a link that does not
    // look like one. Asserted over the WHOLE file, which is the stronger claim
    // and needs no fragile window: this shell branches on no role at all — the
    // only thing it asks about one is which stages to list.
    const roleGates = (shellCode.match(/my_role/g) ?? []).length;
    r.ok(roleGates === 1 && /splitStages\([^)]*my_role\)/.test(shellCode),
      "...and the shell asks about the caller's role for one thing only: the stage list",
      `${roleGates} mentions of my_role`);

    r.section("the board reads its weight from config, never by name");

    const board = SRC("components/methodology/CaptureBoard.tsx");
    r.ok(board.includes("synthesisWeightKeys(methodology.stages)"),
      "the board asks the methodology which theme weights exist");
    r.ok(board.includes('d.applies_to === "synthesis"'),
      "and resolves them against synthesis-applicable definitions");
    // THE SAME BUG THE WEIGHTS PACKAGE FORBIDS. A literal key here would make
    // the rating SWOT-specific exactly as a literal 'vote' would.
    const srcTree = ["components/methodology/CaptureBoard.tsx",
      "components/methodology/ThemeRating.tsx", "lib/stages.ts"];
    for (const f of srcTree) {
      r.ok(!code(SRC(f)).includes("theme_priority"),
        `${f} does not hardcode the weight key`);
    }
    const rating = SRC("components/methodology/ThemeRating.tsx");
    r.ok(rating.includes("definition.per_participant"),
      "the rater count is shown only for a per-participant weight");
    r.ok(rating.includes("definition.allowed_roles"),
      "and who may rate is described from the definition");
    // THE SCALE IS DELEGATED, which is the property that matters.
    //
    // The first version of this check looked for a literal 5 anywhere in the
    // file and failed on Tailwind's `mt-1.5` — a check that could never go
    // green and said nothing about the scale. What actually protects the
    // range is that the control is `WeightControl`, which already forbids
    // assuming one and which weights.js drives at 0-100 and -3..+3. So the
    // assertion is that this file builds no scale of its own.
    r.ok(rating.includes("<WeightControl"),
      "the rating renders through WeightControl rather than its own scale");
    r.ok(!/scale_(min|max|step)/.test(code(rating)),
      "and reads no bound itself — the control owns the range");

    r.section("the order is signposted, not locked");
    r.ok(board.includes("type FlowStep ="), "the three-step readout exists");
    // IT COUNTS WHAT THE PANEL DRAWS. The first version walked the theme list
    // itself and reported "THEME 3" over a panel showing two — a factor is in
    // exactly one stack on screen, so a theme whose members were regrouped
    // elsewhere still cites the category but is not rendered. Counting from
    // `blocksFor` makes the readout and the panel agree by construction.
    r.ok(/blocksFor\(focusedKey\)/.test(code(board).slice(
      code(board).indexOf("const flowSteps"),
      code(board).indexOf("const flatOrder"))),
      "the readout counts the blocks the panel renders");
    r.ok(!/themesQuery\.data[\s\S]{0,200}?flowSteps/.test(code(board)),
      "and does not walk the theme list in parallel");
    // DISTINCT FACTORS, not tiles. Two themes may cite one factor — nothing
    // forbids it and `synthesis_factors` is many-to-many — so the panel can
    // draw the same note twice. Measured on the demo board: six tiles for
    // five strengths. Counting tiles told the room it had captured one more
    // strength than it had.
    const flowBlock = code(board).slice(
      code(board).indexOf("const flowSteps"), code(board).indexOf("const flatOrder"));
    r.ok(/new Set<string>\(\)/.test(flowBlock),
      "the capture figure counts distinct factors, not rendered tiles");
    r.ok(/category_key === focusedKey/.test(flowBlock),
      "and only this stage's category — a theme may span categories");
    // Derived, never stored. A stored phase would be a new column, a new
    // endpoint and a rule a live room could not step back from.
    r.ok(!/stage_phase|advancePhase|setPhase/.test(board),
      "no stored phase — nothing gates the controls");

    // ================================================================
    // The configuration is real
    // ================================================================
    r.section("the participant flow is numbered the way the room says it");

    const wsF = (await F("GET", `/workshops/${WS}`)).data;
    const all = wsF.methodology.stages;
    const seqOf = (key) => all.find((s) => s.key === key)?.sequence_number;

    r.ok(seqOf("strength_discovery") === 1, "Strength Discovery is 1", seqOf("strength_discovery"));
    r.ok(seqOf("weakness_discovery") === 2, "Weakness Discovery is 2", seqOf("weakness_discovery"));
    r.ok(seqOf("opportunity_discovery") === 3, "Opportunity Discovery is 3", seqOf("opportunity_discovery"));
    r.ok(seqOf("threat_discovery") === 4, "Threat Discovery is 4", seqOf("threat_discovery"));
    r.ok(seqOf("tows_analysis") === 5, "the TOWS Matrix is 5", seqOf("tows_analysis"));

    const hidden = ["prioritization", "theme_generation", "insight_generation"];
    for (const key of hidden) {
      const s = all.find((x) => x.key === key);
      r.ok(JSON.stringify(s?.config?.visible_to_roles) === '["facilitator"]',
        `${key} is facilitator-only`, JSON.stringify(s?.config?.visible_to_roles));
    }

    // THE RELATIONSHIP, NOT A NUMBER. This read `sequence_number > 7` and was
    // really checking a magic number: Recommendations became facilitator-only
    // with the TOWS work, which moved the flow's last number from 7 to 6, and a
    // correct change would have broken a literal. What has to hold is that the
    // tools sort AFTER the flow — otherwise the numbers on screen stop being
    // the numbers the room says out loud, which is the whole reason
    // 20261106100000 renumbered the stages instead of computing an index.
    const asideSeq = all.filter((s) => s.config?.visible_to_roles).map((s) => s.sequence_number);
    const flowSeq = all.filter((s) => !s.config?.visible_to_roles).map((s) => s.sequence_number);
    r.ok(asideSeq.length > 0 && flowSeq.length > 0,
      "this methodology has both a flow and some tools, so there is something to separate",
      `${flowSeq.length} in the flow, ${asideSeq.length} tools`);
    r.ok(Math.min(...asideSeq) > Math.max(...flowSeq),
      "every facilitator-only stage sorts after every stage the room walks",
      `flow ends at ${Math.max(...flowSeq)}, tools start at ${Math.min(...asideSeq)}`);
    // The flow is a CONTIGUOUS 1..n, or a participant reads a gap as a screen
    // that failed to load.
    r.ok(flowSeq.slice().sort((a, b) => a - b).every((n, i) => n === i + 1),
      "...and the flow itself runs 1..n with no gap",
      flowSeq.slice().sort((a, b) => a - b).join(","));

    // The jsonb merge, asserted rather than assumed: an assignment where a
    // merge was meant would have taken the vote budget with it, and the
    // prioritization stage would silently refuse every allocation.
    const pri = all.find((s) => s.key === "prioritization");
    r.ok(Number(pri?.config?.votes_per_participant) > 0,
      "prioritization kept its vote budget through the config merge",
      pri?.config?.votes_per_participant);

    r.section("a theme is rateable because the methodology says so");

    const theme = all.find((s) => s.key === "theme_generation");
    r.ok(JSON.stringify(theme?.config?.weights) === '["theme_priority"]',
      "Theme Analysis declares the weight its objects carry",
      JSON.stringify(theme?.config?.weights));

    const defs = (await P("GET", `/workshops/${WS}/weights`)).data.definitions;
    const tp = defs.find((d) => d.key === "theme_priority");
    r.ok(Boolean(tp), "the theme weight is defined");
    r.ok(tp?.applies_to === "synthesis", "it applies to a synthesis", tp?.applies_to);
    r.ok(Number(tp?.scale_min) === 1 && Number(tp?.scale_max) === 5,
      "on a 1-5 scale", `${tp?.scale_min}-${tp?.scale_max}`);
    r.ok(tp?.aggregate === "mean", "aggregated as a mean", tp?.aggregate);
    r.ok(tp?.per_participant === true, "one rating per person", tp?.per_participant);
    r.ok(JSON.stringify(tp?.allowed_roles) === '["participant"]',
      "participants only — the facilitator decides when rating stops",
      JSON.stringify(tp?.allowed_roles));

    // ================================================================
    // It actually works, end to end, with no Go written for it
    // ================================================================
    r.section("a participant rates a theme through the generic weights route");

    const factors = (await P("GET", `/workshops/${WS}/factors`)).data;
    const strengths = factors.filter((f) => f.category_key === "strength").slice(0, 2);
    const mk = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "flow-probe theme",
      evidence: { factor: strengths.map((f) => f.id) },
    });
    r.ok(mk.success, "a theme to rate", mk.error?.message);
    if (mk.data) created.syntheses.push(mk.data.id);
    const T = mk.data?.id;

    let set = await P("PUT", `/workshops/${WS}/syntheses/${T}/weights/theme_priority`,
      { value: 4 });
    r.ok(set.success, "a participant may rate it 4", set.error?.message);

    let w = (await P("GET", `/workshops/${WS}/weights`)).data;
    const total = w.totals.find((t) => t.object_id === T && t.weight_key === "theme_priority");
    r.ok(Number(total?.value) === 4, "the group figure is 4", total?.value);
    // TWO NUMBERS, NEVER ONE — the rule the leaderboard and the report follow.
    // A figure with no backing reads as agreement when one person produced it.
    r.ok(Number(total?.voters) === 1, "and it says one person is behind it", total?.voters);
    r.ok(Number(w.mine.find((v) => v.object_id === T)?.value) === 4,
      "the participant's own rating comes back to them");

    r.section("the scale is enforced from the definition, not from the client");
    for (const bad of [0, 6, 2.5]) {
      const refused = await P("PUT", `/workshops/${WS}/syntheses/${T}/weights/theme_priority`,
        { value: bad });
      r.ok(!refused.success, `${bad} is refused`, refused.error?.message ?? "accepted");
    }

    r.section("a role outside allowed_roles is refused");
    // THE ASSERTION THAT CATCHES SOMEBODY WIDENING THE ROLES. The facilitator
    // is a full member with every other permission on this workshop, so a
    // refusal here can only come from allowed_roles.
    const asFac = await F("PUT", `/workshops/${WS}/syntheses/${T}/weights/theme_priority`,
      { value: 5 });
    r.ok(!asFac.success, "a facilitator may not rate a theme", asFac.error?.message ?? "accepted");
    const asAnalyst = await A("PUT", `/workshops/${WS}/syntheses/${T}/weights/theme_priority`,
      { value: 5 });
    r.ok(!asAnalyst.success, "nor an analyst", asAnalyst.error?.message ?? "accepted");
    // And the refusal did not quietly record anything.
    w = (await F("GET", `/workshops/${WS}/weights`)).data;
    r.ok(Number(w.totals.find((t) => t.object_id === T)?.voters) === 1,
      "the refused ratings left the figure alone",
      w.totals.find((t) => t.object_id === T)?.voters);

    r.section("the mean is a mean, across two real people");
    // SWOT-TOWS's own weight allows one role, so a two-rater average cannot be
    // driven through it — and asserting `aggregate === 'mean'` alone would pass
    // just as happily if the engine summed, because a mean and a sum are the
    // same number for one rater. So a probe definition allowing two roles is
    // inserted, driven, and removed. See [[tests-that-pass-for-the-wrong-reason]].
    const mid = (await c.query(
      `select id from public.methodologies where key = 'swot-tows'`)).rows[0].id;
    await c.query(
      `insert into public.methodology_weights
         (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step,
          constraint_type, per_participant, aggregate, allowed_roles, sort_order)
       values ($1, $2, 'Flow probe rating', 'synthesis', 1, 5, 1,
               'single', true, 'mean', array['participant','facilitator'], 99)`,
      [mid, PROBE_WEIGHT]);

    const a = await P("PUT", `/workshops/${WS}/syntheses/${T}/weights/${PROBE_WEIGHT}`, { value: 2 });
    const b = await F("PUT", `/workshops/${WS}/syntheses/${T}/weights/${PROBE_WEIGHT}`, { value: 4 });
    r.ok(a.success && b.success, "two people rate the same theme 2 and 4",
      a.error?.message ?? b.error?.message);

    w = (await P("GET", `/workshops/${WS}/weights`)).data;
    const probe = w.totals.find((t) => t.object_id === T && t.weight_key === PROBE_WEIGHT);
    r.ok(Number(probe?.value) === 3,
      "the group figure is 3 — the mean, not the sum of 6", probe?.value);
    r.ok(Number(probe?.voters) === 2, "from two raters", probe?.voters);

    r.section("no other methodology was touched");
    // The genericity claim at its narrowest: this change was SWOT-TOWS config,
    // and genericity.js drives PESTLE through every surface to prove the
    // broader version.
    const leaked = await c.query(
      `select m.key from public.methodology_stages ms
         join public.methodologies m on m.id = ms.methodology_id
        where ms.config ? 'visible_to_roles' and m.key <> 'swot-tows'`);
    r.ok(leaked.rowCount === 0,
      "visible_to_roles appears in no other methodology",
      leaked.rows.map((x) => x.key).join(", "));

    const weightLeak = await c.query(
      `select m.key from public.methodology_weights mw
         join public.methodologies m on m.id = mw.methodology_id
        where mw.key = 'theme_priority' and m.key <> 'swot-tows'`);
    r.ok(weightLeak.rowCount === 0, "nor does the theme weight",
      weightLeak.rows.map((x) => x.key).join(", "));

    // Five Forces has rated a synthesis since 2026-09-20 with a DIFFERENT
    // shape — one agreed value, latest wins, facilitator and analyst. Two
    // unlike weights on one object kind is the engine being general, and the
    // first version of the migration's own check mistook it for a leak.
    const ff = await c.query(
      `select mw.per_participant, mw.aggregate from public.methodology_weights mw
         join public.methodologies m on m.id = mw.methodology_id
        where m.key = 'five-forces' and mw.applies_to = 'synthesis'`);
    r.ok(ff.rowCount === 1 && ff.rows[0].per_participant === false
      && ff.rows[0].aggregate === "latest",
      "Five Forces still rates a synthesis its own way",
      JSON.stringify(ff.rows[0] ?? null));

    // ================================================================
    r.section("a stage's progress is derived; only completion is stored");
    // ================================================================
    //
    // `activities.status` was written ONCE at workshop creation and never
    // updated, so every stage read NOT STARTED forever and App Spec §8.30's
    // gate on completing a workshop could never be satisfied by anything. The
    // split now: not_started vs in_progress is computed from content every
    // time, and `completed` is a facilitator's decision.
    //
    // THE DEMO WORKSHOP HAS FACTORS, so its capture stages must read
    // in_progress. Asserting that rather than a particular stage key, because
    // a count is what the status is derived FROM and the suite should fail if
    // the derivation stops happening — not if somebody renames a stage.
    const acts = await F("GET", `/workshops/${WS}/activities`);
    r.ok(acts.success && acts.data?.length > 0, "activities list loads",
      acts.success ? `n=${acts.data.length}` : acts.error?.message);

    // GUARDED, because the three checks below are all `every(...)` over a
    // filtered list and EVERY ONE OF THEM PASSES VACUOUSLY on an empty array.
    // The first version did exactly that: the endpoint 500'd, the list was
    // empty, and two checks reported PASS underneath the failure. That is the
    // shape CLAUDE.md warns about — read the reason, not the PASS.
    const rows = acts.success ? (acts.data ?? []) : [];
    const withContent = rows.filter((a) => a.content_count > 0);
    r.ok(withContent.length > 0,
      "some stages have content in the demo workshop", withContent.length);
    r.ok(withContent.length > 0 && withContent.every((a) => a.status !== "not_started"),
      "...and NONE of those still reads not_started — the reported defect",
      withContent.map((a) => `${a.stage_key}=${a.status}(${a.content_count})`).join(" ") || "nothing to check");

    // The paired negative: an empty stage must still read not_started, or
    // "derived" has quietly become "everything is in progress".
    const empty = rows.filter((a) => a.content_count === 0);
    r.ok(rows.length > 0 &&
      empty.every((a) => a.status === "not_started" || a.marked_complete),
      "an empty stage reads not_started unless a facilitator closed it",
      empty.map((a) => `${a.stage_key}=${a.status}`).join(" ") || "none empty");

    const target = rows[0];
    if (!target) {
      // Say so once, rather than throwing an undefined-property error that
      // reads like a bug in the endpoint under test.
      r.ok(false, "a stage to open and close (skipping the rest of this section)");
      return;
    }
    const wasComplete = target.marked_complete;

    // CLOSING A STAGE IS A BOUNDARY, not an affordance — it feeds the health
    // score, the executive dashboard and the §8.30 gate. Unlike
    // `visible_to_roles`, which only removes clutter and is deliberately
    // bypassable by pasting a URL.
    const closeAsParticipant = await P("PUT",
      `/workshops/${WS}/stages/${target.stage_key}/complete`, { complete: true });
    r.ok(!closeAsParticipant.success, "a participant cannot close a stage",
      closeAsParticipant.error?.message);
    const closeAsAnalyst = await A("PUT",
      `/workshops/${WS}/stages/${target.stage_key}/complete`, { complete: true });
    r.ok(!closeAsAnalyst.success, "nor can an analyst", closeAsAnalyst.error?.message);

    // ABSENT IS NOT FALSE. As a plain bool, a request that forgot the field
    // would silently reopen a stage the facilitator meant to close — the same
    // reason reviewAIBody.Index had to become a pointer.
    const noField = await F("PUT", `/workshops/${WS}/stages/${target.stage_key}/complete`, {});
    r.ok(!noField.success, "a request with no `complete` field is refused, not read as false",
      noField.error?.message);

    const closed = await F("PUT",
      `/workshops/${WS}/stages/${target.stage_key}/complete`, { complete: true });
    r.ok(closed.success, "a facilitator closes it", closed.error?.message);
    const after = await F("GET", `/workshops/${WS}/activities`);
    const closedRow = after.data?.find((a) => a.stage_key === target.stage_key);
    r.ok(closedRow?.status === "completed" && closedRow?.marked_complete === true,
      "...and it reads completed, with the decision distinguishable from the derivation",
      `${closedRow?.status}/${closedRow?.marked_complete}`);

    // REOPENABLE ON PURPOSE: a theme regularly sends a facilitator back to
    // capture, and a one-way gate would make that impossible.
    const reopened = await F("PUT",
      `/workshops/${WS}/stages/${target.stage_key}/complete`, { complete: false });
    r.ok(reopened.success, "and can reopen it", reopened.error?.message);
    const back = (await F("GET", `/workshops/${WS}/activities`))
      .data?.find((a) => a.stage_key === target.stage_key);
    r.ok(back?.marked_complete === false && back?.status !== "completed",
      "...which returns the stage to its derived status",
      `${back?.status}/${back?.marked_complete}`);

    // Leave the workshop as it was found: this suite shares a database.
    if (wasComplete) {
      await F("PUT", `/workshops/${WS}/stages/${target.stage_key}/complete`, { complete: true });
    }

    const unknown = await F("PUT", `/workshops/${WS}/stages/no-such-stage/complete`,
      { complete: true });
    r.ok(!unknown.success && unknown.error?.code === "NOT_FOUND",
      "an unknown stage key is a 404", unknown.error?.message);
  } finally {
    await c.query(`delete from public.weights where weight_key = $1`, [PROBE_WEIGHT]);
    await c.query(`delete from public.methodology_weights where key = $1`, [PROBE_WEIGHT]);
    if (created.syntheses.length) {
      await c.query(`delete from public.weights where object_id = any($1)`, [created.syntheses]);
      await c.query(`delete from public.syntheses where id = any($1)`, [created.syntheses]);
    }
  }
});
