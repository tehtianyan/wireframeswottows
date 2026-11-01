// White-label branding — the HTTP surface, against a real database.
//
// The pure parts are already covered by Go tests that need no server:
// branding_validate_test.go exercises the SVG refusal and the decode, and
// reports_brand_test.go pins the html/template #ZgotmplZ trap. What can only
// be checked here is everything involving identity and rows: that a
// facilitator cannot restyle a client's report, that the logo actually
// reaches the exported HTML, and that clearing a field restores the default
// rather than storing an empty string.
//
// The suite restores what it FOUND, not what it assumes — the same rule that
// iam.js and knowledge.js had to learn after resetting a real admin's role.
import { runSuite, clients, db } from "../lib/harness.js";

// A 1x1 PNG, and a deliberately tiny one: every assertion here is about
// authorization and plumbing, not image handling.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

runSuite("branding", async ({ baseUrl, results: r, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P, analyst: A } = await clients(baseUrl, [
    "facilitator",
    "participant",
    "analyst",
  ]);

  const pg = await db();
  let orgID = null;
  let before = null; // the organization's branding as we FOUND it
  let madeReport = null;

  try {
    // ---- who may write it ----

    // The facilitator demo account also holds platform admin on dev, so the
    // refusal has to be proven with an account that does NOT — otherwise a
    // 403 here would prove nothing about role and this check would pass for
    // the wrong reason, which this project has been bitten by three times.
    const orgs = await F("GET", "/admin/organizations");
    r.ok(
      orgs.status === 200 && Array.isArray(orgs.data),
      "a platform admin can list organizations for the branding picker",
      `status=${orgs.status}`,
    );
    if (orgs.status !== 200 || !orgs.data?.length) {
      r.ok(false, "at least one organization exists to brand", "none returned");
      return;
    }
    orgID = orgs.data[0].organization_id;
    before = {
      display_name: orgs.data[0].display_name || null,
      logo_data_uri: orgs.data[0].logo_data_uri || null,
      logo_filename: orgs.data[0].logo_filename || null,
    };

    for (const [name, call] of [
      ["participant", P],
      ["analyst", A],
    ]) {
      const refused = await call("PUT", `/admin/organizations/${orgID}/branding`, {
        display_name: "Hostile Rebrand",
      });
      r.ok(
        refused.status === 403,
        `a ${name} cannot change branding — the client's report cover is not theirs to restyle`,
        `status=${refused.status} ${refused.error?.message ?? ""}`,
      );
      const listRefused = await call("GET", "/admin/organizations");
      r.ok(
        listRefused.status === 403,
        `a ${name} cannot list organizations`,
        `status=${listRefused.status}`,
      );
    }

    // ---- the validator, over HTTP ----
    // Covered in Go too, but asserted here as well because the Go test
    // proves the FUNCTION refuses an SVG and this proves the ENDPOINT calls
    // it. Those are different claims, and the second is the one that was
    // ever actually at risk.
    const svg = await F("PUT", `/admin/organizations/${orgID}/branding`, {
      logo_data_uri:
        "data:image/svg+xml;base64," +
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"),
    });
    r.ok(
      svg.status === 400 && /script/i.test(svg.error?.message ?? ""),
      "the endpoint refuses an SVG logo and says why",
      `status=${svg.status} ${svg.error?.message ?? ""}`,
    );

    const lying = await F("PUT", `/admin/organizations/${orgID}/branding`, {
      logo_data_uri: "data:image/png;base64," + Buffer.from("#!/bin/sh\nrm -rf /").toString("base64"),
    });
    r.ok(
      lying.status === 400,
      "a shell script labelled image/png is refused — the declared type is not trusted",
      `status=${lying.status}`,
    );

    // Nothing above should have been stored.
    const afterRefusals = await pg.query(
      `select logo_data_uri from public.organizations where id = $1`,
      [orgID],
    );
    r.ok(
      (afterRefusals.rows[0]?.logo_data_uri ?? null) === before.logo_data_uri,
      "a refused logo leaves the stored value untouched",
      `stored=${String(afterRefusals.rows[0]?.logo_data_uri).slice(0, 24)}`,
    );

    // ---- the happy path ----

    const saved = await F("PUT", `/admin/organizations/${orgID}/branding`, {
      display_name: "Branding Probe Co",
      logo_data_uri: PNG_1PX,
      logo_filename: "probe-mark.png",
    });
    r.ok(
      saved.status === 200 && saved.data?.display_name === "Branding Probe Co",
      "a platform admin can set a display name and logo",
      `status=${saved.status} ${saved.error?.message ?? ""}`,
    );
    r.ok(
      saved.data?.logo_data_uri === PNG_1PX,
      "the response echoes the STORED state, so the admin page renders the server's answer",
      `len=${saved.data?.logo_data_uri?.length}`,
    );

    // ---- what every authenticated caller reads ----

    const mine = await P("GET", `/branding?workshop_id=${WS}`);
    r.ok(
      mine.status === 200 && mine.data?.display_name === "Branding Probe Co",
      "a participant READS the brand for a workshop they belong to",
      `status=${mine.status} name=${mine.data?.display_name}`,
    );

    // A workshop id that is not theirs must not become a way to enumerate
    // other clients' branding. Scoped in the query, like every other
    // cross-workshop read in this codebase.
    const foreign = await P(
      "GET",
      "/branding?workshop_id=00000000-0000-0000-0000-000000000000",
    );
    r.ok(
      foreign.status === 200 && !foreign.data?.organization_id,
      "an unknown or unauthorised workshop yields no branding, not somebody else's",
      `org=${foreign.data?.organization_id}`,
    );

    // ---- the report cover: the surface that reaches the client ----

    // The report is CREATED here rather than found. The first version read
    // the demo workshop's existing reports, which made the most important
    // check in this suite — does the client's logo actually reach the
    // exported file — depend on seed shape, and it reported "none found"
    // instead of an answer. A check that can vanish is not a check.
    const created = await F("POST", `/workshops/${WS}/reports`, { report_type: "executive" });
    const reportID = created.data?.id ?? null;
    r.ok(reportID !== null, "a report can be created to export", `status=${created.status} ${created.error?.message ?? ""}`);
    if (reportID) {
      madeReport = reportID;
      const exported = await F(
        "GET",
        `/workshops/${WS}/reports/${reportID}/export.html`,
        undefined,
        { raw: true },
      );
      r.ok(
        exported.status === 200 && exported.text.includes(PNG_1PX),
        "the exported report embeds the logo, so an archived file keeps its branding",
        `status=${exported.status} found=${exported.text?.includes(PNG_1PX)}`,
      );
      // The bug that is invisible without this: html/template rewrites a
      // data: URI in src= to "#ZgotmplZ" and reports no error at all.
      r.ok(
        exported.status === 200 && !exported.text.includes("ZgotmplZ"),
        "the export does not contain #ZgotmplZ — the logo survived html/template",
        exported.text?.includes("ZgotmplZ") ? "NEUTERED" : "intact",
      );
      r.ok(
        exported.status === 200 && !/src="http/.test(exported.text),
        "the export is still self-contained: no external image requests",
      );
    }

    // ---- clearing restores the default, rather than storing "" ----

    const cleared = await F("PUT", `/admin/organizations/${orgID}/branding`, {
      display_name: "",
      logo_data_uri: "",
    });
    r.ok(
      cleared.status === 200 && cleared.data?.display_name === "",
      "clearing the display name succeeds",
      `status=${cleared.status}`,
    );
    const nulls = await pg.query(
      `select display_name, logo_data_uri, logo_filename
         from public.organizations where id = $1`,
      [orgID],
    );
    r.ok(
      nulls.rows[0].display_name === null && nulls.rows[0].logo_data_uri === null,
      "cleared fields are NULL, not empty strings — only NULL means 'use the default'",
      JSON.stringify(nulls.rows[0]),
    );
    r.ok(
      nulls.rows[0].logo_filename === null,
      "clearing the logo clears its filename too, so the panel cannot show a file that is gone",
    );

    // ---- a partial update must not erase the other field ----

    await F("PUT", `/admin/organizations/${orgID}/branding`, {
      display_name: "Partial Probe",
      logo_data_uri: PNG_1PX,
      logo_filename: "probe-mark.png",
    });
    const renamed = await F("PUT", `/admin/organizations/${orgID}/branding`, {
      display_name: "Partial Probe Renamed",
    });
    r.ok(
      renamed.status === 200 && renamed.data?.logo_data_uri === PNG_1PX,
      "renaming without sending a logo LEAVES THE LOGO ALONE — an absent field is not a cleared one",
      `logo_len=${renamed.data?.logo_data_uri?.length ?? 0}`,
    );

    const nothing = await F("PUT", `/admin/organizations/${orgID}/branding`, {});
    r.ok(
      nothing.status === 400,
      "an empty request is refused rather than silently doing nothing",
      `status=${nothing.status}`,
    );

    // ---- the audit trail, without the credential-sized payload ----

    const audit = await pg.query(
      `select action, metadata::text as meta from public.audit_events
        where object_type = 'organization' and object_id = $1
        order by created_at desc limit 1`,
      [orgID],
    );
    r.ok(
      audit.rows[0]?.action === "organization.branding_changed",
      "a branding change writes an audit row",
      `action=${audit.rows[0]?.action}`,
    );
    r.ok(
      audit.rows.length > 0 && !String(audit.rows[0].meta ?? "").includes("base64"),
      "the audit row does NOT carry the logo itself — the fact it changed is the useful part",
      String(audit.rows[0]?.meta ?? "").slice(0, 60),
    );

    // ---- the DB constraint holds even against direct SQL ----

    let refusedBySQL = false;
    try {
      await pg.query(
        `update public.organizations set logo_data_uri = 'data:image/svg+xml;base64,PHN2Zy8+' where id = $1`,
        [orgID],
      );
    } catch {
      refusedBySQL = true;
    }
    r.ok(
      refusedBySQL,
      "the column's CHECK refuses an SVG even from direct SQL, so a future handler cannot forget",
    );
  } finally {
    // The report this suite created. Drafts delete cleanly — it is never
    // published here, so the immutability trigger is not in the way.
    if (madeReport) {
      await pg.query(`delete from public.reports where id = $1`, [madeReport]);
    }
    // Restore exactly what was found, including nulls.
    if (orgID && before) {
      await pg.query(
        `update public.organizations
            set display_name = $2, logo_data_uri = $3, logo_filename = $4
          where id = $1`,
        [orgID, before.display_name, before.logo_data_uri, before.logo_filename],
      );
      await pg.query(
        `delete from public.audit_events
          where object_type = 'organization' and object_id = $1
            and action = 'organization.branding_changed'`,
        [orgID],
      );
    }
    await pg.end();
  }
});
