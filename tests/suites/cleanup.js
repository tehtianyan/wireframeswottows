// "Merge and Fix" — the tracked, undoable AI tidy-up of the capture board.
//
// The VALIDATION rules (never merge a cited or voted note, refuse a category
// from another methodology, keep the good changes alongside a bad one) are
// tested where they live, as pure Go, in pkg/handlers/cleanup_plan_test.go.
// They belong there because a safety rule that costs a paid model call to
// exercise is a safety rule nobody exercises.
//
// What this suite covers is everything those tests cannot see: the HTTP
// surface, who is allowed to run and undo, and — the point of the whole
// feature — that an undo really does put the database back.
//
// The apply step is seeded rather than driven by the model, so the suite is
// deterministic and free. Pass --with-ai to also drive one real run end to
// end, which is what proves the seeded shape matches the real one.
import { runSuite, clients, cleanup } from "../lib/harness.js";

const PREFIX = "CLEANUP probe";
const withAI = process.argv.includes("--with-ai");

runSuite("cleanup", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P } = await clients(baseUrl, ["facilitator", "participant"]);
  const made = { factors: [] };
  const seededRuns = [];
  let runId = null;

  const factorById = async (id) =>
    (await c.query("select title, description, state from public.factors where id = $1", [id])).rows[0];
  const categoryOf = async (id) =>
    (
      await c.query(
        `select mfc.key from public.factors f
         join public.methodology_factor_categories mfc on mfc.id = f.factor_category_id
         where f.id = $1`,
        [id],
      )
    ).rows[0].key;

  try {
    // ---- fixtures ------------------------------------------------------
    const mk = async (category, title, description) => {
      const res = await F("POST", `/workshops/${WS}/factors`, {
        category_key: category,
        title: `${PREFIX} ${title}`,
        ...(description ? { description } : {}),
      });
      if (!res.success) throw new Error(`could not create fixture: ${res.error?.message}`);
      made.factors.push(res.data.id);
      return res.data.id;
    };

    const typo = await mk("strength", "brand recognitoin", "Unpromted awareness");
    const dupe = await mk("strength", "our brand is well known");
    const misplaced = await mk("strength", "legacy billing system is slow");

    // A change of each type, applied exactly as the server applies them, with
    // the same before-state shapes undoOne reads back.
    const seedRun = async (changes) => {
      const run = (
        await c.query(
          `insert into public.board_cleanup_runs (workshop_id, stage_key, created_by)
           values ($1, 'strength_discovery', (select created_by from public.factors where id = $2))
           returning id`,
          [WS, typo],
        )
      ).rows[0].id;

      for (const ch of changes) {
        await c.query(
          `insert into public.board_cleanup_changes
             (run_id, change_type, factor_id, before_state, after_state, reason)
           values ($1, $2, $3, $4, $5, $6)`,
          [run, ch.type, ch.factor_id, ch.before, ch.after, ch.reason],
        );
        if (ch.type === "reword") {
          await c.query("update public.factors set title = $2, description = nullif($3,'') where id = $1", [
            ch.factor_id,
            ch.after.title,
            ch.after.description ?? "",
          ]);
        } else if (ch.type === "move") {
          await c.query(
            `update public.factors set factor_category_id =
               (select mfc.id from public.methodology_factor_categories mfc
                join public.workshops w on w.methodology_id = mfc.methodology_id
                where w.id = $2 and mfc.key = $3)
             where id = $1`,
            [ch.factor_id, WS, ch.after.category_key],
          );
        } else if (ch.type === "merge") {
          await c.query("update public.factors set state = 'archived' where id = $1", [ch.factor_id]);
        }
      }
      seededRuns.push(run);
      return run;
    };

    const before = {
      typo: await factorById(typo),
      dupeState: (await factorById(dupe)).state,
      misplacedCategory: await categoryOf(misplaced),
    };

    runId = await seedRun([
      {
        type: "reword",
        factor_id: typo,
        before: { title: before.typo.title, description: before.typo.description ?? "" },
        after: { title: `${PREFIX} brand recognition`, description: "Unprompted awareness" },
        reason: "two spelling mistakes",
      },
      {
        type: "move",
        factor_id: misplaced,
        before: { category_key: before.misplacedCategory },
        after: { category_key: "weakness" },
        reason: "a slow system is a weakness, not a strength",
      },
      {
        type: "merge",
        factor_id: dupe,
        before: { state: before.dupeState },
        after: { state: "archived", merged_into: typo },
        reason: "says the same as the brand note",
      },
    ]);

    // ---- the trail is readable ------------------------------------------
    r.section("the run and its changes are readable through the API");

    let runs = (await F("GET", `/workshops/${WS}/cleanup/runs`)).data;
    let run = runs.find((x) => x.id === runId);
    r.ok(Boolean(run), "the run appears in the workshop's history", run?.id);
    r.ok(run.changes.length === 3, "all three changes are listed", run.changes.length);
    r.ok(
      run.changes.every((ch) => ch.before && Object.keys(ch.before).length > 0),
      "every change carries its before-state — without it there is no undo",
    );
    r.ok(
      run.changes.every((ch) => ch.reason),
      "every change carries the reason it was made, so it can be judged",
    );

    // A participant is not the facilitator, but the trail is not a secret:
    // transparency is the point of the feature.
    const asParticipant = await P("GET", `/workshops/${WS}/cleanup/runs`);
    r.ok(asParticipant.success, "a participant can READ the trail", asParticipant.status);

    // ---- who may run and undo -------------------------------------------
    r.section("tidying the whole board is the facilitator's job");

    const pRun = await P("POST", `/workshops/${WS}/cleanup`, { stage_key: "strength_discovery" });
    r.ok(!pRun.success && pRun.status === 403, "a participant cannot run the tidy-up", pRun.status);

    const pUndo = await P("POST", `/workshops/${WS}/cleanup/changes/${run.changes[0].id}/undo`, {});
    r.ok(!pUndo.success && pUndo.status === 403, "a participant cannot undo a change", pUndo.status);

    const foreign = await F("POST", `/workshops/${WS}/cleanup/runs/00000000-0000-0000-0000-000000000000/undo`, {});
    r.ok(!foreign.success && foreign.status === 404, "an unknown run is a 404, not a 500", foreign.status);

    // ---- undo one change -------------------------------------------------
    r.section("a single change can be undone, exactly");

    const rewordChange = run.changes.find((ch) => ch.change_type === "reword");
    const undo1 = await F("POST", `/workshops/${WS}/cleanup/changes/${rewordChange.id}/undo`, {});
    r.ok(undo1.success && undo1.data.undone === true, "the reword is undone", undo1.status);

    let now = await factorById(typo);
    r.ok(now.title === before.typo.title, "the title is character-for-character what it was", now.title);
    r.ok(
      (now.description ?? "") === (before.typo.description ?? ""),
      "the description came back too — a partial undo would be worse than none",
      now.description,
    );

    // Two facilitators clicking at once must not produce a 500.
    const again = await F("POST", `/workshops/${WS}/cleanup/changes/${rewordChange.id}/undo`, {});
    r.ok(again.success && again.data.undone === false,
      "undoing an already-undone change is a no-op, not an error", again.status);

    runs = (await F("GET", `/workshops/${WS}/cleanup/runs`)).data;
    run = runs.find((x) => x.id === runId);
    r.ok(
      Boolean(run.changes.find((ch) => ch.id === rewordChange.id).undone_at),
      "the change is marked undone rather than deleted, so the record stays honest",
    );

    // ---- undo the whole run ---------------------------------------------
    r.section("the whole run can be undone");

    const undoAll = await F("POST", `/workshops/${WS}/cleanup/runs/${runId}/undo`, {});
    r.ok(undoAll.success, "the run is undone", undoAll.status);
    r.ok(undoAll.data.undone === 2,
      "the two remaining changes were undone; the one already undone was not counted twice",
      undoAll.data.undone);
    r.ok(undoAll.data.refused.length === 0, "nothing was refused", JSON.stringify(undoAll.data.refused));

    r.ok((await categoryOf(misplaced)) === before.misplacedCategory,
      "the moved note is back in its original category", await categoryOf(misplaced));

    const dupeNow = await factorById(dupe);
    r.ok(dupeNow.state === before.dupeState,
      "the merged note is back on the board — it was archived, never deleted", dupeNow.state);

    runs = (await F("GET", `/workshops/${WS}/cleanup/runs`)).data;
    run = runs.find((x) => x.id === runId);
    r.ok(Boolean(run.undone_at), "the run itself is marked undone", run.undone_at);
    r.ok(run.changes.every((ch) => ch.undone_at), "every change is marked undone");

    // ---- a reviewed note is frozen, here as everywhere else --------------
    r.section("an approved note cannot be quietly rewritten by an undo");

    const frozen = await mk("strength", "a note that gets approved");
    const frozenRun = await seedRun([
      {
        type: "reword",
        factor_id: frozen,
        before: { title: `${PREFIX} a note that gets approved`, description: "" },
        after: { title: `${PREFIX} an approved note, reworded`, description: "" },
        reason: "clarity",
      },
    ]);
    await F("POST", `/workshops/${WS}/factors/${frozen}/review`, { action: "approve" });

    const frozenChanges = (await F("GET", `/workshops/${WS}/cleanup/runs`)).data.find(
      (x) => x.id === frozenRun,
    ).changes;
    const refused = await F("POST", `/workshops/${WS}/cleanup/changes/${frozenChanges[0].id}/undo`, {});
    r.ok(!refused.success && refused.status === 409,
      "undoing into an approved note is refused — an approval must keep meaning the text that was approved",
      refused.error?.message);
    r.ok(/Review Board/.test(refused.error?.message ?? ""),
      "and it says where to make the correction instead", refused.error?.message);

    const runRefused = await F("POST", `/workshops/${WS}/cleanup/runs/${frozenRun}/undo`, {});
    r.ok(runRefused.success && runRefused.data.undone === 0 && runRefused.data.refused.length === 1,
      "undoing the run reports the refusal by count rather than failing the request",
      JSON.stringify(runRefused.data));
    const stillStanding = (await F("GET", `/workshops/${WS}/cleanup/runs`)).data.find(
      (x) => x.id === frozenRun,
    );
    r.ok(!stillStanding.undone_at,
      "and the run is NOT marked undone, because it was not — the history does not claim a reversal that did not happen");

    // ---- the button is configuration, not code ---------------------------
    r.section("the action comes from methodology config");

    const status = (await F("GET", `/workshops/${WS}/ai?stage_key=strength_discovery`)).data;
    r.ok(status.board_cleanup === true,
      "SWOT-TOWS offers it, because it has a changeset prompt for capture stages",
      status.board_cleanup);
    r.ok(
      !status.functions.some((f) => f.function_key === "board_cleanup"),
      "and it is NOT in the ordinary function list — a changeset cannot be reviewed suggestion by suggestion",
    );

    const onReport = (await F("GET", `/workshops/${WS}/ai?stage_key=reporting`)).data;
    r.ok(onReport.board_cleanup === false,
      "a report stage offers no board tidy-up — the prompt is keyed to capture stages",
      onReport.board_cleanup);

    const viaExecute = await F("POST", `/workshops/${WS}/ai/execute`, {
      stage_key: "strength_discovery",
      function_key: "board_cleanup",
    });
    r.ok(!viaExecute.success,
      "and it cannot be smuggled through /ai/execute, which has no way to apply or review it",
      viaExecute.error?.message);

    // ---- one real run, opt-in -------------------------------------------
    if (withAI) {
      r.section("a real run against the live model");
      const live = await F(
        "POST",
        `/workshops/${WS}/cleanup`,
        { stage_key: "strength_discovery" },
        { timeoutMs: 120000 },
      );
      r.ok(live.success, "the endpoint completes", live.error?.message ?? live.status);
      if (live.success) {
        r.ok(Array.isArray(live.data.changes) && Array.isArray(live.data.skipped),
          "it returns both what it changed and what it refused");
        r.ok(
          live.data.changes.every((ch) => ["reword", "move", "merge"].includes(ch.change_type)),
          "every change is one of the three declared types",
        );
        r.ok(
          live.data.changes.every((ch) => ch.before && Object.keys(ch.before).length > 0),
          "every real change carries a before-state — the same shape the seeded ones use",
        );
        // §12.19: the assistant approves nothing.
        const touched = live.data.changes.map((ch) => ch.factor_id);
        if (touched.length > 0) {
          const states = (
            await c.query("select distinct state from public.factors where id = any($1)", [touched])
          ).rows.map((x) => x.state);
          r.ok(
            states.every((s) => s === "submitted" || s === "draft" || s === "archived"),
            "nothing it touched became approved — the Review Board is still the decision point",
            states.join(","),
          );
        }
        await F("POST", `/workshops/${WS}/cleanup/runs/${live.data.id}/undo`, {});
      }
    } else {
      r.note("live model run skipped — pass --with-ai to include it; it costs real money");
    }
  } finally {
    // The changes cascade from their run, and the runs are the suite's own —
    // deleted by id rather than by any "recent rows" rule that could reach
    // somebody else's work.
    if (seededRuns.length > 0) {
      await c.query("delete from public.board_cleanup_runs where id = any($1)", [seededRuns]);
    }
    await cleanup(c, { titlePrefixes: [PREFIX], ids: { factors: made.factors } });
  }
});
