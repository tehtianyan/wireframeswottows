// Where a workshop has got to, and what keeps coming up across several.
//
// UAT 2026-11-14 asked for three things that are all the same question seen
// from different distances:
//
//   - the Metrics panel should track outstanding participant actions, show
//     the themes once SWOT is done and the initiatives and actions once TOWS
//     is, with a reading of each;
//   - "Summarize the Workshop" should give a facilitator, at a coffee break,
//     the outstanding items and directly actionable next steps;
//   - the Dashboard should show commonalities across workshops.
//
// ONE ANSWER, THREE READERS. `loadWorkshopStanding` serves the panel and the
// AI context from the same function, because computing it twice is how the
// screen and the assistant come to describe the same workshop differently in
// front of a room.
//
// THE COUNTS ARE ASSERTED HERE; THE READING IS NOT. "Emerging properties" and
// "strategic projects" are judgements, and this product puts judgements
// through the assistant under review rather than printing them as status —
// so what this suite can check is that the arithmetic is right and that the
// assistant is GIVEN the facts it was previously inventing from.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite, clients, cleanup } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = (...p) => fs.readFileSync(path.join(ROOT, "src", ...p), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const PREFIX = "STANDING probe";

runSuite("standing", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P } = await clients(baseUrl, ["facilitator", "participant"]);
  const made = { recommendations: [], initiatives: [] };

  try {
    // ================================================================
    r.section("the overview is told where the room has got to");
    // ================================================================
    const summary = await F("GET", `/workshops/${WS}/summary`);
    r.ok(summary.success, "the summary loads", summary.error?.message);
    const st = summary.data?.standing;
    r.ok(Boolean(st), "...and carries the standing", st ? "present" : "ABSENT");
    if (!st) return;

    // DERIVED, NOT STORED. `activities.status` was written once at creation
    // and never updated, with four readers on top — so a stage's progress has
    // to be computed from content every time.
    r.ok(Array.isArray(st.stages) && st.stages.length > 0,
      "every stage is reported", `${st.stages.length} stages`);
    r.ok(st.stages.every((s) => ["not_started", "in_progress", "completed"].includes(s.status)),
      "...each with a status from the one vocabulary",
      [...new Set(st.stages.map((s) => s.status))].join(", "));

    // A stage only the facilitator is shown is a TOOL, not a step the room is
    // behind on — a summary that chases them to finish one would be chasing
    // them to do something they were never shown.
    const detail = (await F("GET", `/workshops/${WS}`)).data;
    const hiddenKeys = (detail.methodology.stages ?? [])
      .filter((s) => {
        const roles = s.config?.visible_to_roles;
        return Array.isArray(roles) && roles.length > 0 && !roles.includes("participant");
      })
      .map((s) => s.key);
    if (hiddenKeys.length > 0) {
      const flagged = st.stages.filter((s) => s.facilitator_only).map((s) => s.key);
      r.ok(
        hiddenKeys.every((k) => flagged.includes(k)),
        "a facilitator-only stage is marked as a tool, not as a step the room is behind on",
        `config hides ${hiddenKeys.join(",")}; standing flags ${flagged.join(",") || "none"}`,
      );
    } else {
      r.skip("this methodology hides no stages, so there is nothing to flag");
    }

    // ---- the action readout ----
    //
    // TWO NUMBERS, NOT ONE. "12 actions" reads as twelve pieces of work
    // somebody is doing; twelve with three owners is the finding a
    // facilitator has to act on before everybody leaves the room.
    r.ok(Array.isArray(st.actions), "the actions are listed, not just counted");
    r.ok(typeof st.actions_unowned === "number",
      "...with how many have nobody's name on them", st.actions_unowned);
    const reallyUnowned = st.actions.filter((a) => !a.owner).length;
    r.ok(st.actions_unowned === reallyUnowned,
      "...and that count matches the list rather than being computed twice",
      `${st.actions_unowned} vs ${reallyUnowned}`);
    r.ok(st.actions.every((a) => typeof a.state === "string" && a.state !== ""),
      "every action reports a RESOLVED delivery column, never an empty key",
      st.actions.map((a) => a.state).join("|") || "none");

    // The roster figure is the denominator the room needs: three contributors
    // out of twelve is the finding, not the twelve.
    r.ok(st.participants >= st.contributed,
      "contributors cannot exceed the roster",
      `${st.contributed} of ${st.participants}`);

    // ---- it reacts to real work ----
    const groupId = st.actions[0]?.group ? undefined : undefined;
    void groupId;
    const before = st.actions.length;
    const added = await F("POST", `/workshops/${WS}/recommendations`, {
      title: `${PREFIX} an unowned action`,
      fields: { priority: "low" },
      evidence: {},
    });
    if (added.success) made.recommendations.push(added.data.id);
    const after = (await F("GET", `/workshops/${WS}/summary`)).data?.standing;
    r.ok(after.actions.length === before + 1,
      "a new action appears in the standing", `${before} -> ${after.actions.length}`);
    r.ok(after.actions_unowned === st.actions_unowned + 1,
      "...and counts as unowned until somebody is named",
      `${st.actions_unowned} -> ${after.actions_unowned}`);

    // ================================================================
    r.section("the break-time summary is GIVEN the facts, not left to infer them");
    // ================================================================
    //
    // The old prompt asked for incomplete items "from the supplied activity
    // status" and the context carried no activity status at all — so
    // `incomplete_items` was inference from content dressed as a finding.
    const prompts = await c.query(
      `select p.output_schema, p.prompt_template, p.output_kind
       from public.methodology_ai_prompts p
       where p.function_key = 'workshop_summary'`);
    r.ok(prompts.rows.length > 0, "the summary prompt is seeded", prompts.rows.length);
    r.ok(prompts.rows.every((row) => row.output_schema?.summary?.next_steps !== undefined),
      "every methodology's copy declares the next_steps the facilitator asked for",
      prompts.rows.filter((row) => row.output_schema?.summary?.next_steps === undefined).length +
        " still on the old schema");
    r.ok(prompts.rows.every((row) => row.output_kind === "narrative"),
      "...and it stays something to READ, not suggestions to accept");
    // THE DOUBLE COUNT THIS PROMPT HAD TO BE TOLD ABOUT. A real run reported
    // "2 strength factors awaiting review" AND "2 notes awaiting review" —
    // the same two items — and a facilitator reading both would act as
    // though four were waiting.
    r.ok(prompts.rows.every((row) => /awaiting_review is the ONLY authority/i.test(row.prompt_template)),
      "...and names one authority for the review queues, so items are not counted twice");

    // ================================================================
    r.section("what keeps coming up across workshops");
    // ================================================================
    const dash = await F("GET", "/dashboard");
    r.ok(dash.success && Array.isArray(dash.data.commonalities),
      "the dashboard carries the roll-up", dash.error?.message);
    const rollup = dash.data.commonalities ?? [];

    // TWO WORKSHOPS IS THE WHOLE POINT. A term in one workshop is that
    // workshop's content, and reporting it would fill the panel with noise.
    r.ok(rollup.every((cm) => cm.workshops.length >= 2),
      "nothing is reported as common to a single workshop",
      rollup.filter((cm) => cm.workshops.length < 2).map((cm) => cm.term).join(", ") || "none");

    // NAMED AND QUOTED. "Four workshops" invites "which?", and a term shown
    // without the words it came from is a statistic rather than a finding.
    r.ok(rollup.every((cm) => cm.workshops.every((w) => w.id && w.name && w.example)),
      "each workshop is named and quotes something it actually said");

    // Ranked by how many workshops raised it, then by how often — a term in
    // four workshops is a stronger finding than one mentioned forty times in
    // two, which is the "two numbers, never one" rule on a different pair.
    const ordered = rollup.every((cm, i) =>
      i === 0 || rollup[i - 1].workshops.length >= cm.workshops.length);
    r.ok(ordered, "ranked by how many workshops raised it",
      rollup.map((cm) => `${cm.term}:${cm.workshops.length}`).join(" "));

    // Stop words would otherwise dominate any list of shared words.
    r.ok(!rollup.some((cm) => ["the", "and", "with", "for", "our"].includes(cm.term.toLowerCase())),
      "and the words that say nothing are not reported");

    // A PARTICIPANT SEES THEIR OWN. The roll-up is per caller, so somebody in
    // one workshop has nothing to compare and must get an empty list rather
    // than the facilitator's.
    const pDash = await P("GET", "/dashboard");
    const pRollup = pDash.data?.commonalities ?? [];
    const pWorkshops = (pDash.data?.workshops ?? []).map((w) => w.id);
    const strayed = pRollup.flatMap((cm) => cm.workshops.map((w) => w.id))
      .filter((id) => !pWorkshops.includes(id));
    r.ok(strayed.length === 0,
      "a participant's roll-up names only workshops they are in",
      `${pRollup.length} terms, ${strayed.length} foreign workshops`);

    // ================================================================
    r.section("the panel on screen (source — the API is right either way)");
    // ================================================================
    //
    // Read from SOURCE, like shell-ui.js: where a correct number is PUT is
    // invisible to an HTTP check, and six UAT reports in this project have
    // turned out to be exactly that.
    const overview = code(SRC("routes", "w.$workshopId.overview.tsx"));
    r.ok(/summary\.standing &&/.test(overview),
      "the overview draws the standing only when the server sent one");
    // A panel of empty rows on a workshop that has not started reads as a
    // form somebody failed to fill in.
    r.ok(/standing\.actions\.length > 0/.test(overview) && /standing\.themes > 0/.test(overview),
      "...and each row appears only when its work does");
    // The two-numbers rule, on the screen as well as in the data.
    r.ok(/of \{standing\.actions\.length\} have an owner/.test(overview),
      "the actions row shows how many have an owner, not just how many there are");
    r.ok(/of \{standing\.participants\} on the roster/.test(overview),
      "...and the roster figure carries its denominator");

    const dashSrc = code(SRC("routes", "index.tsx"));
    r.ok(/data\.commonalities\.length > 0/.test(dashSrc),
      "the dashboard panel appears only when there IS a commonality");
    r.ok(/\{c\.workshops\.length\} workshops · \{c\.mentions\} mentions/.test(dashSrc),
      "...and shows both numbers, not just a count of workshops");
    r.ok(/w\.example/.test(dashSrc),
      "...and quotes what each workshop said, so the term is never bare");
  } finally {
    await cleanup(c, {
      titlePrefixes: [PREFIX],
      ids: { recommendations: made.recommendations, initiatives: made.initiatives },
    });
    r.note("probe rows removed");
  }
});
