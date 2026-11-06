// Invitation email: the copy, the delivery record, and the way back in.
//
// WHAT WAS REPORTED, and what each section here holds to:
//
//   1. Invited users received a message titled "Reset Your Password" that read
//      as phishing. It was GoTrue's own template, which cannot name who did
//      the inviting or what they were invited to — so the product now writes
//      the message, and the copy lives where an administrator can edit it.
//   2. The link dropped them on the sign-in page with no password set and no
//      explanation. Covered by tests/suites/invite-landing.js, which reads the
//      client source, because that half of the defect happens in the browser
//      after a perfectly correct HTTP response.
//   3. A yahoo.com address never received anything at all. Nothing recorded
//      whether a send had even been attempted, so the question was
//      unanswerable. Every attempt is now a row with the mail server's own
//      words in it.
//   4. There was no way to reset a forgotten password. There is now, and it is
//      the only public mutating endpoint in the API — so its three safeguards
//      are asserted here rather than assumed.
//   5. Nothing confirmed to somebody that their password was set.
//
// It restores every template it edits, because the copy is CONTENT an
// administrator is expected to have customised and a test must put back what
// it found — the lesson from iam.js and knowledge.js both resetting a
// global_role they never set.
import { readFileSync } from "node:fs";
import { runSuite, clients, env, ACCOUNTS } from "../lib/harness.js";

// An address with an account (the demo analyst) and one without. Both get the
// same answer from the public endpoint, which is the property being tested.
const UNKNOWN_EMAIL = `invite-probe-${Date.now()}@example.invalid`;

runSuite("invites", async ({ baseUrl, results: r, c }) => {
  // jane.smith is BOTH the demo facilitator and the platform admin on dev, so
  // one account exercises the admin surface and the other the refusal.
  const { facilitator: ADMIN, participant: P } = await clients(baseUrl, [
    "facilitator",
    "participant",
  ]);
  const e = env();

  /** Unauthenticated caller — the forgot-password endpoint takes no token. */
  const open = async (method, path, body) => {
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}/api/v1${path}`, init);
    const text = await res.text();
    try {
      return Object.assign({ status: res.status }, JSON.parse(text));
    } catch {
      return { status: res.status, success: false, error: { message: text.slice(0, 160) } };
    }
  };

  // Snapshotted so the body can edit freely and still put back what it found.
  const original = new Map();

  try {
    r.section("the invitation names the inviter and the workshop, which is why it is ours");

    const list = await ADMIN("GET", "/admin/email-templates");
    r.ok(list.success, "an administrator can read the email copy", list.error?.message);

    const templates = list.data?.templates ?? [];
    for (const t of templates) original.set(t.key, { subject: t.subject, body: t.body });

    // Asserted as a RELATIONSHIP, not as a count: every template Go knows how
    // to send must be editable, which is the property. A literal 3 here would
    // be the magic number the reporting suite had to have taken out of it.
    const keys = new Set(templates.map((t) => t.key));
    const needed = ["participant_invite", "password_reset", "password_set_confirmation"];
    const missing = needed.filter((k) => !keys.has(k));
    r.ok(missing.length === 0,
      "every message the product sends has editable copy",
      missing.length ? `missing: ${missing.join(", ")}` : [...keys].join(", "));

    const invite = templates.find((t) => t.key === "participant_invite");

    // THE REPORTED DEFECT, DIRECTLY. The old subject was "Reset Your
    // Password", which is the commonest phishing pattern there is, and no
    // amount of template editing in the Supabase dashboard could have fixed
    // it — GoTrue does not know the two facts that make an invitation read as
    // an invitation.
    //
    // THE SUBJECT MUST EXIST FOR THIS TO MEAN ANYTHING. The first version of
    // this check was `!/reset your password/i.test(invite?.subject ?? "")`,
    // and it PASSED while the endpoint was returning 404 and `invite` was
    // undefined — an empty string does not match, so the assertion reported
    // success about a template it had never seen. Exactly the failure this
    // project keeps a note about: read the reason, not the PASS. Phrased now
    // so an absent template fails.
    const subject = invite?.subject;
    const subjectIsReset = /reset\s+your\s+password/i.test(subject ?? "Reset your password");
    r.ok(typeof subject === "string" && subject.length > 0 && !subjectIsReset,
      "the invitation has a subject, and it is not 'Reset Your Password' — the phishing-shaped title that was reported",
      subject ?? "(no template returned)");

    for (const p of ["inviter_name", "workshop_name"]) {
      r.ok((invite?.uses ?? []).includes(p),
        `and the default copy actually uses {{${p}}} — the fact GoTrue could never supply`,
        (invite?.uses ?? []).join(", "));
    }

    r.ok((invite?.allowed ?? []).includes("inviter_email"),
      "the inviter's address is available too, so a recipient can reply to a human");

    r.ok(list.data?.mail !== undefined && typeof list.data.mail.configured === "boolean",
      "and the response says whether mail is switched on at all — the first question in every 'they never got it'",
      JSON.stringify(list.data?.mail ?? null));

    // The password cannot be anywhere in this response. It is the one secret
    // the panel handles and the status object is the only thing that touches
    // it.
    const statusText = JSON.stringify(list.data?.mail ?? {});
    const leaks = e.SMTP_PASSWORD && statusText.includes(e.SMTP_PASSWORD);
    r.ok(!leaks, "the SMTP password is not in the status the admin page reads", !leaks);

    r.section("the copy is administration, not something a facilitator rewrites");

    const deniedRead = await P("GET", "/admin/email-templates");
    r.ok(deniedRead.status === 403,
      "a participant cannot read the copy that goes out over the product's name",
      deniedRead.status);

    const deniedWrite = await P("PUT", "/admin/email-templates/participant_invite", {
      subject: "Nope",
    });
    r.ok(deniedWrite.status === 403, "nor rewrite it", deniedWrite.status);

    const deniedLog = await P("GET", "/admin/email-deliveries");
    r.ok(deniedLog.status === 403,
      "and cannot read the delivery log, which lists every address ever invited",
      deniedLog.status);

    r.section("a save that would produce a broken message is refused at save time");

    // A typo renders as NOTHING, so without this the first person to notice
    // is the invitee reading a sentence with a hole in it. The refusal belongs
    // in front of the one person who can fix it.
    const typo = await ADMIN("PUT", "/admin/email-templates/participant_invite", {
      subject: "{{inviter}} invited you",
      body: "Hello. {{action_url}}",
    });
    r.ok(typo.status === 400 && /inviter/.test(typo.error?.message ?? ""),
      "an unknown placeholder is refused, and the message names it",
      typo.error?.message);

    r.ok(/\{\{inviter_name\}\}/.test(typo.error?.message ?? ""),
      "and lists the ones that would have worked, so the fix does not need documentation");

    // A perfectly well-formed invitation that nobody can accept is the same
    // shape as every other "looked like it worked" defect in this codebase.
    const noLink = await ADMIN("PUT", "/admin/email-templates/participant_invite", {
      subject: "{{inviter_name}} invited you",
      body: "Hello {{recipient_name}}, see you there.",
    });
    r.ok(noLink.status === 400 && /action_url/.test(noLink.error?.message ?? ""),
      "dropping {{action_url}} is refused — without it the recipient has no way in",
      noLink.error?.message);

    const blank = await ADMIN("PUT", "/admin/email-templates/participant_invite", {
      subject: "   ",
    });
    r.ok(blank.status === 400, "and an empty subject is refused", blank.status);

    // The confirmation carries no link by design — it is a reassurance after
    // the fact — so the rule must be per-template rather than global.
    const confirmNoLink = await ADMIN("PUT", "/admin/email-templates/password_set_confirmation", {
      subject: original.get("password_set_confirmation").subject,
      body: "You are all set. Sign in at {{site_url}}.\n",
    });
    r.ok(confirmNoLink.success,
      "the confirmation may omit {{action_url}}, because a credential nobody needs is one more thing to leak",
      confirmNoLink.error?.message);

    const unknownTemplate = await ADMIN("PUT", "/admin/email-templates/not_a_template", {
      subject: "x", body: "y {{action_url}}",
    });
    r.ok(unknownTemplate.status === 404,
      "a template Go cannot send cannot be created by naming it in a URL",
      unknownTemplate.status);

    r.section("the preview is produced by the code that sends it");

    const preview = await ADMIN("POST", "/admin/email-templates/participant_invite/preview", {});
    r.ok(preview.success, "an administrator can preview the invitation", preview.error?.message);

    // The one thing a preview must never do is disagree with what goes out —
    // the branding panel's lesson, where a preview computing its own answer
    // was confidently wrong.
    const hasHoles = /\{\{|\}\}/.test(preview.data?.text ?? "x{{");
    r.ok(!hasHoles,
      "every placeholder is filled, so what is previewed is the shape that is sent",
      hasHoles ? preview.data.text.slice(0, 120) : "no placeholder syntax left");

    r.ok(/Dana Okonjo/.test(preview.data?.text ?? ""),
      "with an obviously-an-example inviter, so a preview is never mistaken for a sent message");

    // Unsaved edits must be visible BEFORE committing them, or the preview
    // can only ever confirm what is already live.
    const draft = await ADMIN("POST", "/admin/email-templates/participant_invite/preview", {
      subject: "Draft: {{workshop_name}}",
      body: "Marker line. {{action_url}}\n",
    });
    r.ok(/Marker line/.test(draft.data?.text ?? "") &&
      /Draft: Example Growth Strategy Review/.test(draft.data?.subject ?? ""),
      "and an unsaved edit can be previewed before it is committed",
      draft.data?.subject);

    r.section("an edit sticks, and the stored copy is what a send would use");

    const marker = `Probe ${Date.now()} — {{inviter_name}} invited you to {{workshop_name}}`;
    const saved = await ADMIN("PUT", "/admin/email-templates/participant_invite", {
      subject: marker,
      body: original.get("participant_invite").body,
    });
    r.ok(saved.success, "the copy saves", saved.error?.message);

    const row = (
      await c.query("select subject, updated_by from public.email_templates where key=$1", [
        "participant_invite",
      ])
    ).rows[0];
    r.ok(row.subject === marker, "and is what is actually in the database", row.subject);

    // Attribution, because the words that go to a client's staff over the
    // product's name are somebody's decision.
    r.ok(row.updated_by !== null,
      "and the edit is attributed to whoever made it",
      row.updated_by);

    r.section("every attempt is recorded, with the mail server's own words");

    const log = await ADMIN("GET", "/admin/email-deliveries");
    r.ok(log.success && Array.isArray(log.data),
      "an administrator can read what was actually attempted",
      log.error?.message);

    // The structural claim: a failure can never be recorded without a reason.
    // "It failed" and nothing else is where the yahoo.com question started,
    // and this is enforced by a CHECK rather than by the handler remembering.
    const reasonless = await c
      .query(
        `insert into public.email_deliveries (to_email, template_key, subject, status, route)
         values ('x@example.invalid', 'password_reset', 's', 'failed', 'smtp')`,
      )
      .then(() => "accepted")
      .catch((err) => err.message);
    r.ok(reasonless !== "accepted",
      "a failed delivery cannot be stored without a reason — enforced in the database, not by the handler",
      typeof reasonless === "string" ? reasonless.split("\n")[0].slice(0, 90) : reasonless);

    r.section("the invite form promises what the result panel then reports");

    // SOURCE, not the API. Every endpoint was correct throughout this defect:
    // the invite was sent, the panel said so, and the help text six lines above
    // it said "No email is sent — you get a one-time link to pass on". That
    // sentence was true when inviting only ever minted a link and was not
    // updated when mail became the default, so a facilitator was told both
    // things at once and could not tell which had happened. Reported from
    // production 2026-11-06 after an invite to a corporate address went
    // missing — the copy is what made an ordinary delivery failure unreadable.
    //
    // Phrased against the CONTRADICTION rather than against today's wording, so
    // it survives a rewrite of the sentence and still fails if the claim comes
    // back.
    const panel = readFileSync(
      new URL("../../src/components/ParticipantsPanel.tsx", import.meta.url),
      "utf8",
    );
    // Strip comments first: the one explaining this fix quotes the old claim,
    // and matching the argument FOR a property instead of the property is how
    // two checks in participant-flow.js failed when they were first written.
    const panelCode = panel
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const claimsNoEmail = /no\s+email\s+is\s+sent/i.test(panelCode);
    r.ok(
      !claimsNoEmail,
      "the invite form does not tell the facilitator that no email is sent",
      // Printed on pass as well as fail, so it states the FINDING rather than
      // the fault — a detail line reading "still claims mail is never sent"
      // beside the word PASS is the log misreading this suite exists to stop.
      claimsNoEmail ? "ParticipantsPanel still carries the pre-2026-11-06 claim" : "claim absent",
    );
    r.ok(
      /email the invitation/i.test(panelCode),
      "it says mail is attempted, with the link as the stated fallback",
    );
    // The result panel is the other half of the pair. If this ever stops
    // reporting which rung ran, the form's promise becomes unverifiable again.
    const result = readFileSync(
      new URL("../../src/components/OneTimeLink.tsx", import.meta.url),
      "utf8",
    );
    r.ok(
      /This was NOT emailed/.test(result) && /emailed to/.test(result),
      "and the result panel still distinguishes 'emailed' from 'here is a link instead'",
    );

    r.section("a forgotten password has a way back, and it cannot say who has an account");

    const known = await open("POST", "/auth/forgot-password", { email: ACCOUNTS.analyst });
    r.ok(known.success && typeof known.data?.message === "string",
      "an unauthenticated caller can ask for a reset — the one public mutating endpoint, and it has to be",
      known.error?.message ?? known.data?.message?.slice(0, 60));

    const unknown = await open("POST", "/auth/forgot-password", { email: UNKNOWN_EMAIL });

    // THE SECURITY PROPERTY. A public endpoint that answers differently for an
    // address with an account is an enumeration oracle: feed it a list and it
    // tells you who a client's staff are. Compared byte for byte, because
    // "roughly the same" is not a property.
    r.ok(unknown.success && unknown.data?.message === known.data?.message,
      "and answers IDENTICALLY for an address with no account, so it cannot be used to find out who has one",
      unknown.data?.message === known.data?.message
        ? "identical"
        : `"${known.data?.message}" vs "${unknown.data?.message}"`);

    r.ok(unknown.status === known.status,
      "including the status code, which is the other half of the same leak",
      `${known.status} / ${unknown.status}`);

    const malformed = await open("POST", "/auth/forgot-password", { email: "not-an-address" });
    r.ok(malformed.status === 400,
      "a malformed address is refused plainly — that tells an attacker nothing and the person something",
      malformed.status);

    // Rate limited BEFORE any send, the way the AI limits are checked before
    // any provider call. Unlimited, this mails somebody a reset link every
    // second and poisons the sending domain every real invitation depends on.
    const burst = [];
    for (let i = 0; i < 4; i++) {
      burst.push(await open("POST", "/auth/forgot-password", { email: ACCOUNTS.analyst }));
    }
    const sameAnswer = burst.every((b) => b.data?.message === known.data?.message);
    r.ok(sameAnswer,
      "repeating the request keeps the same answer, so the rate limit does not leak either",
      sameAnswer);

    const attempts = (
      await c.query(
        `select count(*)::int n from public.email_deliveries
          where template_key = 'password_reset'
            and created_at > now() - interval '2 minutes'
            and lower(to_email) = lower($1)`,
        [ACCOUNTS.analyst],
      )
    ).rows[0].n;
    r.ok(attempts > 0 && attempts <= 3,
      "and at most three sends are attempted per address in fifteen minutes, however many times it is asked",
      `${attempts} attempt(s) recorded for 5 requests`);

    // The unknown address is recorded too, as skipped — so the silence is
    // explained to the administrator without being explained to the caller.
    const skipped = (
      await c.query(
        `select status from public.email_deliveries where lower(to_email) = lower($1)`,
        [UNKNOWN_EMAIL],
      )
    ).rows;
    r.ok(skipped.length > 0 && skipped.every((x) => x.status !== "sent"),
      "an address with no account is logged as not sent, so a silent non-delivery is still visible to an admin",
      skipped.map((x) => x.status).join(",") || "nothing logged");

    r.section("the confirmation can only reach the caller's own address");

    const anon = await open("POST", "/me/password-set", {});
    r.ok(anon.status === 401,
      "the confirmation endpoint refuses an unauthenticated caller, so it is not a way to mail strangers",
      anon.status);

    const mine = await P("POST", "/me/password-set", {});
    r.ok(mine.success && typeof mine.data?.sent === "boolean",
      "and for a signed-in caller reports whether it went, rather than failing when mail is off",
      JSON.stringify(mine.data ?? mine.error));

    // `sent: false` is a NORMAL answer — no SMTP, or one already went today.
    // The onboarding succeeded either way, so this must never be an error.
    r.ok(mine.status === 200,
      "a confirmation that could not be sent is still a 200 — the password was set and the person is in",
      mine.status);
  } finally {
    // Put back exactly what was found. This copy is content an administrator
    // is expected to have customised, so a suite that left its own marker
    // subject behind would silently become the product's invitation wording.
    for (const [key, v] of original) {
      await c
        .query(
          `update public.email_templates set subject=$2, body=$3, updated_at=now() where key=$1`,
          [key, v.subject, v.body],
        )
        .catch(() => {});
    }
    // The probe rows, so the log does not accumulate one set per run.
    await c
      .query("delete from public.email_deliveries where to_email like '%@example.invalid'")
      .catch(() => {});
    await c
      .query(
        `delete from public.email_deliveries
          where template_key = 'password_reset'
            and lower(to_email) = lower($1)
            and created_at > now() - interval '10 minutes'`,
        [ACCOUNTS.analyst],
      )
      .catch(() => {});
  }
});
