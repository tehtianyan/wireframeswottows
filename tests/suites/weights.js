// Weights — the generalisation of voting.
//
// Two things are being proved here.
//
// FIRST, that the refactor is invisible. Voting now runs through pkg/weights,
// and the prioritization screens are in front of UAT testers, so the vote
// endpoints must behave exactly as they did: same budget from config, same
// idempotency, same clearing with zero, same refusals.
//
// SECOND, that the scale is genuinely configuration. The seeded methodologies
// mostly use 1-5, which is the sort of convention that quietly becomes a
// constant. So this suite defines two deliberately awkward scales on a
// throwaway methodology — 0-100 in steps of 5, and -3..+3 — and drives both
// through the real endpoints. If either needs code, the abstraction failed.
import { runSuite, clients, ACCOUNTS } from "../lib/harness.js";

const PROBE = "weight-probe";

runSuite("weights", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { participant: P, facilitator: F, executive: E } =
    await clients(baseUrl, ["participant", "facilitator", "executive"]);
  let probeWorkshop = null;

  try {
    const factors = (await P("GET", `/workshops/${WS}/factors`)).data;
    const [f1, f2] = factors;

    // ---- voting, unchanged ------------------------------------------
    r.section("the vote budget still comes from methodology config");
    let v = await P("GET", `/workshops/${WS}/votes`);
    r.ok(v.success && v.data.budget === 20, "SWOT-TOWS budget is 20", v.data?.budget);
    r.ok(v.data.remaining === v.data.budget - v.data.used,
      "remaining is consistent with used", v.data?.remaining);

    r.section("allocation, idempotency and clearing");
    let s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 3 });
    r.ok(s.success && s.data.used === 3, "allocate 3", s.data?.used ?? s.error?.message);

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 3 });
    r.ok(s.success && s.data.used === 3,
      "re-sending the same total does not double-spend — PRI-12", s.data?.used);

    s = await P("PUT", `/workshops/${WS}/factors/${f2.id}/vote`, { value: 5 });
    r.ok(s.success && s.data.used === 8, "a second factor adds to the total", s.data?.used);

    v = await P("GET", `/workshops/${WS}/votes`);
    r.ok(v.data.allocations.length === 2, "both allocations are listed", v.data.allocations.length);
    r.ok(v.data.allocations.every((a) => Number.isInteger(a.vote_value)),
      "vote values come back as whole numbers, as the UI expects",
      JSON.stringify(v.data.allocations.map((a) => a.vote_value)));

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 0 });
    r.ok(s.success && s.data.used === 5, "zero clears that allocation — PRI-05", s.data?.used);

    r.section("the budget is enforced");
    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 16 });
    r.ok(!s.success, "spending past the budget is refused — PRI-06", s.error?.message);

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 15 });
    r.ok(s.success && s.data.used === 20 && s.data.remaining === 0,
      "spending exactly to the budget is allowed", s.data?.used);

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: -1 });
    r.ok(!s.success, "a negative allocation is refused by the scale", s.error?.message);

    r.section("role and scope still hold");
    s = await E("PUT", `/workshops/${WS}/factors/${f1.id}/vote`, { value: 1 });
    r.ok(!s.success, "an executive viewer cannot vote — PRI-10", s.error?.message);

    s = await P("PUT", `/workshops/${WS}/factors/00000000-0000-0000-0000-000000000000/vote`,
      { value: 1 });
    r.ok(!s.success, "voting on a factor outside the workshop is refused", s.error?.message);

    // ---- the generic surface ----------------------------------------
    r.section("the generic endpoint describes the same weight");
    const wres = await P("GET", `/workshops/${WS}/weights`);
    r.ok(wres.success, "GET /weights responds", wres.error?.message);
    const voteDef = wres.data?.definitions?.find((d) => d.key === "vote");
    r.ok(voteDef?.constraint_type === "budget" && voteDef?.constraint_total === 20,
      "the vote definition carries its budget", JSON.stringify(voteDef?.constraint_total));
    r.ok(voteDef?.scale_max === null, "a vote's scale is unbounded", String(voteDef?.scale_max));
    r.ok(wres.data?.spent?.vote === 20, "spent agrees with the vote endpoint", wres.data?.spent?.vote);
    const total = wres.data?.totals?.find((t) => t.object_id === f1.id);
    r.ok(total?.value === 15, "the aggregate sums allocations per object", total?.value);

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/weights/vote`, { value: 4 });
    r.ok(s.success && s.data.used === 9,
      "writing a vote through the generic path honours the same budget",
      s.data?.used ?? s.error?.message);
    v = await P("GET", `/workshops/${WS}/votes`);
    r.ok(v.data.used === 9, "and the vote endpoint sees it", v.data?.used);

    s = await P("PUT", `/workshops/${WS}/factors/${f1.id}/weights/nonexistent`, { value: 1 });
    r.ok(!s.success, "an undefined weight key is refused", s.error?.message);

    // Everything downstream that reads a vote count. Four separate readers
    // still pointed at public.votes after the refactor and would have
    // silently reported zero — the factor list, the AI context, the report
    // renderer and the roster view. Nothing asserted any of them, which is
    // exactly why they were missed.
    r.section("everything that reports a vote count follows the refactor");
    // The factor's own aggregate is 4 — what this participant last put on it.
    // Their 9 is the total across both factors, which is a different number
    // and the one the budget panel shows.
    const listed = await P("GET", `/workshops/${WS}/factors`);
    const f1Listed = listed.data?.find((f) => f.id === f1.id);
    const f2Listed = listed.data?.find((f) => f.id === f2.id);
    r.ok(f1Listed?.votes === 4 && f2Listed?.votes === 5,
      "the factor list's vote counts read weights, not the retired votes table",
      `${f1Listed?.votes} and ${f2Listed?.votes}`);

    const roster = await c.query(
      `select votes_used from public.workshop_roster
       where workshop_id = $1 and email = $2`, [WS, ACCOUNTS.participant]);
    r.ok(roster.rows[0]?.votes_used === 9,
      "the roster view sums allocations across factors, so the Participants panel is right",
      roster.rows[0]?.votes_used);

    await c.query(`delete from public.weights where workshop_id = $1`, [WS]);

    // ---- scales the engine must not assume --------------------------
    // A throwaway methodology whose scales are nothing like 1-5. If any of
    // this needs code, "the range is configuration" was not true.
    r.section("the scale is configuration, not a constant");
    await seedProbeMethodology(c);

    const workspaces = await F("GET", "/workspaces");
    const created = await F("POST", "/workshops", {
      workspace_id: workspaces.data[0].id, name: "Weight probe workshop",
      methodology_key: PROBE, objective: "prove the scale is configurable",
    });
    r.ok(created.success, "create a workshop on the probe methodology", created.error?.message);
    probeWorkshop = created.data?.id;

    const detail = await F("GET", `/workshops/${probeWorkshop}`);
    const defs = detail.data?.methodology?.weights ?? [];
    const coverage = defs.find((d) => d.key === "coverage");
    const alignment = defs.find((d) => d.key === "alignment");
    r.ok(coverage?.scale_min === 0 && coverage?.scale_max === 100 && coverage?.scale_step === 5,
      "a 0-100 step-5 scale survives into the API", JSON.stringify(coverage && [coverage.scale_min, coverage.scale_max, coverage.scale_step]));
    r.ok(alignment?.scale_min === -3 && alignment?.scale_max === 3,
      "a -3..+3 scale survives into the API", JSON.stringify(alignment && [alignment.scale_min, alignment.scale_max]));
    r.ok(Array.isArray(alignment?.scale_labels) && alignment.scale_labels.length === 7,
      "its ordinal labels cover every step", alignment?.scale_labels?.length);

    const pf = await F("POST", `/workshops/${probeWorkshop}/factors`,
      { category_key: "probe", title: "A factor to weigh" });
    r.ok(pf.success, "capture a factor on the probe methodology", pf.error?.message);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/coverage`,
      { value: 65 });
    r.ok(s.success, "65 lands on a step of 5 and is accepted", s.error?.message);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/coverage`,
      { value: 67 });
    r.ok(!s.success && /steps of 5/.test(s.error?.message ?? ""),
      "67 is refused, quoting the configured step", s.error?.message);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/coverage`,
      { value: 120 });
    r.ok(!s.success && /above 100/.test(s.error?.message ?? ""),
      "120 is refused, quoting the configured maximum", s.error?.message);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/alignment`,
      { value: -3 });
    r.ok(s.success, "a negative value is accepted on a scale that allows it", s.error?.message);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/alignment`,
      { value: -4 });
    r.ok(!s.success && /below -3/.test(s.error?.message ?? ""),
      "-4 is refused, quoting the configured minimum", s.error?.message);

    const pw = await F("GET", `/workshops/${probeWorkshop}/weights`);
    const alignTotal = pw.data?.totals?.find((t) => t.weight_key === "alignment");
    r.ok(alignTotal?.value === -3, "the stored value round-trips", alignTotal?.value);
    r.ok(alignTotal?.label === "Much worse",
      "and carries its ordinal label rather than only a number", alignTotal?.label);

    // The participant must actually be IN the probe workshop, or the refusal
    // below would be a membership check rather than the role check it claims
    // to be — a test that passes for the wrong reason.
    await c.query(
      `insert into public.workshop_members (workshop_id, user_id, role, joined_at)
       select $1, p.id, 'participant', now() from public.profiles p
       where p.email = $2
         and not exists (select 1 from public.workshop_members wm
                         where wm.workshop_id = $1 and wm.user_id = p.id)`,
      [probeWorkshop, ACCOUNTS.participant]);

    const reachable = await P("GET", `/workshops/${probeWorkshop}/weights`);
    r.ok(reachable.success,
      "the participant is now a member and can read the workshop", reachable.error?.message);

    s = await P("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/alignment`,
      { value: 1 });
    r.ok(!s.success && /role/.test(s.error?.message ?? ""),
      "a member whose role is not allowed is refused on the ROLE, not on access",
      s.error?.message);

    const rows = await c.query(
      `select count(*)::int n from public.weights where workshop_id = $1 and weight_key = 'alignment'`,
      [probeWorkshop]);
    r.ok(rows.rows[0].n === 1,
      "a per-object weight keeps exactly one row, not one per person", rows.rows[0].n);

    s = await F("PUT", `/workshops/${probeWorkshop}/factors/${pf.data.id}/weights/alignment`,
      { value: null });
    r.ok(s.success, "an explicit null clears the value", s.error?.message);
    const after = await c.query(
      `select count(*)::int n from public.weights where workshop_id = $1 and weight_key = 'alignment'`,
      [probeWorkshop]);
    r.ok(after.rows[0].n === 0, "and the row is gone", after.rows[0].n);
  } finally {
    await c.query(`delete from public.weights where workshop_id = $1`, [WS]);
    if (probeWorkshop) {
      await c.query(`delete from public.workshops where id = $1`, [probeWorkshop]);
    }
    await c.query(
      `delete from public.methodologies where key = $1`, [PROBE]);
    r.note("allocations cleared; probe methodology and workshop removed");
  }
});

// A methodology that exists only for this suite, with scales chosen to break
// anything that assumed 1-5. Removed again in the finally block above.
async function seedProbeMethodology(c) {
  await c.query(`delete from public.methodologies where key = $1`, [PROBE]);
  const m = (await c.query(
    `insert into public.methodologies (key, name, description, is_active)
     values ($1, 'Weight probe', 'Temporary fixture for tests/suites/weights.js', true)
     returning id`, [PROBE])).rows[0].id;

  await c.query(
    `insert into public.methodology_factor_categories (methodology_id, key, name, color_token, sort_order)
     values ($1, 'probe', 'Probe', 'category-1', 1)`, [m]);

  await c.query(
    `insert into public.methodology_stages (methodology_id, key, name, sequence_number, stage_type, config)
     values ($1, 'probe_capture', 'Probe Capture', 1, 'capture', '{"factor_category_key":"probe"}'::jsonb)`,
    [m]);

  await c.query(
    `insert into public.methodology_weights
       (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step,
        constraint_type, per_participant, aggregate, allowed_roles, sort_order)
     values
       ($1, 'coverage', 'Coverage', 'factor', 0, 100, 5, 'single', false, 'latest',
        array['facilitator','analyst'], 1)`, [m]);

  await c.query(
    `insert into public.methodology_weights
       (methodology_id, key, name, applies_to, scale_min, scale_max, scale_step, scale_labels,
        constraint_type, per_participant, aggregate, allowed_roles, sort_order)
     values
       ($1, 'alignment', 'Alignment', 'factor', -3, 3, 1,
        $2::jsonb, 'single', false, 'latest', array['facilitator','analyst'], 2)`,
    [m, JSON.stringify(["Much worse", "Worse", "Slightly worse", "Same",
      "Slightly better", "Better", "Much better"])]);
}
