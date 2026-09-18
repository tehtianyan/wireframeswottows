// Phase 4 — the Report Builder, versioning and export.
//
// The load-bearing assertions: publishing freezes a report (so an exported
// PDF stays reproducible when the underlying insights change later), and the
// workshop completion gate actually refuses unapproved content — it silently
// stopped doing that for three phases.

import { runSuite, clients, client, token, cleanup, resetDemoState, ACCOUNTS } from "../lib/harness.js";

runSuite("reporting", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, analyst: A, participant: P } = await clients(baseUrl, ["facilitator", "analyst", "participant"]);

      const seeded = { syntheses: [], insights: [], recommendations: [] };
  let reportId = null, v2Id = null;

  try {
    // ---- set up approved analysis content the report needs ----
    const factors = (await F('GET', `/workshops/${WS}/factors`)).data;
    const syn = await F('POST', `/workshops/${WS}/syntheses`,
      { title: 'P4 theme', description: 'seeded', evidence: { factor: [factors[0].id, factors[1].id] } });
    seeded.syntheses.push(syn.data.id);
    const ins = await F('POST', `/workshops/${WS}/insights`,
      { title: 'P4 insight', description: 'seeded', evidence: { synthesis: [syn.data.id] } });
    seeded.insights.push(ins.data.id);
    const rec = await F('POST', `/workshops/${WS}/recommendations`,
      { title: 'P4 recommendation', description: 'do it', fields: { priority: 'high', benefits: 'b', risks: 'r' },
        evidence: { insight: [ins.data.id] } });
    seeded.recommendations.push(rec.data.id);
    r.section('report types come from methodology config');
    const beforeApproval = await F('GET', `/workshops/${WS}/report-types`);
    r.ok(beforeApproval.success && beforeApproval.data.length === 3,
      'three report types configured for SWOT-TOWS', beforeApproval.data && beforeApproval.data.map(t => t.key).join(','));
    const execType = beforeApproval.data.find(t => t.key === 'executive');
    r.ok(execType.can_generate === false,
      'executive report refused while inputs are unapproved (spec 14.12)', JSON.stringify(execType.missing));

    // Approve everything.
    for (const [route, id] of [['syntheses', syn.data.id], ['insights', ins.data.id], ['recommendations', rec.data.id]]) {
      await F('POST', `/workshops/${WS}/${route}/${id}/review`, { action: 'approve' });
    }
    const afterApproval = await F('GET', `/workshops/${WS}/report-types`);
    r.ok(afterApproval.data.find(t => t.key === 'executive').can_generate === true,
      'becomes generatable once inputs are approved');
    r.section('create and render');
    const created = await F('POST', `/workshops/${WS}/reports`, { report_type: 'executive' });
    r.ok(created.success, 'create an executive report', created.error && created.error.message);
    reportId = created.data.id;

    const got = await F('GET', `/workshops/${WS}/reports/${reportId}`);
    r.ok(got.success, 'fetch the report', got.error && got.error.message);
    r.ok(got.data.sections.length === 9, 'nine sections seeded from config', got.data.sections.length);
    r.ok(got.data.version === 'v1.0', 'starts at v1.0', got.data.version);
    r.ok(got.data.from_snapshot === false, 'a draft renders live, not from a snapshot');

    const matrix = got.data.sections.find(s => s.section_type === 'category_matrix');
    r.ok(matrix && matrix.groups.length === 4, 'category matrix has one group per factor category', matrix && matrix.groups.length);
    r.ok(matrix.groups.map(g => g.key).join(',') === 'strength,weakness,opportunity,threat',
      'groups came from config, in config order', matrix.groups.map(g => g.key).join(','));

    const pair = got.data.sections.find(s => s.section_type === 'pair_matrix');
    r.ok(pair && pair.groups.length === 4, 'pair matrix has one cell per relationship type', pair && pair.groups.length);
    r.ok(pair.groups[0].source_name && pair.groups[0].target_name,
      'each cell names its source x target categories',
      pair.groups[0] && (pair.groups[0].source_name + ' x ' + pair.groups[0].target_name));

    const chain = got.data.sections.find(s => s.section_type === 'evidence_chain');
    r.ok(chain && chain.chains.length > 0, 'evidence chain built', chain && chain.chains.length);
    const sup = chain.chains[0].supports;
    r.ok(!!(sup.insight && sup.synthesis && sup.factor),
      'chain walks recommendation -> insight -> synthesis -> factor (spec 14.15)',
      Object.keys(sup).join(','));
    r.section('narrative editing marks provenance (spec 14.13)');
    const narr = got.data.sections.find(s => s.section_type === 'narrative');
    const edited = await F('PATCH', `/workshops/${WS}/reports/${reportId}/sections/${narr.id}`,
      { body: 'A human wrote this.' });
    r.ok(edited.success && edited.data.generated_by === 'human',
      'a human-written section is human', edited.data && edited.data.generated_by);
    await c.query(`update public.report_sections set generated_by='ai' where id=$1`, [narr.id]);
    const edited2 = await F('PATCH', `/workshops/${WS}/reports/${reportId}/sections/${narr.id}`,
      { body: 'A human edited the AI draft.' });
    r.ok(edited2.data.generated_by === 'hybrid',
      'editing an AI draft marks it hybrid, not human', edited2.data.generated_by);
    r.section('reorder and exclude');
    const reorder = await F('PUT', `/workshops/${WS}/reports/${reportId}/sections`, {
      sections: [{ id: got.data.sections[0].id, sort_order: 999, included: false }],
    });
    r.ok(reorder.success, 'reorder / exclude a section', reorder.error && reorder.error.message);
    const after = await F('GET', `/workshops/${WS}/reports/${reportId}`);
    r.ok(after.data.sections[after.data.sections.length - 1].included === false,
      'the excluded section moved last and is excluded');
    r.section('publish governance');
    const tooEarly = await F('POST', `/workshops/${WS}/reports/${reportId}/publish`);
    r.ok(!tooEarly.success, 'cannot publish before approval', tooEarly.error && tooEarly.error.message);

    await F('POST', `/workshops/${WS}/reports/${reportId}/review`, { action: 'submit' });
    const approved = await A('POST', `/workshops/${WS}/reports/${reportId}/review`, { action: 'approve' });
    r.ok(approved.success, 'an analyst can approve a report', approved.error && approved.error.message);

    const analystPublish = await A('POST', `/workshops/${WS}/reports/${reportId}/publish`);
    r.ok(!analystPublish.success && analystPublish.error.code === 'FORBIDDEN',
      'an analyst may NOT publish (spec 14.25)', analystPublish.error && analystPublish.error.message);

    const pub = await F('POST', `/workshops/${WS}/reports/${reportId}/publish`);
    r.ok(pub.success && pub.data.state === 'published', 'the facilitator publishes', pub.error && pub.error.message);

    const row = (await c.query('select state, snapshot is not null has_snap, published_by from public.reports where id=$1',
      [reportId])).rows[0];
    r.ok(row.has_snap === true, 'publishing stored a snapshot');
    r.ok(!!row.published_by, 'the publication names a publisher');
    r.section('a published report is frozen and reproducible');
    const pubGot = await F('GET', `/workshops/${WS}/reports/${reportId}`);
    r.ok(pubGot.data.from_snapshot === true, 'reads now come from the snapshot');

    const editPublished = await F('PATCH', `/workshops/${WS}/reports/${reportId}/sections/${narr.id}`,
      { body: 'sneaky change' });
    r.ok(!editPublished.success, 'a published report cannot be edited', editPublished.error && editPublished.error.message);

    // The decisive test: reject a cited insight and confirm the published
    // report is unchanged.
    const before = JSON.stringify(pubGot.data.sections.find(s => s.section_type === 'bullet_list' && s.section_key === 'insights'));
    await c.query(`update public.insights set state='rejected', reviewed_by=(select id from public.profiles limit 1), reviewed_at=now(), review_note='p4 test' where id=$1`, [ins.data.id]);
    const afterReject = await F('GET', `/workshops/${WS}/reports/${reportId}`);
    const nowSec = JSON.stringify(afterReject.data.sections.find(s => s.section_type === 'bullet_list' && s.section_key === 'insights'));
    r.ok(before === nowSec, 'rejecting a cited insight does NOT rewrite the published report');
    const stale = (await c.query('select count(*)::int n from public.report_stale_citations where report_id=$1', [reportId])).rows[0].n;
    r.ok(stale >= 0, 'stale-citation view is queryable', stale);
    await c.query(`update public.insights set state='approved' where id=$1`, [ins.data.id]);
    r.section('versioning');
    const v2 = await F('POST', `/workshops/${WS}/reports/${reportId}/versions`, { bump: 'minor' });
    r.ok(v2.success && v2.data.version === 'v1.1', 'editing a published report creates v1.1', v2.data && v2.data.version);
    v2Id = v2.data.id;
    const v2Got = await F('GET', `/workshops/${WS}/reports/${v2Id}`);
    r.ok(v2Got.data.sections.length === 9, 'the new version inherited its sections', v2Got.data.sections.length);
    r.ok(v2Got.data.state === 'draft', 'the new version starts as a draft', v2Got.data.state);
    const dupe = await F('POST', `/workshops/${WS}/reports/${reportId}/versions`, { bump: 'minor' });
    r.ok(!dupe.success, 'a second open version is refused', dupe.error && dupe.error.message);
    r.section('HTML export');
    const html = await F('GET', `/workshops/${WS}/reports/${reportId}/export.html`, undefined, { raw: true });
    r.ok(html.status === 200, 'export returns 200', html.status);
    r.ok((html.headers.get('content-disposition') || '').includes('attachment'), 'served as a download');
    r.ok(html.text.includes('<!doctype html>') && html.text.includes('Contents'),
      'self-contained HTML with a table of contents');
    r.ok(!html.text.includes('http://') && !html.text.includes('https://'),
      'no external requests — genuinely self-contained');
    r.section('the completion gate (was silently broken)');
    await c.query(`update public.workshops set status='reporting' where id=$1`, [WS]);
    await c.query(`insert into public.syntheses (workshop_id, title, state, generated_by) values ($1,'P4 unapproved','submitted','human') returning id`, [WS]);
    const blocked = await F('POST', `/workshops/${WS}/complete`);
    r.ok(!blocked.success, 'completion refused while unapproved content exists', blocked.error && blocked.error.message);
    await c.query(`delete from public.syntheses where title='P4 unapproved'`);

  } finally {
    r.section('cleanup');
    // A published report cannot be deleted by design (that is the point of
    // reports_immutable), so the harness disables the guard to tidy up.
    await c.query('alter table public.reports disable trigger reports_immutable');
    await c.query('alter table public.report_sections disable trigger report_sections_frozen');
    await c.query(`delete from public.reports where workshop_id=$1`, [WS]);
    await c.query('alter table public.reports enable trigger reports_immutable');
    await c.query('alter table public.report_sections enable trigger report_sections_frozen');
    await c.query(`delete from public.syntheses where title like 'P4 %'`);
    await c.query(`delete from public.insights where title like 'P4 %'`);
    await c.query(`delete from public.recommendations where title like 'P4 %'`);
    await c.query(`update public.workshops set status='active' where id=$1`, [WS]);
    r.note('reports and seeded analysis rows removed; workshop back to active');
    await c.end();
  }
});
