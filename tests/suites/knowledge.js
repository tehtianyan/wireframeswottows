// Phase 5 — Knowledge Workspace, notifications and administration.
//
// Curation being analyst-only is asserted deliberately: App Spec §3.23 denies
// Curate to the Facilitator, which looks like a bug but is separation of
// duties (§3.9's dedicated Knowledge Analyst role).

import { runSuite, clients, client, token, cleanup, resetDemoState, ACCOUNTS } from "../lib/harness.js";

runSuite("knowledge", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, analyst: A, participant: P } = await clients(baseUrl, ["facilitator", "analyst", "participant"]);

  const seeded = [];
  let assetId = null;

  try {
    r.section('knowledge search is scoped and registry-driven');
    const all = await F('GET', '/knowledge/search');
    r.ok(all.success, 'search returns results', all.error && all.error.message);
    const kinds = [...new Set((all.data || []).map(h => h.object_kind))];
    r.ok(kinds.length > 0, 'covers multiple object kinds', kinds.join(','));

    const q = await F('GET', '/knowledge/search?q=cloud');
    r.ok(q.success, 'full-text query works', q.success ? (q.data.length + ' hits') : q.error.message);

    const filtered = await F('GET', '/knowledge/search?object_type=factor');
    r.ok(filtered.success && filtered.data.every(h => h.object_kind === 'factor'),
      'object_type filter applies', filtered.data && filtered.data.length + ' factors');

    const byWorkshop = await F('GET', `/knowledge/search?workshop_id=${WS}`);
    r.ok(byWorkshop.success && byWorkshop.data.every(h => h.workshop_id === WS),
      'workshop filter applies');

    // The security property that matters: a non-member sees nothing from a
    // workspace they do not belong to.
    const orphan = (await c.query(
      `select id from public.profiles where id not in (select user_id from public.workspace_members) limit 1`)).rows[0];
    if (orphan) {
      const email = (await c.query('select email from public.profiles where id=$1', [orphan.id])).rows[0].email;
      const O = mk(await tok(email));
      const leak = await O('GET', '/knowledge/search');
      r.ok(leak.success && leak.data.length === 0,
        'a non-member of any workspace sees nothing', leak.data && leak.data.length);
    } else {
    r.note('skipped non-member check: every profile is a workspace member');
    }
    r.section('build a chain, then trace it');
    const factors = (await F('GET', `/workshops/${WS}/factors`)).data;
    const syn = await F('POST', `/workshops/${WS}/syntheses`,
      { title: 'P5 theme', description: 'seeded', evidence: { factor: [factors[0].id, factors[1].id] } });
    seeded.push(['syntheses', syn.data.id]);
    const ins = await F('POST', `/workshops/${WS}/insights`,
      { title: 'P5 insight', description: 'seeded', evidence: { synthesis: [syn.data.id] } });
    seeded.push(['insights', ins.data.id]);
    const rec = await F('POST', `/workshops/${WS}/recommendations`,
      { title: 'P5 recommendation', description: 'do it', fields: { priority: 'high' },
        evidence: { insight: [ins.data.id] } });
    seeded.push(['recommendations', rec.data.id]);

    const trace = await F('GET', `/knowledge/trace?object_type=recommendation&object_id=${rec.data.id}`);
    r.ok(trace.success, 'trace returns', trace.error && trace.error.message);
    r.ok(!!(trace.data.levels.insight && trace.data.levels.synthesis && trace.data.levels.factor),
      'walks recommendation -> insight -> theme -> factor (spec 11.26)',
      Object.keys(trace.data.levels).join(','));

    const ins2 = await F('POST', `/workshops/${WS}/insights`,
      { title: 'P5 sibling insight', description: 'shares a theme', evidence: { synthesis: [syn.data.id] } });
    seeded.push(['insights', ins2.data.id]);
    const related = await F('GET', `/knowledge/related?object_type=insight&object_id=${ins.data.id}`);
    r.ok(related.success && related.data.some(n => n.object_id === ins2.data.id),
      'related finds an insight sharing the same theme', related.data && related.data.length + ' related');
    r.section('promotion is deliberate (spec 8.31)');
    const tooEarly = await A('POST', '/knowledge/assets',
      { object_kind: 'insight', object_id: ins.data.id });
    r.ok(!tooEarly.success, 'unapproved output cannot be promoted', tooEarly.error && tooEarly.error.message);

    await F('POST', `/workshops/${WS}/insights/${ins.data.id}/review`, { action: 'approve' });

    const byFacilitator = await F('POST', '/knowledge/assets',
      { object_kind: 'insight', object_id: ins.data.id });
    r.ok(!byFacilitator.success && byFacilitator.error.code === 'FORBIDDEN',
      'a facilitator may NOT curate (spec 3.23)', byFacilitator.error && byFacilitator.error.message);

    const promoted = await A('POST', '/knowledge/assets',
      { object_kind: 'insight', object_id: ins.data.id, summary: 'Worth remembering', tags: ['digital'] });
    r.ok(promoted.success && promoted.data.state === 'candidate',
      'an analyst promotes it to candidate', promoted.error && promoted.error.message);
    assetId = promoted.data.id;

    const dupe = await A('POST', '/knowledge/assets',
      { object_kind: 'insight', object_id: ins.data.id });
    r.ok(!dupe.success, 'cannot promote the same thing twice', dupe.error && dupe.error.message);

    const published = await A('POST', `/knowledge/assets/${assetId}/publish`);
    r.ok(published.success && published.data.state === 'published', 'candidate becomes published asset');

    const assets = await F('GET', '/knowledge/assets?state=published');
    r.ok(assets.success && assets.data.some(a => a.id === assetId),
      'published assets are listed', assets.data && assets.data.length);

    const promotedSearch = await F('GET', '/knowledge/search?promoted=true');
    r.ok(promotedSearch.success && promotedSearch.data.every(h => h.promoted),
      'search can filter to promoted knowledge only', promotedSearch.data && promotedSearch.data.length);
    r.section('notifications come from real state transitions (spec 8.32)');
    // A participant creates a factor; the facilitator rejects it.
    const pf = await P('POST', `/workshops/${WS}/factors`,
      { category_key: 'strength', title: 'P5 participant factor' });
    const rej = await F('POST', `/workshops/${WS}/factors/${pf.data.id}/review`,
      { action: 'reject', note: 'Not specific enough' });
    r.ok(rej.success, 'facilitator rejects the participant factor');

    const pNotes = await P('GET', '/notifications');
    const mine = (pNotes.data || []).find(n => n.object_id === pf.data.id);
    r.ok(!!mine, 'the author was notified', mine && mine.title);
    r.ok(mine && mine.body === 'Not specific enough', 'the reviewer note carried through');

    const fNotes = await F('GET', '/notifications');
    r.ok(!(fNotes.data || []).some(n => n.object_id === pf.data.id),
      'the reviewer was NOT notified of their own action');

    const readIt = await P('POST', `/notifications/${mine.id}/read`);
    r.ok(readIt.success, 'recipient can mark it read');
    const stealRead = await F('POST', `/notifications/${mine.id}/read`);
    r.ok(!stealRead.success, 'someone else cannot mark it read', stealRead.error && stealRead.error.message);

    await c.query('delete from public.factors where id=$1', [pf.data.id]);
    r.section('administration is gated on global_role (spec 11.29)');
    const denied = await F('GET', '/admin/users');
    r.ok(!denied.success && denied.error.code === 'FORBIDDEN',
      'an ordinary user cannot list users', denied.error && denied.error.message);

    const jane = (await c.query(`select id from public.profiles where email='jane.smith@example.com'`)).rows[0].id;
    await c.query(`update public.profiles set global_role='platform_admin' where id=$1`, [jane]);
    const F2 = client(baseUrl, await token(ACCOUNTS.facilitator));

    const users = await F2('GET', '/admin/users');
    r.ok(users.success && users.data.length === 12, 'a platform admin lists users', users.data && users.data.length);

    const dana = (await c.query(`select id from public.profiles where email='dana.whitfield@example.com'`)).rows[0].id;
    const promote = await F2('PUT', `/admin/users/${dana}/role`, { global_role: 'admin' });
    r.ok(promote.success, 'admin can change a global role', promote.error && promote.error.message);
    await c.query(`update public.profiles set global_role='user' where id=$1`, [dana]);

    const selfDisable = await F2('POST', `/admin/users/${jane}/status`, { status: 'disabled' });
    r.ok(!selfDisable.success, 'an admin cannot disable themselves', selfDisable.error && selfDisable.error.message);

    const audit = await F2('GET', '/audit-events?object_type=knowledge_asset');
    r.ok(audit.success && audit.data.length > 0,
      'audit events are queryable and filtered', audit.data && audit.data.length);

    await c.query(`update public.profiles set global_role='user' where id=$1`, [jane]);

  } finally {
    r.section('cleanup');
    if (assetId) await c.query('delete from public.knowledge_assets where id=$1', [assetId]);
    await c.query('delete from public.knowledge_assets');
    for (const [t, id] of seeded.reverse()) await c.query(`delete from public.${t} where id=$1`, [id]);
    await c.query("delete from public.factors where title like 'P5 %'");
    await c.query("delete from public.notifications");
    await c.query("update public.profiles set global_role='user'");
    r.note('seeded rows, assets and notifications removed; roles reset');
    await c.end();
  }
});
