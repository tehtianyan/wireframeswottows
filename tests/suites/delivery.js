// The delivery board on the Reporting stage, and its Jira export.
//
// WHY A REAL SERVER AND A REAL DATABASE. The pure parts live in Go tests that
// need neither — the CSV's epic linking, the collision handling, the state
// vocabulary coming from config (pkg/handlers/delivery_csv_test.go). This
// suite covers what only a real stack can show: that the columns a facilitator
// sees come from the stage's own jsonb, that a participant cannot move a card,
// that a move actually persists and is audited, that an id from another
// workshop is refused, and that no other methodology gained a board.
import fs from "node:fs";
import path from "node:path";
import { runSuite, clients, cleanup } from "../lib/harness.js";

const SRC = (p) => fs.readFileSync(path.join(process.cwd(), "src", p), "utf8");

/** The same file with comments stripped — a file may ARGUE about a literal. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ 	]*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");

const PREFIX = "DELIVERY probe";

/**
 * A minimal RFC 4180 reader — quoted fields, doubled quotes, and newlines
 * inside quotes. Needed because an issue description is several paragraphs, so
 * one CSV record spans several lines and splitting on "\n" misreads the file.
 */
function parseCSV(text) {
  const records = [];
  let rec = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      rec.push(field);
      field = "";
    } else if (ch === "\n") {
      rec.push(field);
      records.push(rec);
      rec = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || rec.length > 0) {
    rec.push(field);
    records.push(rec);
  }
  return records;
}

runSuite("delivery", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P, analyst: A } = await clients(baseUrl, [
    "facilitator",
    "participant",
    "analyst",
  ]);
  const made = { recommendations: [], initiatives: [], insights: [], syntheses: [] };

  try {
    // ---- which stage declares the board --------------------------------
    const detail = (await F("GET", `/workshops/${WS}`)).data;
    const stages = detail.methodology.stages ?? [];
    const reportStage = stages.find((s) => s.stage_type === "report" && s.config?.delivery);
    const relateStage = stages.find((s) => s.stage_type === "relate");

    r.section("the board is declared by the stage, not by the code");
    r.ok(Boolean(reportStage), "a report stage declares a delivery board", reportStage?.key);
    if (!reportStage) return;

    const cfg = reportStage.config.delivery;
    r.ok(cfg.kind === "recommendation", "it tracks the kind its config names", cfg.kind);
    r.ok(Array.isArray(cfg.states) && cfg.states.length >= 2,
      "with at least two columns", `${cfg.states?.length} states`);
    r.ok(Array.isArray(cfg.exports) && cfg.exports.includes("jira"),
      "and declares the Jira export", JSON.stringify(cfg.exports));

    const board0 = await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`);
    r.ok(board0.success, "the board loads", board0.error?.message);
    // THE COLUMNS ARE THE CONFIGURED ONES, IN THE CONFIGURED ORDER. A server
    // that invented them, or sorted them, would still return three columns —
    // so this compares them to the jsonb rather than counting.
    r.ok(
      JSON.stringify(board0.data.states.map((s) => s.key)) ===
        JSON.stringify(cfg.states.map((s) => s.key)),
      "the columns are exactly the config's, in its order",
      board0.data.states.map((s) => s.name).join(" → "),
    );
    r.ok(board0.data.label === cfg.label, "the heading is the configured one", board0.data.label);
    r.ok(board0.data.item_label === cfg.item_label,
      "and the cards are called what the methodology calls them", board0.data.item_label);

    // ---- fixtures: an initiative with two actions ----------------------
    const relTypes = detail.methodology.relationship_types ?? [];
    r.ok(relTypes.length > 0, "the methodology has relationship types to file actions under");
    const typeKey = relTypes[0].key;

    const init = await F("POST", `/workshops/${WS}/initiatives`, {
      title: `${PREFIX} Invest in partners`,
      relationship_type_key: typeKey,
    });
    r.ok(init.success, "create an initiative to group the actions", init.error?.message);
    if (!init.success) return;
    made.initiatives.push(init.data.id);

    const mkAction = async (title, priority) => {
      const res = await F("POST", `/workshops/${WS}/recommendations`, {
        title: `${PREFIX} ${title}`,
        description: "Agreed in the workshop.",
        fields: { priority },
        parent_id: init.data.id,
      });
      if (!res.success) throw new Error(`fixture failed: ${res.error?.message}`);
      made.recommendations.push(res.data.id);
      return res.data.id;
    };
    const a1 = await mkAction("Build out AI messaging", "critical");
    const a2 = await mkAction("Refresh the FSI pitch", "medium");

    // ---- an unplaced action sits in the first column --------------------
    r.section("an unplaced action is in the first column, not missing");
    const board1 = (await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`)).data;
    const find = (b, id) => b.items.find((it) => it.id === id);
    r.ok(
      (await c.query("select delivery_state from public.recommendations where id = $1", [a1]))
        .rows[0].delivery_state === null,
      "nothing was written to the column when the action was created",
    );
    r.ok(find(board1, a1)?.state === cfg.states[0].key,
      "and it still comes back in the first declared state", find(board1, a1)?.state);
    // A null that came back as "" would render a card in no column at all,
    // which looks exactly like the action having been lost.
    r.ok(board1.items.every((it) => it.state && board1.states.some((s) => s.key === it.state)),
      "every card is in a column the board actually has");

    r.ok(find(board1, a1)?.group_title.includes("Invest in partners"),
      "a card names the initiative it sits under", find(board1, a1)?.group_title);
    r.ok(board1.groups.some((g) => g.id === init.data.id),
      "and the initiative is listed as a heading even before anything moves");

    // ---- RANK IS ACROSS THE BOARD, not within a heading -----------------
    //
    // THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE OBVIOUS IMPLEMENTATION.
    // `board_position` is the matrix's order WITHIN a cell, so it restarts at
    // zero in every initiative. Sending it straight through as the rank would
    // put the first action of every initiative at "#1" on a board that groups
    // by column rather than by heading — several cards all claiming to be
    // first, which reads as a bug in the ranking rather than in the number.
    //
    // So a second initiative is created deliberately, to make two actions
    // share a board_position and prove the ranks still differ.
    r.section("rank is the position across the whole board, not within a heading");
    const init2 = await F("POST", `/workshops/${WS}/initiatives`, {
      title: `${PREFIX} Invest in branding`,
      relationship_type_key: typeKey,
    });
    r.ok(init2.success, "a second initiative, to collide the positions", init2.error?.message);
    if (init2.success) made.initiatives.push(init2.data.id);
    const a3 = init2.success
      ? await (async () => {
          const res = await F("POST", `/workshops/${WS}/recommendations`, {
            title: `${PREFIX} Rebrand the partner portal`,
            description: "Agreed in the workshop.",
            fields: { priority: "low" },
            parent_id: init2.data.id,
          });
          if (res.success) made.recommendations.push(res.data.id);
          return res.success ? res.data.id : null;
        })()
      : null;

    const boardR = (await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`)).data;
    const findR = (b, id) => b.items.find((it) => it.id === id);
    const positions = Object.fromEntries(
      (
        await c.query(
          `select id::text, coalesce(board_position, 0) as p from public.recommendations
           where id = any($1::uuid[])`,
          [[a1, a3].filter(Boolean)],
        )
      ).rows.map((x) => [x.id, x.p]),
    );
    if (a3) {
      r.ok(positions[a1] === positions[a3],
        "two actions under different initiatives share a board_position",
        `${positions[a1]} / ${positions[a3]}`);
      r.ok(findR(boardR, a1).rank !== findR(boardR, a3).rank,
        "and still get different ranks on the board",
        `#${findR(boardR, a1).rank + 1} / #${findR(boardR, a3).rank + 1}`);
    } else {
      r.skip("could not create the second initiative's action");
    }
    const ranks = boardR.items.map((it) => it.rank);
    r.ok(new Set(ranks).size === ranks.length, "no two cards claim the same rank", ranks.join(","));

    // AN INITIATIVE'S ACTIONS ARE CONTIGUOUS IN THE RANKING.
    //
    // RANKING ONE INITIATIVE FIRST IS WHAT EXPOSES THIS, so the check does
    // it. `board_position` is written only by a drag, so with nothing dragged
    // every row ties at 0 and creation order happens to keep the groups
    // together — the bug hides. Rank one initiative's actions and its
    // positions become 0,1 while the untouched initiative's stay 0, so its
    // action sorts between them. A check written without this reorder would
    // pass on the broken code.
    await F("PUT", `/workshops/${WS}/recommendations/order`, {
      scope_id: init.data.id,
      ids: [a2, a1],
    });
    const boardC = (await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`)).data;
    //
    // `board_position` is written only when a facilitator DRAGS something, so
    // until then every initiative sits at NULL and ordering by it alone is no
    // ordering at all: the board drew one initiative's first action, then the
    // other's first action, then back again — five actions from two
    // initiatives interleaved, which reads as the ranking being arbitrary.
    // Same shape as the RFC3339 tie that inverted two initiatives on the
    // matrix, and found the same way, by looking at a screenshot.
    const seenGroups = [];
    for (const it of boardC.items) {
      const g = it.group_id ?? "none";
      if (seenGroups[seenGroups.length - 1] !== g) seenGroups.push(g);
    }
    r.ok(new Set(seenGroups).size === seenGroups.length,
      "each initiative's actions sit together in the ranking, rather than interleaving",
      seenGroups.map((g) => (g === "none" ? "—" : g.slice(0, 8))).join(" | "));

    // ---- who may move a card -------------------------------------------
    r.section("moving a card is the facilitator's and the analyst's");
    const target = cfg.states[1].key;
    const asParticipant = await P("PUT", `/workshops/${WS}/delivery/${a1}?stage_key=${reportStage.key}`, {
      state: target,
    });
    r.ok(!asParticipant.success, "a participant cannot move a card", asParticipant.error?.message);
    const pBoard = await P("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`);
    r.ok(pBoard.success, "but a participant can read the board", pBoard.error?.message);
    r.ok(pBoard.data.can_move === false,
      "and is told so, rather than shown a control that will be refused", pBoard.data.can_move);

    const asAnalyst = await A("PUT", `/workshops/${WS}/delivery/${a2}?stage_key=${reportStage.key}`, {
      state: target,
    });
    r.ok(asAnalyst.success, "an analyst can move one", asAnalyst.error?.message);

    const moved = await F("PUT", `/workshops/${WS}/delivery/${a1}?stage_key=${reportStage.key}`, {
      state: target,
    });
    r.ok(moved.success, "and so can a facilitator", moved.error?.message);
    r.ok(moved.data.state_name === cfg.states[1].name,
      "the response names the column in the methodology's words", moved.data.state_name);

    r.ok(
      (await c.query("select delivery_state from public.recommendations where id = $1", [a1]))
        .rows[0].delivery_state === target,
      "the move reached the database",
    );
    const board2 = (await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`)).data;
    r.ok(find(board2, a1)?.state === target, "and the board reports it", find(board2, a1)?.state);

    const audit = await c.query(
      `select previous_state, new_state, object_type from public.audit_events
       where action = 'delivery.moved' and object_id = $1 order by created_at desc limit 1`,
      [a1],
    );
    r.ok(audit.rows.length === 1, "the move wrote an audit row");
    r.ok(audit.rows[0]?.new_state === target,
      "which records where it went", audit.rows[0]?.new_state);
    // The FROM state has to be the resolved first column, not the empty
    // string the column actually held — an audit trail saying a card moved
    // from nowhere is a trail nobody can read.
    r.ok(audit.rows[0]?.previous_state === cfg.states[0].key,
      "and where it came from, resolved rather than blank", audit.rows[0]?.previous_state);

    // ---- refusals -------------------------------------------------------
    r.section("a column that does not exist is refused, by name");
    const bogus = await F("PUT", `/workshops/${WS}/delivery/${a1}?stage_key=${reportStage.key}`, {
      state: "shipped",
    });
    r.ok(!bogus.success, "an undeclared state is refused", bogus.error?.message);
    for (const s of cfg.states) {
      r.ok((bogus.error?.message ?? "").includes(s.name),
        `the refusal names the real column "${s.name}"`);
    }

    // An id from another workshop must be a 404 and never a write. Created
    // through SQL so the check cannot quietly skip for want of a fixture.
    const otherWs = (
      await c.query(
        `select id from public.workshops where id <> $1 and methodology_id =
           (select methodology_id from public.workshops where id = $1) limit 1`,
        [WS],
      )
    ).rows[0];
    if (otherWs) {
      const foreign = (
        await c.query(
          `insert into public.recommendations (workshop_id, title, description, state, created_by)
           values ($1, $2, 'probe', 'submitted',
                   (select created_by from public.workshops where id = $1))
           returning id`,
          [otherWs.id, `${PREFIX} foreign`],
        )
      ).rows[0].id;
      const cross = await F("PUT", `/workshops/${WS}/delivery/${foreign}?stage_key=${reportStage.key}`, {
        state: target,
      });
      r.ok(!cross.success && cross.error?.code === "NOT_FOUND",
        "an action from another workshop is a 404, not a write", cross.error?.code);
      r.ok(
        (await c.query("select delivery_state from public.recommendations where id = $1", [foreign]))
          .rows[0].delivery_state === null,
        "and it was genuinely not written to",
      );
      await c.query("delete from public.recommendations where id = $1", [foreign]);
    } else {
      r.skip("no second workshop to test the cross-workshop refusal against");
    }

    // A stage that declares no board refuses rather than inventing one.
    if (relateStage) {
      const wrongStage = await F("GET", `/workshops/${WS}/delivery?stage_key=${relateStage.key}`);
      r.ok(!wrongStage.success,
        "a stage that declares no board has none", wrongStage.error?.message);
    }

    // ---- the rating travels with two numbers ----------------------------
    r.section("the rating on a card carries its voter count");
    const weightKey = board2.weight_key;
    r.ok(Boolean(weightKey),
      "the board names the weight its cards are rated on, rather than assuming one", weightKey);
    if (weightKey) {
      const set = await P("PUT",
        `/workshops/${WS}/recommendations/${a1}/weights/${weightKey}`, { value: 4 });
      r.ok(set.success, "a participant rates an action", set.error?.message);
      const w = await F("GET", `/workshops/${WS}/weights`);
      const agg = (w.data.totals ?? []).find((t) => t.object_id === a1 && t.weight_key === weightKey);
      r.ok(Boolean(agg), "the rating is aggregated", agg && `${agg.value} from ${agg.voters}`);
      r.ok(agg?.voters >= 1, "with how many people are behind it", agg?.voters);
      r.ok(typeof w.data.participation?.[weightKey]?.contributors === "number",
        "and the denominator the count needs to mean anything",
        w.data.participation?.[weightKey]?.contributors);
    }

    // ---- Export to Jira -------------------------------------------------
    r.section("Export to Jira");
    const csv = await F("GET", `/workshops/${WS}/delivery/export/jira.csv?stage_key=${reportStage.key}`,
      undefined, { raw: true });
    r.ok(csv.status === 200, "the export returns 200", csv.status);
    r.ok((csv.headers.get("content-type") || "").includes("text/csv"),
      "served as CSV", csv.headers.get("content-type"));
    r.ok((csv.headers.get("content-disposition") || "").includes("attachment"),
      "as a download rather than a page");

    const lines = csv.text.trim().split(/\r?\n/);
    const header = lines[0];
    for (const col of ["Issue Type", "Summary", "Description", "Status", "Priority", "Epic Name", "Epic Link"]) {
      r.ok(header.includes(col), `the header declares ${col}`);
    }
    r.ok(csv.text.includes("Invest in partners"),
      "the initiative is exported as an epic");
    r.ok(csv.text.includes(`${PREFIX} Build out AI messaging`),
      "and the action as a story under it");

    // THE STATUS IS THE CONFIGURED NAME. Jira matches a status by its display
    // name, so exporting the key would leave every issue in the default
    // status and throw the board's whole state away on import.
    r.ok(csv.text.includes(cfg.states[1].name),
      `the moved card exports as "${cfg.states[1].name}"`);
    r.ok(!new RegExp(`,${cfg.states[1].key},`).test(csv.text),
      "the state KEY is not exported in its place", cfg.states[1].key);

    // Provenance, because an action in Jira with no trace back is an action
    // nobody can argue about later.
    r.ok(csv.text.includes(detail.name),
      "each issue says which workshop agreed it", detail.name);
    r.ok(csv.text.includes(relTypes[0].name),
      "and which pairing produced it", relTypes[0].name);
    if (weightKey) {
      r.ok(/rated by \d+ of \d+/.test(csv.text),
        "the rating travels with its denominator, not alone");
    }
    r.ok(/not yet rated/.test(csv.text) || board2.items.length === 1,
      "an unrated action says so rather than exporting a bare zero");

    // EVERY RECORD HAS THE HEADER'S FIELD COUNT, or Jira rejects the file.
    //
    // Parsed properly rather than split on newlines. The first version of
    // this check counted commas per LINE and failed on a correct file: an
    // issue description carries blank lines between its paragraphs, so one
    // record legitimately spans several lines inside its quotes. A checker
    // that cannot read quoted newlines reports a format error where there is
    // none — and would have sent me to "fix" the export.
    const records = parseCSV(csv.text);
    const want = records[0].length;
    const ragged = records.filter((rec) => rec.length !== want).length;
    r.ok(ragged === 0,
      "every record has as many fields as the header",
      `${records.length} records of ${want} fields${ragged ? `, ${ragged} ragged` : ""}`);
    r.ok(records.length >= 3,
      "the file holds the header, the epic and the actions", `${records.length} records`);
    // And a multi-line description really is inside one record, which is the
    // property the naive checker got wrong.
    const descCol = records[0].indexOf("Description");
    r.ok(records.slice(1).some((rec) => rec[descCol]?.includes("\n")),
      "a description's paragraphs stay inside one quoted field");

    // ================================================================
    r.section("an action carries who owns it, when, what it costs, what it is worth");
    // ================================================================
    //
    // UAT 2026-11-14. EVERY ONE OPTIONAL — "so that the facilitator can skip
    // these when he is out of time" — which is why the first assertion here
    // is that an action with none of them set is still a valid action, and
    // why the migration verifies no column arrived NOT NULL.
    const actionId = board2.items[0].id;
    const recRoute = "recommendations";

    const plain = await F("POST", `/workshops/${WS}/${recRoute}`, {
      title: `${PREFIX} an action nobody had time to plan`,
      parent_id: board2.items[0].group_id,
      fields: { priority: "medium" },
      evidence: {},
    });
    r.ok(plain.success, "an action with no delivery detail is still accepted",
      plain.error?.message);
    if (plain.success) made.recommendations.push(plain.data.id);

    // ---- the owner is an account OR a name, never both ----
    const roster = (await F("GET", `/workshops/${WS}/participants`)).data ?? [];
    const member = roster.find((p) => p.role === "participant") ?? roster[0];

    const named = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { owner_user_id: member.user_id },
    });
    r.ok(named.success, "an owner can be chosen from the roster", named.error?.message);

    // THE CONTRADICTION IS UNREACHABLE, NOT MERELY REFUSED. Typing a name on
    // a card that already names somebody has to replace them — the database
    // CHECK would otherwise answer with a SQLSTATE, which is no use to
    // anybody filling in a form.
    const retyped = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { owner_name: "Head of Sales Ops" },
    });
    r.ok(retyped.success, "...and typing a name instead replaces them rather than colliding",
      retyped.error?.message);

    const both = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { owner_user_id: member.user_id, owner_name: "Two at once" },
    });
    r.ok(!both.success && /not both/i.test(both.error?.message ?? ""),
      "...but asking for both in ONE request is refused, in words",
      both.error?.message);

    // AN OUTSIDER CANNOT BE NAMED AS AN ACCOUNT. The foreign key only asks
    // whether the person exists, so without a roster check an owner could be
    // somebody from another client's workshop.
    const outsider = roster.find((p) => p.user_id !== member.user_id);
    const stranger = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { owner_user_id: "00000000-0000-0000-0000-000000000001" },
    });
    r.ok(!stranger.success && /in this workshop/i.test(stranger.error?.message ?? ""),
      "an owner who is not on this roster is refused", stranger.error?.message);
    void outsider;

    // ---- the rest of the plan ----
    const planned = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: {
        owner_user_id: member.user_id,
        start_date: "2026-03-02",
        end_date: "2026-06-30",
        effort_person_days: 12.5,
        value_amount: 450000,
        value_unit: "money_annual",
        value_basis: "3% churn reduction on $15M ARR",
      },
    });
    r.ok(planned.success, "the whole plan saves in one request", planned.error?.message);

    const board3 = (await F("GET", `/workshops/${WS}/delivery?stage_key=${reportStage.key}`)).data;
    const card = board3.items.find((i) => i.id === actionId);
    r.ok(card?.owner_name === member.name || card?.owner_name === member.email,
      "the card shows a NAME, not a uuid — whichever way the owner was recorded",
      card?.owner_name);
    r.ok(card?.owner_email === member.email,
      "...and the email comes back too, which is what Jira can assign on",
      card?.owner_email);
    r.ok(card?.start_date === "2026-03-02" && card?.end_date === "2026-06-30",
      "the dates are calendar dates, not timestamps that shift by timezone",
      `${card?.start_date} → ${card?.end_date}`);
    r.ok(Number(card?.effort_person_days) === 12.5,
      "half a person-day survives the round trip", card?.effort_person_days);
    r.ok(Number(card?.value_amount) === 450000 && card?.value_unit === "money_annual",
      "the value keeps its unit, so two of them could be added together",
      `${card?.value_amount} ${card?.value_unit}`);

    // ---- what the database refuses whatever the handler does ----
    const backwards = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { start_date: "2026-06-30", end_date: "2026-03-02" },
    });
    r.ok(!backwards.success, "a date range that runs backwards is refused",
      backwards.error?.message);

    // A NUMBER WITH NO UNIT IS NOT A QUANTITY. The pair is what makes the
    // value addable; half of it is a field somebody started filling in.
    const halfValue = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { value_amount: 999, value_unit: null },
    });
    r.ok(!halfValue.success, "an amount with no unit is refused", halfValue.error?.message);

    const madeUpUnit = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { value_amount: 999, value_unit: "bananas" },
    });
    r.ok(!madeUpUnit.success && /must be one of/i.test(madeUpUnit.error?.message ?? ""),
      "...and a unit nobody declared is refused by name, listing the real ones",
      madeUpUnit.error?.message);

    const badDate = await F("PUT", `/workshops/${WS}/delivery/${actionId}/plan?stage_key=${reportStage.key}`, {
      fields: { start_date: "2026-02-31" },
    });
    r.ok(!badDate.success, "a date that does not exist is refused before the database sees it",
      badDate.error?.message);

    // ---- AN APPROVED ACTION CAN STILL BE PLANNED ----------------------
    //
    // THE DEFECT THIS SECTION EXISTS FOR, and it only showed up when the Jira
    // file was PRINTED: every plan column came back empty. The first version
    // saved through the generic object PATCH, which freezes an approved
    // object — so the actions a facilitator most wants to plan, the ones the
    // room agreed, were precisely the ones that could not be. The board went
    // on offering "Add owner, dates, effort, value" and the write was refused.
    //
    // The freeze is right for CONTENT and wrong for delivery: who does an
    // agreed action, and by when, is decided after the decision to do it.
    // Hence a route of its own, like moving a card between columns.
    const approved = await F("POST", `/workshops/${WS}/${recRoute}`, {
      title: `${PREFIX} an approved action`,
      parent_id: board2.items[0].group_id,
      fields: { priority: "high" },
      evidence: {},
    });
    if (approved.success) made.recommendations.push(approved.data.id);
    await F("POST", `/workshops/${WS}/${recRoute}/${approved.data.id}/review`, { action: "approve" });

    const frozenEdit = await F("PATCH", `/workshops/${WS}/${recRoute}/${approved.data.id}`, {
      title: "renamed after approval",
    });
    r.ok(!frozenEdit.success,
      "an approved action's CONTENT is still frozen — the governance rule is intact",
      frozenEdit.error?.message);

    const planApproved = await F("PUT",
      `/workshops/${WS}/delivery/${approved.data.id}/plan?stage_key=${reportStage.key}`, {
        fields: { owner_name: "Head of Delivery", effort_person_days: 3 },
      });
    r.ok(planApproved.success,
      "...but its delivery plan can still be filled in, which is the whole point",
      planApproved.error?.message);

    // AND THE ROUTE IS NOT A BACK DOOR PAST THE FREEZE. Only the delivery
    // group is writable here; a title sent to this endpoint must be refused
    // by name, or the governance rule above would be bypassable.
    const sneaky = await F("PUT",
      `/workshops/${WS}/delivery/${approved.data.id}/plan?stage_key=${reportStage.key}`, {
        fields: { title: "renamed through the plan route" },
      });
    r.ok(!sneaky.success && /not part of the delivery plan/i.test(sneaky.error?.message ?? ""),
      "...and content cannot be edited through it", sneaky.error?.message);

    const stillNamed = (await F("GET", `/workshops/${WS}/${recRoute}`)).data
      ?.find((o) => o.id === approved.data.id);
    r.ok(stillNamed?.title === `${PREFIX} an approved action`,
      "...the title really is unchanged", stillNamed?.title);

    // ---- and it all travels to Jira ----
    const csv2 = await F("GET",
      `/workshops/${WS}/delivery/export/jira.csv?stage_key=${reportStage.key}`,
      undefined, { raw: true });
    const recs2 = parseCSV(csv2.text);
    const h2 = recs2[0];
    for (const col of ["Assignee", "Due Date", "Original Estimate"]) {
      r.ok(h2.includes(col), `the export declares ${col}`);
    }
    const assignee = recs2.slice(1).map((rec) => rec[h2.indexOf("Assignee")]);
    r.ok(assignee.includes(member.email),
      "the owner reaches Jira as an email, which is what it matches on");
    const est = recs2.slice(1).map((rec) => rec[h2.indexOf("Original Estimate")]);
    r.ok(est.includes("12.5d"),
      "the estimate carries its unit — a bare number is SECONDS to Jira", est.join("|"));
    r.ok(!csv2.text.includes("money_annual"),
      "the stored unit key does not reach the ticket; its label does");
    r.ok(csv2.text.includes("3% churn reduction on $15M ARR"),
      "the basis travels with the figure, so it can be argued with later");

    // ---- nothing else gained a board ------------------------------------
    r.section("no other methodology gained a delivery board");
    const leaked = await c.query(
      `select m.key from public.methodology_stages s
       join public.methodologies m on m.id = s.methodology_id
       where s.config ? 'delivery' and m.key <> 'swot-tows'`,
    );
    r.ok(leaked.rows.length === 0,
      "only the methodology that asked for one has one",
      leaked.rows.map((x) => x.key).join(", ") || "none");

    // ====================================================================
    r.section("the board on screen (source — the API was right either way)");
    // ====================================================================
    //
    // READ FROM SOURCE, like board-ui.js and shell-ui.js, because the layout
    // is a RENDERING decision and every endpoint above is correct whichever
    // way it is drawn. The two defects this guards against — a hardcoded
    // column name and a grid that stacks the columns — would both leave this
    // suite's 60-odd HTTP checks green.
    const board = SRC("components/methodology/DeliveryBoard.tsx");
    const body = code(board);

    // The file argues about "To Do" and "Done" in its comments, so only the
    // code is asked — the same reason TowsMatrix.tsx is read this way.
    for (const word of ["To Do", "In Progress", "todo", "in_progress", '"done"', "'done'"]) {
      r.ok(!body.includes(word),
        `the component's code does not name the column "${word}"`);
    }
    r.ok(/board\.states\.map/.test(body),
      "the columns are drawn from the states the server resolved");
    r.ok(!/states\.length === 3|states\[2\]/.test(body),
      "and nothing assumes how many there are");

    // A KANBAN IS ONE ROW. `boardColumns` answers a different question — it
    // gives 2x2 for four panels, which on a four-state board would stack the
    // last column underneath the first and stop it being a kanban.
    r.ok(!/boardColumns/.test(body),
      "the columns are not laid out with boardColumns, which would wrap them into a block");

    // ---- the plan form is BUILT from the registry (UAT 2026-11-14) ----
    //
    // Eight fields, their types, their bounds and their unit labels are
    // declared once on the server. A second list here is where the two drift,
    // and the symptom is a card reading "money_annual" — which nobody notices
    // until it has to be explained in a steering meeting.
    r.ok(/DELIVERY_FIELD_GROUP/.test(body),
      "the form takes its fields from the delivery group the server declares");
    r.ok(!/"money_annual"|'money_annual'|"person_days"|'person_days'/.test(body),
      "...and no unit key is written out in the component");
    r.ok(!/Money, per year/.test(body),
      "...nor any unit's label, which would be a second list to keep in step");
    r.ok(/option_labels/.test(body),
      "...the labels come from the registry with the options");

    // A CARD IS SCANNED. Eight always-present rows would bury the one thing
    // the board exists to show, so only what has been filled in is drawn.
    r.ok(/if \(bits\.length === 0\) return null/.test(body),
      "a card with no plan draws no plan row at all");
    // "not set" and "zero" are different answers — the same rule the rating
    // follows, where "not yet rated" must not be printed over work the room
    // rated, and a 0-day estimate nobody made must not look like one they did.
    r.ok(/effort_person_days !== null/.test(body),
      "an absent effort is distinguished from an effort of zero");

    // THE EDIT CONTROL MUST NOT ALSO LIFT THE CARD. The card is the drag
    // handle, so a press that reaches a button inside it has to stop there —
    // the same rule the matrix's "+N more" needed.
    r.ok(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/.test(body),
      "opening the plan does not start a drag");

    // A GRID, NOT A WRAPPING FLEX ROW. The first version was flex, measured
    // correctly at 1440px and came out 303/303/618 at 900 — a flex LINE
    // shares out its own free space, so the one column that wrapped took the
    // whole of its line. Grid tracks are shared by every row, so the columns
    // stay equal at every width. Only a real browser found this.
    const track = body.match(/repeat\(auto-fit,\s*minmax\((\d+(?:\.\d+)?)rem,\s*1fr\)\)/);
    r.ok(Boolean(track),
      "the columns are equal grid tracks that collapse when unoccupied", track?.[0]);
    r.ok(!/flex-wrap/.test(body.slice(0, body.indexOf("data-delivery-grid"))),
      "and the grid is not a wrapping flex row, where a lone column would take a whole line");
    if (track) {
      // THE FLOOR HAS TO BE BELOW THE WIDTH BEING FILLED. The capture board
      // shipped a fix that changed nothing on screen because 4 x 19rem was
      // wider than the 1192px content column, so the panels could never be
      // grown out of.
      const total = Number(track[1]) * 16 * board0.data.states.length;
      r.ok(total < 1192,
        "and the columns at their floor fit inside the content column",
        `${board0.data.states.length} x ${track[1]}rem = ${total}px`);
    }

    r.ok(/overflow-y-auto/.test(body) && /overscroll-contain/.test(body),
      "each column scrolls internally, so every column stays on screen");

    // BOTH NUMBERS ON THE CARD. The facilitator's rank is the decision and
    // the average is the room's view; showing one without the other makes it
    // look unanimous.
    r.ok(/item\.rank/.test(body) && /rating\.voters/.test(body),
      "a card carries its rank AND how many people rated it");
    r.ok(/contributors/.test(body),
      "with the denominator that count needs, in the title");
    r.ok(/object_state !== "approved"/.test(body),
      "and says so when the work has not been approved");

    // The export button is config-gated, not always present.
    r.ok(/exports\.includes\("jira"\)/.test(body),
      "the Export to Jira button appears only where the config declares it");

    // The drag's two performance rules live in the shared hook, which
    // tows-matrix.js pins. What belongs here is the hit test, which each
    // caller writes for itself.
    r.ok(/elementsFromPoint/.test(body),
      "hit-testing reads the live document rather than cached rectangles");
    r.ok(/can_move/.test(body),
      "and the drag is wired only for a caller the server says may move a card");

    const noCol = await c.query(
      `select count(*)::int as n from pg_constraint c
       where c.conrelid = 'public.recommendations'::regclass and c.contype = 'c'
         and pg_get_constraintdef(c.oid) ilike '%delivery_state%'`,
    );
    // A CHECK here would be the fifth hardcoded enum this schema has removed.
    r.ok(noCol.rows[0].n === 0,
      "the column carries no CHECK — the state list is configuration, not a database enum");
  } finally {
    // `cleanup` takes { ids, titlePrefixes } — passing the bare `made` map
    // destructures to all defaults and deletes NOTHING, silently. This suite
    // did exactly that, and a browser probe found nine of its initiatives
    // still sitting in the demo workshop. The prefix sweep is the belt to the
    // id list's braces, since an id is only collected when a create succeeded.
    await c
      .query(`delete from public.weights where object_id = any($1::uuid[])`, [made.recommendations])
      .catch(() => {});
    await cleanup(c, {
      titlePrefixes: [PREFIX],
      ids: { recommendations: made.recommendations, initiatives: made.initiatives },
    });
  }
});
