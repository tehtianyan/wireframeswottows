// The capture board's own behaviour, against a real database.
//
// Three things are checked here that nothing else could check:
//
//  - THE HAND-SET ORDER. Facilitator-only, scoped to one category of one
//    workshop, and it must NOT leak into how the prioritize stage or the
//    report rank factors. That last one is the whole reason the column
//    exists as a separate field rather than reusing a weight.
//  - PER-SUGGESTION AI REVIEW. The reported defect — "This suggestion has
//    already been reviewed" after adding one of several — is reproduced
//    against a stored output built with SQL, so the real bug is exercised
//    with NO paid model call. An output is just a row; only the review
//    endpoint is under test.
//  - THE TITLE CAP AGREES ACROSS THE STACK. The Go constant and the browser's
//    copy are read from source and compared, because a form that refuses text
//    the server accepts (or accepts text it refuses) loses what somebody typed
//    and can never be caught by an API test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite, clients, db } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

runSuite("capture-board", async ({ baseUrl, results: r, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P } = await clients(baseUrl, [
    "facilitator",
    "participant",
  ]);

  const pg = await db();
  const madeFactors = [];
  const madeThemes = [];
  let aiSession = null;

  try {
    // ================================================================
    r.section("The title cap is one number, in both languages");
    // ================================================================

    const goSrc = read("pkg/handlers/factors.go");
    const tsSrc = read("src/lib/limits.ts");
    const goCap = Number(/MaxFactorTitle\s*=\s*(\d+)/.exec(goSrc)?.[1]);
    const tsCap = Number(/MAX_FACTOR_TITLE\s*=\s*(\d+)/.exec(tsSrc)?.[1]);

    r.ok(
      Number.isFinite(goCap) && Number.isFinite(tsCap) && goCap === tsCap,
      "the browser's title cap matches the server's",
      `go=${goCap} ts=${tsCap}`,
    );

    const objectCap = Number(/MaxObjectTitle\s*=\s*(\d+)/.exec(goSrc)?.[1]);
    const tsObjectCap = Number(/MAX_OBJECT_TITLE\s*=\s*(\d+)/.exec(tsSrc)?.[1]);
    r.ok(
      Number.isFinite(objectCap) && objectCap === tsObjectCap,
      "the browser's object-title cap matches the server's too",
      `go=${objectCap} ts=${tsObjectCap}`,
    );
    // A theme's title is a NAME for a group of notes, so it is capped shorter
    // than a note. Asserted as a relationship rather than as two numbers, so
    // raising either cap does not fail a test that was only checking literals.
    r.ok(objectCap < goCap, "an object's title is capped shorter than a note's", `${objectCap} < ${goCap}`);

    // Every form that writes a title must read a shared constant. A literal
    // left behind is the drift this guards against, and it stays invisible
    // until somebody types a long note into that one form and loses it.
    for (const file of [
      "src/components/methodology/StickyNote.tsx",
      "src/components/methodology/CaptureBoard.tsx",
      "src/components/methodology/CaptureCanvas.tsx",
      "src/components/methodology/FactorCard.tsx",
      "src/components/methodology/ObjectForm.tsx",
      "src/components/methodology/AiActionPanel.tsx",
    ]) {
      const src = read(file);
      const literals = [...src.matchAll(/maxLength=\{(\d+)\}/g)].map((m) => m[1]);
      r.ok(
        literals.length === 0 && /MAX_(FACTOR|OBJECT)_TITLE/.test(src),
        `${path.basename(file)} caps titles from a shared constant, not a literal`,
        literals.length ? `found maxLength={${literals.join("}, {")}}` : "constant used",
      );
    }

    // ================================================================
    r.section("A note may be as long as the cap says, and no longer");
    // ================================================================

    const atCap = "CB-long " + "x".repeat(goCap - 8);
    const created = await F("POST", `/workshops/${WS}/factors`, {
      category_key: "strength",
      title: atCap,
    });
    r.ok(
      created.status === 201 && created.data?.id,
      `a title of exactly ${goCap} characters is accepted`,
      `status=${created.status} ${created.error?.message ?? ""}`,
    );
    if (created.data?.id) madeFactors.push(created.data.id);

    const overCap = await F("POST", `/workshops/${WS}/factors`, {
      category_key: "strength",
      title: "CB-long " + "x".repeat(goCap),
    });
    // Matched on the MESSAGE, not just on failure: a 400 could as easily come
    // from a bad category key, and then this check would be proving nothing.
    r.ok(
      overCap.status === 400 && new RegExp(String(goCap)).test(overCap.error?.message ?? ""),
      "one character over the cap is refused, and the refusal names the cap",
      `status=${overCap.status} ${overCap.error?.message ?? ""}`,
    );

    // ================================================================
    r.section("The hand-set order");
    // ================================================================

    const seed = [];
    for (const n of [1, 2, 3]) {
      const res = await F("POST", `/workshops/${WS}/factors`, {
        category_key: "strength",
        title: `CB-order note ${n}`,
      });
      if (res.data?.id) {
        seed.push(res.data.id);
        madeFactors.push(res.data.id);
      }
    }
    if (seed.length !== 3) {
      r.ok(false, "three notes could be created to order", `got ${seed.length}`);
      return;
    }

    // A fresh note has no position, which is what makes the board fall back to
    // creation order. Asserted explicitly, because "oldest first" depends on
    // it: if the server ever defaulted this to 0, every new note would claim
    // the top slot and the defect being fixed would come straight back.
    const fresh = await F("GET", `/workshops/${WS}/factors`);
    const freshRows = (fresh.data ?? []).filter((f) => seed.includes(f.id));
    r.ok(
      freshRows.length === 3 && freshRows.every((f) => f.board_position === null),
      "a new note has NO hand-set position, so the board falls back to creation order",
      freshRows.map((f) => f.board_position).join(","),
    );

    const reversed = [...seed].reverse();
    const ordered = await F("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "strength",
      factor_ids: reversed,
    });
    r.ok(
      ordered.status === 200,
      "a facilitator can set the order of a category",
      `status=${ordered.status} ${ordered.error?.message ?? ""}`,
    );

    const after = await F("GET", `/workshops/${WS}/factors`);
    const positions = new Map(
      (after.data ?? []).filter((f) => seed.includes(f.id)).map((f) => [f.id, f.board_position]),
    );
    r.ok(
      reversed.every((id, i) => positions.get(id) === i),
      "the positions are written 0..n-1 in the order sent",
      reversed.map((id) => `${positions.get(id)}`).join(","),
    );

    // Sending the same order again must be a no-op rather than an error or a
    // renumbering — a facilitator dragging and dropping the same note back
    // where it came from is an ordinary thing to do.
    const again = await F("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "strength",
      factor_ids: reversed,
    });
    r.ok(again.status === 200, "setting the same order again is accepted", `status=${again.status}`);

    // ---- who may reorder ----

    const participantTried = await P("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "strength",
      factor_ids: seed,
    });
    r.ok(
      participantTried.status === 403,
      "a PARTICIPANT cannot rearrange the shared wall",
      `status=${participantTried.status} ${participantTried.error?.message ?? ""}`,
    );
    // Paired with a positive case, so the refusal above cannot be passing
    // because this participant is not in the workshop at all — the shape that
    // made an earlier weights assertion meaningless.
    const participantCanRead = await P("GET", `/workshops/${WS}/factors`);
    r.ok(
      participantCanRead.status === 200,
      "...while still being a member who can read the board",
      `status=${participantCanRead.status}`,
    );

    // ---- what the order refuses ----

    const dup = await F("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "strength",
      factor_ids: [seed[0], seed[0], seed[1]],
    });
    r.ok(
      dup.status === 400 && /twice/.test(dup.error?.message ?? ""),
      "the same note twice in one order is refused",
      `status=${dup.status} ${dup.error?.message ?? ""}`,
    );

    // A note from ANOTHER category. The order is per-category, so this must be
    // refused whole rather than reordering the ids it recognised.
    const weakness = await F("POST", `/workshops/${WS}/factors`, {
      category_key: "weakness",
      title: "CB-order foreign note",
    });
    if (weakness.data?.id) madeFactors.push(weakness.data.id);
    const crossed = await F("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "strength",
      factor_ids: [...reversed, weakness.data.id],
    });
    r.ok(
      crossed.status === 400 && /nothing was reordered/i.test(crossed.error?.message ?? ""),
      "a note from another category is refused, and says nothing was reordered",
      `status=${crossed.status} ${crossed.error?.message ?? ""}`,
    );
    const unchanged = await F("GET", `/workshops/${WS}/factors`);
    const stillThere = new Map(
      (unchanged.data ?? [])
        .filter((f) => seed.includes(f.id))
        .map((f) => [f.id, f.board_position]),
    );
    r.ok(
      reversed.every((id, i) => stillThere.get(id) === i),
      "...and the previous order really is intact, not half-applied",
      reversed.map((id) => `${stillThere.get(id)}`).join(","),
    );

    const unknownCategory = await F("PUT", `/workshops/${WS}/factors/order`, {
      category_key: "political", // PESTLE's, not this methodology's
      factor_ids: seed,
    });
    r.ok(
      unknownCategory.status === 400 &&
        /unknown factor category/i.test(unknownCategory.error?.message ?? ""),
      "a category from another methodology is refused",
      `status=${unknownCategory.status} ${unknownCategory.error?.message ?? ""}`,
    );

    // ================================================================
    r.section("The order does NOT become a priority");
    // ================================================================

    // This is the assertion the design rests on. A facilitator's arrangement
    // is presentation; the group's ranking comes from weights. If the two ever
    // merged, a facilitator could silently outrank what the room voted, and an
    // executive reading the report would never know.
    const listed = await F("GET", `/workshops/${WS}/factors`);
    const strengths = (listed.data ?? []).filter((f) => f.category_key === "strength");
    const apiOrder = strengths.map((f) => f.id);
    const byVotes = [...strengths].sort((a, b) => b.votes - a.votes).map((f) => f.id);
    r.ok(
      JSON.stringify(apiOrder) === JSON.stringify(byVotes),
      "the factors endpoint still ranks by weight, not by the hand-set order",
      `first=${strengths[0]?.votes} last=${strengths[strengths.length - 1]?.votes}`,
    );

    const types = await F("GET", `/workshops/${WS}/report-types`);
    const typeKey = types.data?.[0]?.key;
    if (typeKey) {
      const made = await F("POST", `/workshops/${WS}/reports`, {
        report_type: typeKey,
        title: "CB-order report",
      });
      if (made.data?.id) {
        const full = await F("GET", `/workshops/${WS}/reports/${made.data.id}`);
        const prioritized = (full.data?.sections ?? []).find(
          (s) => s.section_key === "prioritized_factors",
        );
        if (prioritized) {
          const items = prioritized.items ?? [];
          const values = items
            .map((i) => Object.values(i.weights ?? {})[0]?.value)
            .filter((v) => typeof v === "number");
          r.ok(
            values.every((v, i) => i === 0 || values[i - 1] >= v),
            "the report's prioritized table is still ordered by weight",
            values.join(","),
          );
        } else {
          r.note("this report type has no prioritized_factors section — nothing to check");
        }
        await pg.query("alter table public.reports disable trigger reports_immutable");
        await pg.query("delete from public.reports where id = $1", [made.data.id]);
        await pg.query("alter table public.reports enable trigger reports_immutable");
      }
    }

    // ================================================================
    r.section("Stacking two notes into a theme");
    // ================================================================

    // What the board does when a note is dropped onto another: it creates a
    // REAL theme citing both notes, through the ordinary object endpoint. No
    // new server code exists for it, which is the point — a theme made by
    // stacking is the same object as one made on the Synthesis stage, so it
    // reaches the report and the traceability chain identically.
    const theme = await F("POST", `/workshops/${WS}/syntheses`, {
      title: "CB-theme from the board",
      description: "Created by stacking two notes on the capture board.",
      evidence: { factor: [seed[0], seed[1]] },
    });
    r.ok(
      theme.status === 201 && theme.data?.id,
      "two notes can be grouped into a theme from the capture board",
      `status=${theme.status} ${theme.error?.message ?? ""}`,
    );

    if (theme.data?.id) {
      madeThemes.push(theme.data.id);
      const cited = await pg.query(
        `select factor_id from public.synthesis_factors where synthesis_id = $1 order by factor_id`,
        [theme.data.id],
      );
      r.ok(
        cited.rows.length === 2,
        "...and the notes are stored as its EVIDENCE, so traceability holds",
        `${cited.rows.length} citations`,
      );

      const listed = await F("GET", `/workshops/${WS}/syntheses`);
      const mine = (listed.data ?? []).find((t) => t.id === theme.data.id);
      r.ok(
        mine?.state === "submitted",
        "...and it arrives awaiting review, not approved",
        mine?.state,
      );
      r.ok(
        (mine?.evidence?.factor ?? []).length === 2,
        "...and the board can read its members back to draw the stack",
        `${(mine?.evidence?.factor ?? []).length} members`,
      );

      // Dropping a third note on the stack: the board PATCHes the full list,
      // because replaceEvidence rewrites rather than merges.
      const grew = await F("PATCH", `/workshops/${WS}/syntheses/${theme.data.id}`, {
        evidence: { factor: [seed[0], seed[1], seed[2]] },
      });
      r.ok(grew.status === 200, "a third note can be added to an existing theme", `status=${grew.status}`);
      const after3 = await pg.query(
        `select count(*)::int as n from public.synthesis_factors where synthesis_id = $1`,
        [theme.data.id],
      );
      r.ok(after3.rows[0].n === 3, "...and all three are now cited", `${after3.rows[0].n}`);

      // And taking one out again, which is the × on a note inside a stack.
      const shrank = await F("PATCH", `/workshops/${WS}/syntheses/${theme.data.id}`, {
        evidence: { factor: [seed[0], seed[1]] },
      });
      const after2 = await pg.query(
        `select count(*)::int as n from public.synthesis_factors where synthesis_id = $1`,
        [theme.data.id],
      );
      r.ok(
        shrank.status === 200 && after2.rows[0].n === 2,
        "...and a note can be taken back out of the theme",
        `status=${shrank.status} now ${after2.rows[0].n}`,
      );
    }

    // ================================================================
    r.section("Adding several AI suggestions from one output");
    // ================================================================

    // The output is built with SQL. The defect is entirely in the review
    // endpoint's bookkeeping, so paying for a model call to reach it would buy
    // nothing — and a rule that costs money to check is a rule nobody checks.
    const sessionRow = await pg.query(
      `insert into public.ai_sessions (workshop_id, user_id, prompt_type, stage_key, status)
       select $1, w.created_by, 'artifact_suggestion', ms.key, 'completed'
       from public.workshops w
       join public.methodology_stages ms on ms.methodology_id = w.methodology_id
       where w.id = $1 and ms.stage_type = 'capture'
       order by ms.sequence_number limit 1
       returning id, stage_key`,
      [WS],
    );
    aiSession = sessionRow.rows[0]?.id ?? null;
    const stageKey = sessionRow.rows[0]?.stage_key ?? null;

    if (!aiSession || !stageKey) {
      r.ok(false, "an AI session could be staged for the review test", "no capture stage found");
    } else {
      const content = JSON.stringify({
        suggestions: [
          { title: "CB-ai suggestion one", confidence_score: 0.8 },
          { title: "CB-ai suggestion two", confidence_score: 0.7 },
          { title: "CB-ai suggestion three", confidence_score: 0.6 },
        ],
      });
      const outputRow = await pg.query(
        `insert into public.ai_outputs (ai_session_id, output_type, content, human_review_status)
         values ($1, 'artifact_suggestion', $2::jsonb, 'pending') returning id`,
        [aiSession, content],
      );
      const outputID = outputRow.rows[0].id;

      const accepted = [];
      for (const index of [0, 1, 2]) {
        const res = await F("POST", `/workshops/${WS}/ai/outputs/${outputID}/review`, {
          action: "accept",
          index,
          stage_key: stageKey,
        });
        const ok = res.status === 201 && res.data?.converted_object_id;
        r.ok(
          ok,
          `suggestion ${index + 1} of 3 can be added — THE REPORTED DEFECT`,
          `status=${res.status} ${res.error?.message ?? ""}`,
        );
        if (ok) {
          accepted.push(res.data.converted_object_id);
          madeFactors.push(res.data.converted_object_id);
        }
      }

      r.ok(
        new Set(accepted).size === 3,
        "each suggestion created its OWN object, not three references to one",
        `${new Set(accepted).size} distinct ids`,
      );

      // Every suggestion decided, so the output as a whole is settled — which
      // is what keeps the existing output-level readers correct.
      const settled = await pg.query(
        `select human_review_status from public.ai_outputs where id = $1`,
        [outputID],
      );
      r.ok(
        settled.rows[0]?.human_review_status === "accepted",
        "the output as a whole is marked accepted once every suggestion is decided",
        settled.rows[0]?.human_review_status,
      );

      // Re-adding the same one is still refused — and the message must say
      // THAT, rather than the batch-wide sentence that caused the confusion.
      const repeat = await F("POST", `/workshops/${WS}/ai/outputs/${outputID}/review`, {
        action: "accept",
        index: 1,
        stage_key: stageKey,
      });
      r.ok(
        repeat.status === 409 || repeat.status === 400,
        "the SAME suggestion cannot be added twice",
        `status=${repeat.status} ${repeat.error?.message ?? ""}`,
      );
      r.ok(
        /already added this suggestion/i.test(repeat.error?.message ?? ""),
        "...and the refusal is about that one suggestion, not the whole batch",
        repeat.error?.message ?? "",
      );

      const itemRows = await pg.query(
        `select item_index, review_status, converted_object_id
         from public.ai_output_items where ai_output_id = $1 order by item_index`,
        [outputID],
      );
      r.ok(
        itemRows.rows.length === 3 &&
          itemRows.rows.every((x) => x.review_status === "accepted" && x.converted_object_id),
        "each decision is recorded against its own suggestion, naming what it created",
        itemRows.rows.map((x) => `${x.item_index}:${x.review_status}`).join(" "),
      );

      // ---- dismissing the rest must not undo what was added ----

      const content2 = JSON.stringify({
        suggestions: [
          { title: "CB-ai partial one" },
          { title: "CB-ai partial two" },
          { title: "CB-ai partial three" },
        ],
      });
      const out2 = await pg.query(
        `insert into public.ai_outputs (ai_session_id, output_type, content, human_review_status)
         values ($1, 'artifact_suggestion', $2::jsonb, 'pending') returning id`,
        [aiSession, content2],
      );
      const partialID = out2.rows[0].id;

      const one = await F("POST", `/workshops/${WS}/ai/outputs/${partialID}/review`, {
        action: "accept",
        index: 0,
        stage_key: stageKey,
      });
      if (one.data?.converted_object_id) madeFactors.push(one.data.converted_object_id);

      const openStill = await pg.query(
        `select human_review_status from public.ai_outputs where id = $1`,
        [partialID],
      );
      r.ok(
        openStill.rows[0]?.human_review_status === "pending",
        "with one of three decided, the output as a whole is still pending",
        openStill.rows[0]?.human_review_status,
      );

      const dismissed = await F("POST", `/workshops/${WS}/ai/outputs/${partialID}/review`, {
        action: "reject",
      });
      r.ok(dismissed.status === 200, "the rest can be dismissed", `status=${dismissed.status}`);

      const afterDismiss = await pg.query(
        `select item_index, review_status from public.ai_output_items
         where ai_output_id = $1 order by item_index`,
        [partialID],
      );
      r.ok(
        afterDismiss.rows[0]?.review_status === "accepted" &&
          afterDismiss.rows[1]?.review_status === "rejected" &&
          afterDismiss.rows[2]?.review_status === "rejected",
        "'dismiss the rest' leaves the accepted one accepted",
        afterDismiss.rows.map((x) => `${x.item_index}:${x.review_status}`).join(" "),
      );
      const settled2 = await pg.query(
        `select human_review_status, converted_object_id from public.ai_outputs where id = $1`,
        [partialID],
      );
      r.ok(
        settled2.rows[0]?.human_review_status === "accepted" &&
          settled2.rows[0]?.converted_object_id,
        "...and the output still names the object it produced, rather than reading as withdrawn",
        `${settled2.rows[0]?.human_review_status} object=${Boolean(settled2.rows[0]?.converted_object_id)}`,
      );

      // The constraint, not the handler, is what makes a double decision
      // impossible. Proven from direct SQL so no future handler can lose it.
      let refusedBySQL = false;
      try {
        await pg.query(
          `insert into public.ai_output_items (ai_output_id, item_index, review_status, reviewed_by)
           select $1, 0, 'rejected', reviewed_by from public.ai_output_items
           where ai_output_id = $1 and item_index = 0`,
          [partialID],
        );
      } catch {
        refusedBySQL = true;
      }
      r.ok(
        refusedBySQL,
        "the DATABASE refuses a second decision on one suggestion, not just the handler",
        refusedBySQL ? "unique constraint held" : "a duplicate decision was stored",
      );

      // ---- outputs decided under the OLD scheme stay closed ----

      // Production holds outputs reviewed before ai_output_items existed:
      // the status says accepted, and WHICH suggestion that was is recorded
      // nowhere. Re-opening one would let the settle step overwrite a
      // historical "accepted" with "rejected", so it is refused — and the
      // refusal has to SAY why, or it reads as the batch-wide bug returning.
      // `reviewed_by` is not optional here: ai_outputs carries the same
      // "a decision names its reviewer" constraint every object table has,
      // which is how §12.19's "AI never approves anything" is enforced in the
      // schema rather than in a handler. The fixture has to satisfy it.
      const legacy = await pg.query(
        `insert into public.ai_outputs
           (ai_session_id, output_type, content, human_review_status, reviewed_by, reviewed_at)
         select $1, 'artifact_suggestion', $2::jsonb, 'accepted', w.created_by, now()
         from public.workshops w where w.id = $3
         returning id`,
        [aiSession, JSON.stringify({ suggestions: [{ title: "CB-ai legacy one" }] }), WS],
      );
      const legacyTried = await F("POST", `/workshops/${WS}/ai/outputs/${legacy.rows[0].id}/review`, {
        action: "accept",
        index: 0,
        stage_key: stageKey,
      });
      r.ok(
        legacyTried.status === 409 &&
          /tracked individually/i.test(legacyTried.error?.message ?? ""),
        "an output decided before per-suggestion review existed stays closed, and says why",
        `status=${legacyTried.status} ${legacyTried.error?.message ?? ""}`,
      );
      await pg.query(`delete from public.ai_outputs where id = $1`, [legacy.rows[0].id]);

      let acceptedWithNothing = false;
      try {
        await pg.query(
          `insert into public.ai_output_items (ai_output_id, item_index, review_status, reviewed_by)
           select $1, 7, 'accepted', reviewed_by from public.ai_output_items
           where ai_output_id = $1 and item_index = 0`,
          [partialID],
        );
      } catch {
        acceptedWithNothing = true;
      }
      r.ok(
        acceptedWithNothing,
        "an acceptance that names no created object is unrepresentable",
        acceptedWithNothing ? "check constraint held" : "an untraceable acceptance was stored",
      );
    }
  } finally {
    // Positions are reset to null so the demo board goes back to creation
    // order for the next run — suites share this workshop.
    await pg.query(
      `update public.factors set board_position = null where workshop_id = $1`,
      [WS],
    );
    if (madeFactors.length > 0) {
      await pg.query(`delete from public.weights where object_id = any($1)`, [madeFactors]);
      await pg.query(`delete from public.synthesis_factors where factor_id = any($1)`, [
        madeFactors,
      ]);
      await pg.query(`delete from public.factors where id = any($1)`, [madeFactors]);
    }
    if (madeThemes.length > 0) {
      await pg.query(`delete from public.syntheses where id = any($1)`, [madeThemes]);
    }
    await pg.query(`delete from public.syntheses where title like 'CB-%'`);
    await pg.query(`delete from public.factors where title like 'CB-%'`);
    if (aiSession) {
      await pg.query(`delete from public.ai_sessions where id = $1`, [aiSession]);
    }
    await pg.end();
  }
});
