// Phase 3 — the AI Strategy Assistant.
//
// Each execute is a real, paid Anthropic call, so this suite makes only three
// and reuses their outputs. The assertions that matter are governance ones:
// AI never approves, accepted suggestions land in `submitted`, and rate
// limits are checked before any provider call.

import { runSuite, clients, client, token, cleanup, resetDemoState, ACCOUNTS } from "../lib/harness.js";

runSuite("ai", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, analyst: A, participant: P } = await clients(baseUrl, ["facilitator", "analyst", "participant"]);
  const createdFactors = [], createdObjects = [];

  try {
    r.section('the assistant is offered from config, and keeps its prompts');
    const st = await F('GET', `/workshops/${WS}/ai?stage_key=threat_discovery`);
    r.ok(st.data.configured === true, 'AI reports configured');
    r.ok(st.data.functions.some(f => f.function_key === 'artifact_suggestion'),
      'capture functions offered on THREAT discovery (prompt seeded for strength only)',
      st.data.functions.map(f => f.function_key).join(','));
    r.ok(!JSON.stringify(st.data).includes('prompt_template') && !JSON.stringify(st.data).includes('You are the AI'),
      'prompt templates never reach the client');

    const stSyn = await F('GET', `/workshops/${WS}/ai?stage_key=theme_generation`);
    r.ok(stSyn.data.functions.some(f => f.function_key === 'theme_generation'),
      'synthesize stage offers theme_generation');
    r.ok(!stSyn.data.functions.some(f => f.function_key === 'artifact_suggestion'),
      'capture-only functions are NOT offered on a synthesize stage');
    r.section('role-based rate limits (App Spec 12.21)');
    const stP = await P('GET', `/workshops/${WS}/ai`);
    r.ok(st.data.limit_per_hour === 100, 'facilitator limit is 100/hour', st.data.limit_per_hour);
    r.ok(stP.data.limit_per_hour === 20, 'participant limit is 20/hour', stP.data.limit_per_hour);

    const pid = (await c.query('select id from public.profiles where email=$1', ['dana.whitfield@example.com'])).rows[0].id;
    await c.query(
      `insert into public.ai_sessions (user_id, workshop_id, prompt_type, status)
       select $1, $2, 'ratelimit_probe', 'completed' from generate_series(1,20)`, [pid, WS]);
    const blocked = await P('POST', `/workshops/${WS}/ai/execute`,
      { stage_key: 'threat_discovery', function_key: 'artifact_suggestion' });
    r.ok(!blocked.success && blocked.error.code === 'RATE_LIMITED',
      'participant blocked at their limit BEFORE any provider call', blocked.error && blocked.error.message);
    await c.query(`delete from public.ai_sessions where prompt_type = 'ratelimit_probe'`);
    r.section('execute + human review (real model calls from here)');
    const ex = await F('POST', `/workshops/${WS}/ai/execute`,
      { stage_key: 'threat_discovery', function_key: 'artifact_suggestion' });
    r.ok(ex.success, 'execute returns suggestions', ex.error && ex.error.message);
    const items = Object.values(ex.data.content).find(v => Array.isArray(v)) || [];
    r.ok(items.length > 0, 'suggestions present', items.length);
    r.ok(ex.data.human_review_status === 'pending', 'output starts pending, never approved');

    const outID = ex.data.output_id;
    const acc = await F('POST', `/workshops/${WS}/ai/outputs/${outID}/review`,
      { action: 'accept', index: 0, stage_key: 'threat_discovery' });
    r.ok(acc.success, 'accept one suggestion', acc.error && acc.error.message);
    r.ok(acc.data.object_state === 'submitted', 'the created object is SUBMITTED, not approved', acc.data.object_state);
    if (acc.data) createdFactors.push(acc.data.converted_object_id);

    const row = (await c.query(
      `select state, is_ai_generated, source_ai_output_id from public.factors where id=$1`,
      [acc.data.converted_object_id])).rows[0];
    r.ok(row.state === 'submitted', 'DB agrees the factor is submitted', row.state);
    r.ok(row.is_ai_generated === true, 'factor is flagged AI generated');
    r.ok(row.source_ai_output_id === outID, 'factor traces back to the AI output');

    const outRow = (await c.query(
      `select human_review_status, reviewed_by, converted_object_type, converted_object_id
       from public.ai_outputs where id=$1`, [outID])).rows[0];
    r.ok(outRow.human_review_status === 'accepted', 'output marked accepted', outRow.human_review_status);
    r.ok(!!outRow.reviewed_by, 'the acceptance names a reviewer');
    r.ok(outRow.converted_object_type === 'factor' && !!outRow.converted_object_id,
      'output records what it became (spec 12.20)');

    const again = await F('POST', `/workshops/${WS}/ai/outputs/${outID}/review`,
      { action: 'accept', index: 1, stage_key: 'threat_discovery' });
    r.ok(!again.success && again.error.code === 'INVALID_STATE_TRANSITION',
      'an already-reviewed output cannot be reviewed twice', again.error && again.error.message);
    r.section('participants may not convert AI output into content');
    const ex2 = await F('POST', `/workshops/${WS}/ai/execute`,
      { stage_key: 'threat_discovery', function_key: 'artifact_suggestion' });
    const pAcc = await P('POST', `/workshops/${WS}/ai/outputs/${ex2.data.output_id}/review`,
      { action: 'accept', index: 0, stage_key: 'threat_discovery' });
    r.ok(!pAcc.success && pAcc.error.code === 'FORBIDDEN',
      'participant cannot accept a suggestion', pAcc.error && pAcc.error.message);

    const rej = await F('POST', `/workshops/${WS}/ai/outputs/${ex2.data.output_id}/review`, { action: 'reject' });
    r.ok(rej.success && rej.data.human_review_status === 'rejected', 'facilitator can reject an output');
    r.section('theme generation converts into a real, traceable theme');
    const ex3 = await F('POST', `/workshops/${WS}/ai/execute`,
      { stage_key: 'theme_generation', function_key: 'theme_generation' });
    r.ok(ex3.success, 'theme_generation executes', ex3.error && ex3.error.message);
    if (ex3.success) {
      const t = Object.values(ex3.data.content).find(v => Array.isArray(v)) || [];
      r.ok(t.length > 0, 'themes suggested', t.length);
      const accT = await F('POST', `/workshops/${WS}/ai/outputs/${ex3.data.output_id}/review`,
        { action: 'accept', index: 0, stage_key: 'theme_generation' });
      r.ok(accT.success, 'accept a suggested theme', accT.error && accT.error.message);
      if (accT.success) {
        createdObjects.push(['syntheses', accT.data.converted_object_id]);
        const ev = (await c.query(
          `select count(*)::int n from public.synthesis_factors where synthesis_id=$1`,
          [accT.data.converted_object_id])).rows[0].n;
        r.ok(ev > 0, 'the accepted theme kept its cited factors as real rows', ev);
        const s = (await c.query(`select state, generated_by from public.syntheses where id=$1`,
          [accT.data.converted_object_id])).rows[0];
        r.ok(s.state === 'submitted' && s.generated_by === 'ai',
          'theme is submitted and labelled AI generated', s.state + '/' + s.generated_by);
      }
    }
    r.section('sessions are audited either way');
    const sess = (await c.query(
      `select status, count(*)::int n from public.ai_sessions where workshop_id=$1 group by status`, [WS])).rows;
    r.ok(sess.some(r => r.status === 'completed'), 'completed sessions recorded',
      sess.map(r => r.status + '=' + r.n).join(' '));
    const aud = (await c.query(
      `select count(*)::int n from public.audit_events where action like 'ai.%'`)).rows[0].n;
    r.ok(aud > 0, 'ai.* audit events written', aud);

  } finally {
    r.section('cleanup');
    for (const id of createdFactors.filter(Boolean)) {
      await c.query('delete from public.factors where id=$1', [id]);
    }
    for (const [t, id] of createdObjects) {
      if (id) await c.query(`delete from public.${t} where id=$1`, [id]);
    }
    await c.query(`delete from public.ai_sessions where prompt_type='ratelimit_probe'`);
    r.note('created rows removed (ai_sessions/ai_outputs kept as the audit trail)');
    await c.end();
  }
});
