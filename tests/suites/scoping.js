// The security property that matters most: a caller must never see data from
// a workspace they do not belong to.
//
// Knowledge search joins workspace_members in its FROM clause, so an
// unauthorized object never enters the result set rather than being filtered
// out afterwards. That distinction is easy to regress during a refactor and
// impossible to see by reading a passing test that only checks happy paths —
// so this test proves it empirically, by removing a real user's membership
// and confirming results drop to zero.
import { runSuite, client, token, ACCOUNTS } from "../lib/harness.js";

runSuite("scoping", async ({ baseUrl, results: r, c }) => {
  // Deliberately an executive viewer: the least-privileged real account, so a
  // leak here would be the worst kind.
  const EMAIL = ACCOUNTS.executive;
  const api = client(baseUrl, await token(EMAIL));

  const uid = (await c.query("select id from public.profiles where email = $1", [EMAIL])).rows[0].id;
  let savedMemberships = null;

  try {
    r.section("as a workspace member");
    const before = await api("GET", "/knowledge/search");
    r.ok(before.success && before.data.length > 0,
      "search returns results", before.data?.length);

    const assetsBefore = await api("GET", "/knowledge/assets");
    r.ok(assetsBefore.success, "knowledge assets are readable");

    r.section("after removing workspace membership");
    savedMemberships = (await c.query(
      "select * from public.workspace_members where user_id = $1", [uid])).rows;
    await c.query("delete from public.workspace_members where user_id = $1", [uid]);

    const after = await api("GET", "/knowledge/search");
    r.ok(after.success && after.data.length === 0,
      "search returns NOTHING — scoping is in the query, not a filter", after.data?.length);

    const assetsAfter = await api("GET", "/knowledge/assets");
    r.ok(assetsAfter.success && assetsAfter.data.length === 0,
      "knowledge assets are scoped the same way", assetsAfter.data?.length);

    // Every surface that lists cross-workshop data, not just search. Each of
    // these was a separate leak: they filtered by workshop_members alone, so a
    // stale membership row kept working after workspace access was revoked.
    const dash = await api("GET", "/dashboard");
    r.ok(dash.success && dash.data.workshops.length === 0,
      "the dashboard is scoped too", dash.data?.workshops?.length);
    r.ok(dash.success && dash.data.recent_activity.length === 0,
      "and so is its activity feed", dash.data?.recent_activity?.length);

    const list = await api("GET", "/workshops");
    r.ok(list.success && list.data.length === 0,
      "the workshops list is scoped", list.data?.length);

    const exec = await api("GET", "/executive");
    r.ok(exec.success && exec.data.workshops === 0 && exec.data.themes.length === 0,
      "the executive brief is scoped", `${exec.data?.workshops} workshops`);
    r.ok(exec.success && exec.data.published_reports === 0 && exec.data.alerts.length === 0,
      "including its counts and alerts — a count leaks less than content, but still leaks",
      `${exec.data?.published_reports} reports, ${exec.data?.alerts?.length} alerts`);
  } finally {
    if (savedMemberships) {
      for (const m of savedMemberships) {
        await c.query(
          `insert into public.workspace_members (id, workspace_id, user_id, role, created_at)
           values ($1, $2, $3, $4, $5) on conflict do nothing`,
          [m.id, m.workspace_id, m.user_id, m.role, m.created_at]);
      }
      const n = (await c.query(
        "select count(*)::int n from public.workspace_members where user_id = $1", [uid])).rows[0].n;
      r.note(`membership restored: ${n} row(s)`);
      if (n === 0) r.ok(false, "CRITICAL: membership was NOT restored — fix by hand");
    }
  }
});
