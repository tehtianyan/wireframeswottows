// Participants, identity management, and archiving.
//
// THE REGRESSION THIS EXISTS FOR. The RLS policies on workshop_members
// authorised writes on MEMBERSHIP rather than on role:
//
//   UPDATE ... USING is_workshop_member(workshop_id)
//
// so any participant could `update workshop_members set role='facilitator'`
// against their own row, and delete the facilitator. Both were confirmed
// exploitable through PostgREST with the publishable key before
// 20261003110000 removed the write policies and moved membership behind Go.
// The first two checks below are that exploit, run as a real participant.
//
// Everything else covers what the Go path now has to get right and a policy
// never could: an invite must grant BOTH memberships or the invited person is
// refused everywhere, the last facilitator cannot be removed, revoking access
// must not delete what somebody contributed, and an archived workshop must
// actually refuse writes.
import { createClient } from "@supabase/supabase-js";
import { runSuite, clients, client, token, env, ACCOUNTS, cleanup } from "../lib/harness.js";

// A domain that cannot receive mail, so a stray fixture cannot reach anyone.
const PROBE_EMAIL = `iam-probe-${Date.now()}@example.invalid`;
const PREFIX = "IAM probe";

runSuite("iam", async ({ baseUrl, results: r, c, DEMO_WORKSHOP: WS }) => {
  const { facilitator: F, participant: P } = await clients(baseUrl, ["facilitator", "participant"]);
  const e = env();
  const made = { factors: [] };
  let invitedUserID = null;
  let probeWorkshop = null;
  let demotedFacilitator = null;
  // Snapshotted, not assumed. This used to reset global_role to 'user' on the
  // way out, which CLOBBERED a real platform admin the dev database needs for
  // UAT — the suite undoing a setting it never made.
  let priorGlobalRole = null;

  const asUser = async (email) =>
    createClient(e.SUPABASE_URL, e.SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${await token(email)}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

  try {
    // ---- the exploit, as a real participant ----
    r.section("a participant cannot grant themselves authority");

    const pUid = (await c.query("select id from public.profiles where email=$1", [ACCOUNTS.participant]))
      .rows[0].id;
    const fUid = (await c.query("select id from public.profiles where email=$1", [ACCOUNTS.facilitator]))
      .rows[0].id;
    const sb = await asUser(ACCOUNTS.participant);

    await sb.from("workshop_members").update({ role: "facilitator" }).eq("workshop_id", WS).eq("user_id", pUid);
    const roleNow = (
      await c.query("select role from public.workshop_members where workshop_id=$1 and user_id=$2", [WS, pUid])
    ).rows[0].role;
    r.ok(roleNow === "participant",
      "self-promotion to facilitator through PostgREST is refused — this SUCCEEDED before the write policies were removed",
      roleNow);

    await sb.from("workshop_members").delete().eq("workshop_id", WS).eq("user_id", fUid);
    const facStill = (
      await c.query("select count(*)::int n from public.workshop_members where workshop_id=$1 and user_id=$2", [WS, fUid])
    ).rows[0].n;
    r.ok(facStill === 1,
      "and deleting the facilitator is refused — this SUCCEEDED too",
      facStill);

    // Reading the roster is still allowed: a member seeing who else is in the
    // room is intended, and only the WRITE policies were removed.
    const { data: readable } = await sb.from("workshop_members").select("user_id").eq("workshop_id", WS);
    r.ok((readable ?? []).length > 0,
      "but a member can still READ the roster — only writes moved behind Go",
      (readable ?? []).length);

    // ---- who may manage ----
    r.section("managing participants is the facilitator's job");

    const pInvite = await P("POST", `/workshops/${WS}/participants`, {
      email: "nope@example.invalid", role: "participant",
    });
    r.ok(!pInvite.success && pInvite.status === 403, "a participant cannot invite", pInvite.status);

    const pRevoke = await P("DELETE", `/workshops/${WS}/participants/${fUid}`);
    r.ok(!pRevoke.success && pRevoke.status === 403, "a participant cannot revoke", pRevoke.status);

    const pArchive = await P("POST", `/workshops/${WS}/archive`, {});
    r.ok(!pArchive.success && pArchive.status === 403, "a participant cannot archive", pArchive.status);

    // ---- inviting a real address ----
    r.section("an invite actually grants access");

    // `deliver: "link"` explicitly. Invites are emailed by default now, and
    // PROBE_EMAIL is an @example.invalid address on purpose — asking the
    // project to mail it would depend on SMTP being configured and on how the
    // provider rejects an undeliverable domain. The link path is the one these
    // checks are about, so they ask for it rather than relying on mail failing.
    const invited = await F("POST", `/workshops/${WS}/participants`, {
      email: PROBE_EMAIL, name: "IAM Probe Person", role: "analyst", deliver: "link",
    });
    if (!r.ok(invited.success, "invite a new email address", invited.error?.message)) return;
    invitedUserID = invited.data.user_id;

    r.ok(invited.data.new_account === true, "it created an account");
    // A link must ALWAYS come back. Asking GoTrue for an `invite` link right
    // after creating the account fails with email_exists, which left the person
    // with access and no way to sign in — the single most useless outcome an
    // invite can have.
    r.ok(typeof invited.data.invite_link === "string" && invited.data.invite_link.includes("token"),
      "and returned a one-time link to pass on, rather than relying on email delivery",
      invited.data.invite_link ? "link present" : invited.data.link_error);
    r.ok(invited.data.link_type === "invite",
      "reported as a first-time invite, which is what the person experiences",
      invited.data.link_type);

    // The destination has to be the one the server asked for. Supabase
    // SILENTLY replaces a redirect_to that is not in the project's Redirect
    // URLs with the project's Site URL — production's was still
    // http://localhost:3000, so every invite pointed at the invitee's own
    // machine while the API returned a perfectly well-formed link.
    const dest = new URL(invited.data.invite_link).searchParams.get("redirect_to");
    r.ok(Boolean(dest) && !/\/auth\/callback/.test(dest),
      "the link targets the app root, not the /auth/callback route that never existed",
      dest);
    r.ok(!invited.data.link_warning,
      "and no destination warning on a correctly configured project — a warning that cries wolf is worse than none",
      invited.data.link_warning ?? "(none)");

    // THE BUG THAT MADE EVERY PREVIOUS INVITE USELESS. The old invite inserted
    // workshop_members only, and authz joins workspace_members, so an invited
    // person was refused everywhere.
    const memberships = (
      await c.query(
        `select exists(select 1 from public.workshop_members where workshop_id=$1 and user_id=$2) wk,
                exists(select 1 from public.workspace_members wsm
                       join public.workshops w on w.id=$1
                       where wsm.workspace_id=w.workspace_id and wsm.user_id=$2) ws`,
        [WS, invitedUserID],
      )
    ).rows[0];
    r.ok(memberships.wk === true, "they are a member of the workshop", memberships.wk);
    r.ok(memberships.ws === true,
      "AND of its workspace — without this they would be refused everywhere despite being on the roster",
      memberships.ws);

    // joined_at must NOT be set by an invite: that is what made every person
    // read as "joined" and the green dot meaningless.
    const stamps = (
      await c.query(
        "select invited_at is not null inv, joined_at is not null joined from public.workshop_members where workshop_id=$1 and user_id=$2",
        [WS, invitedUserID],
      )
    ).rows[0];
    r.ok(stamps.inv === true, "invited_at is stamped", stamps.inv);
    r.ok(stamps.joined === false,
      "joined_at is NOT — an invitation is not an attendance, which is the bug behind the always-green dot",
      stamps.joined);

    const roster = (await F("GET", `/workshops/${WS}/participants`)).data;
    const them = roster.find((x) => x.user_id === invitedUserID);
    r.ok(them?.has_signed_in === false, "the roster reports them as never signed in", them?.has_signed_in);
    r.ok(them?.in_workspace === true, "and as having workspace access", them?.in_workspace);
    r.ok(roster.every((x) => typeof x.has_signed_in === "boolean"),
      "every row carries has_signed_in, so the panel never has to guess");

    // Inviting the same address again must reuse the account, not fail. The
    // old implementation called createUser unconditionally and errored with
    // "already registered", so a person could never join a second workshop.
    const again = await F("POST", `/workshops/${WS}/participants`, {
      email: PROBE_EMAIL, role: "participant", deliver: "link",
    });
    r.ok(again.success && again.data.new_account === false,
      "re-inviting an existing address reuses the account instead of failing",
      again.error?.message ?? `new_account=${again.data?.new_account}`);
    r.ok(again.data?.user_id === invitedUserID, "and it is the same person", again.data?.user_id === invitedUserID);

    // ---- how the credential is delivered ----
    //
    // Invites are emailed by default. The properties below must hold whether
    // or not this project has custom SMTP configured, because the suite runs
    // against projects in both states — so none of them asserts "an email was
    // sent", which would silently skip wherever mail is not set up.
    r.section("an invitation is delivered exactly one way, and says which");

    r.ok(invited.data.delivery === "link",
      "asking for a link gives a link, and the response names the delivery",
      invited.data.delivery);
    r.ok(!invited.data.emailed_to,
      "and claims no email was sent, because none was");

    const emailed = await F("POST", `/workshops/${WS}/participants`, {
      email: PROBE_EMAIL, role: "participant",
    });
    r.ok(emailed.success,
      "inviting with no explicit delivery succeeds — email is the default and must not be able to fail the invitation",
      emailed.error?.message);

    // THE INVARIANT. GoTrue keeps ONE token per user per type and clears the
    // previous one when it writes a new one, so a response that both mailed a
    // link and displayed one would be showing a link that had just killed the
    // mailed one. Exactly one, always — true in both SMTP states.
    const d = emailed.data ?? {};
    const hasLink = typeof d.invite_link === "string";
    const wasEmailed = d.delivery === "emailed";
    r.ok(hasLink !== wasEmailed,
      "exactly ONE of {emailed, link returned} — showing a second link would invalidate the mailed one",
      `delivery=${d.delivery} link=${hasLink}`);

    // And whichever happened, the invitation produced SOMETHING usable. The
    // failure this guards is an invite that reports success while leaving the
    // person no way in at all.
    r.ok(hasLink || wasEmailed,
      "and the invitation always yields a way in, never neither",
      `delivery=${d.delivery}`);

    // If it fell back to a link, the inviter must be TOLD the mail did not go.
    // An inviter who believes an email was sent tells the invitee nothing, and
    // that silence is how the invite flow stayed broken for weeks.
    if (!wasEmailed) {
      r.ok(typeof d.delivery_error === "string" && d.delivery_error.length > 0,
        "a fallback to a link explains why the email did not go, rather than looking like a plain link invite",
        d.delivery_error ?? "(nothing said)");
    } else {
      r.ok(!d.delivery_error,
        "a successful email reports no delivery error",
        d.delivery_error ?? "(none)");
    }

    const badEmail = await F("POST", `/workshops/${WS}/participants`, { email: "not-an-email", role: "participant" });
    r.ok(!badEmail.success, "a malformed address is refused", badEmail.error?.message);

    const badRole = await F("POST", `/workshops/${WS}/participants`, { email: PROBE_EMAIL, role: "root" });
    r.ok(!badRole.success, "an unknown role is refused", badRole.error?.message);

    // ---- the last facilitator ----
    r.section("a workshop cannot be left without a facilitator");

    const demote = await F("PATCH", `/workshops/${WS}/participants/${fUid}`, { role: "participant" });
    r.ok(!demote.success && demote.status === 409,
      "demoting the only facilitator is refused — nobody would be able to undo it",
      demote.error?.message);

    const selfRevoke = await F("DELETE", `/workshops/${WS}/participants/${fUid}`);
    r.ok(!selfRevoke.success && selfRevoke.status === 409,
      "and removing them is refused for the same reason",
      selfRevoke.error?.message);

    // With a second facilitator the guard must step out of the way.
    const promote = await F("PATCH", `/workshops/${WS}/participants/${invitedUserID}`, { role: "facilitator" });
    r.ok(promote.success, "promoting somebody else to facilitator works", promote.error?.message);
    // Demoting YOURSELF is refused even with another facilitator in place:
    // you would lose the ability to undo it. The suite found this by doing it
    // and then being unable to put itself back.
    const selfDemote = await F("PATCH", `/workshops/${WS}/participants/${fUid}`, { role: "analyst" });
    r.ok(!selfDemote.success && selfDemote.status === 409,
      "a facilitator cannot demote THEMSELVES, even once somebody else holds the role — they could not reverse it",
      selfDemote.error?.message);

    const selfOut = await F("DELETE", `/workshops/${WS}/participants/${fUid}`);
    r.ok(!selfOut.success && selfOut.status === 409,
      "nor revoke their own facilitator access", selfOut.error?.message);

    // Somebody ELSE may still change it, which is what keeps the guard from
    // being a trap rather than a protection. Applied directly, because the
    // suite has no second facilitator session to act from.
    const byOther = await c.query(
      "update public.workshop_members set role='analyst' where workshop_id=$1 and user_id=$2",
      [WS, fUid]);
    demotedFacilitator = true;
    r.ok(byOther.rowCount === 1,
      "but another facilitator or an admin can change it, so the role is never stuck");
    await c.query("update public.workshop_members set role='facilitator' where workshop_id=$1 and user_id=$2",
      [WS, fUid]);
    demotedFacilitator = false;

    // ---- revoking keeps the record ----
    r.section("revoking access does not rewrite what happened");

    const theirFactor = await F("POST", `/workshops/${WS}/factors`, {
      category_key: "strength", title: `${PREFIX} contributed by somebody who then left`,
    });
    made.factors.push(theirFactor.data.id);
    await c.query("update public.factors set created_by=$2 where id=$1", [theirFactor.data.id, invitedUserID]);

    const revoked = await F("DELETE", `/workshops/${WS}/participants/${invitedUserID}`);
    r.ok(revoked.success, "revoke their access", revoked.error?.message);
    const survives = (
      await c.query("select count(*)::int n from public.factors where id=$1", [theirFactor.data.id])
    ).rows[0].n;
    r.ok(survives === 1,
      "their contribution survives — deleting it would silently change every prioritization total built on it",
      survives);

    const gone = (await F("GET", `/workshops/${WS}/participants`)).data;
    r.ok(!gone.some((x) => x.user_id === invitedUserID), "and they are off the roster");

    // ---- archiving ----
    r.section("an archived workshop is read-only, enforced by the database");

    const spaces = (await F("GET", "/workspaces")).data;
    const created = await F("POST", "/workshops", {
      workspace_id: spaces[0].id, name: `${PREFIX} archive target`,
      methodology_key: "swot-tows", objective: "prove the freeze",
    });
    probeWorkshop = created.data.id;
    const seed = await F("POST", `/workshops/${probeWorkshop}/factors`, {
      category_key: "strength", title: `${PREFIX} before archiving`,
    });
    r.ok(seed.success, "a live workshop accepts factors", seed.error?.message);

    const arch = await F("POST", `/workshops/${probeWorkshop}/archive`, {});
    r.ok(arch.success && arch.data.status === "archived", "archive it", arch.error?.message);

    const stamp = (
      await c.query("select status, archived_at is not null a, archived_by is not null b from public.workshops where id=$1", [probeWorkshop])
    ).rows[0];
    r.ok(stamp.a && stamp.b,
      "archived_at and archived_by are both set — an archive names who did it, like every other decision",
      JSON.stringify(stamp));

    const blocked = await F("POST", `/workshops/${probeWorkshop}/factors`, {
      category_key: "strength", title: `${PREFIX} after archiving`,
    });
    r.ok(!blocked.success, "capturing a factor is refused", blocked.error?.message);
    r.ok(/archived/i.test(blocked.error?.message ?? ""),
      "with a message that says why rather than a bare 500",
      blocked.error?.message);

    const editBlocked = await F("PATCH", `/workshops/${probeWorkshop}/factors/${seed.data.id}`, {
      title: `${PREFIX} edited while archived`,
    });
    r.ok(!editBlocked.success, "and so is editing one that already existed", editBlocked.error?.message);

    // The trigger is the real guarantee: it must hold even for a writer that
    // does not go through the handler that checks.
    let triggerHeld = false;
    try {
      await c.query("update public.factors set title=title where workshop_id=$1", [probeWorkshop]);
    } catch {
      triggerHeld = true;
    }
    r.ok(triggerHeld,
      "a direct SQL write is refused too — the freeze is a database trigger, not a UI rule",
      triggerHeld);

    // Reading must still work: that is the whole point of keeping it listed.
    const stillReadable = await F("GET", `/workshops/${probeWorkshop}/factors`);
    r.ok(stillReadable.success && stillReadable.data.length >= 1,
      "but its content is still fully readable", stillReadable.data?.length);

    const un = await F("POST", `/workshops/${probeWorkshop}/unarchive`, {});
    r.ok(un.success, "un-archive it", un.error?.message);
    const afterUn = await F("POST", `/workshops/${probeWorkshop}/factors`, {
      category_key: "strength", title: `${PREFIX} after un-archiving`,
    });
    r.ok(afterUn.success, "and writes work again — archiving is reversible", afterUn.error?.message);
    const cleared = (
      await c.query("select archived_at is null a from public.workshops where id=$1", [probeWorkshop])
    ).rows[0];
    r.ok(cleared.a, "with the archive stamp cleared, so status and timestamps cannot drift", cleared.a);

    // ---- admin-only surfaces ----
    r.section("platform IAM is admin-only");

    for (const [label, call] of [
      ["the workshop list", () => P("GET", "/admin/workshops")],
      ["account creation", () => P("POST", "/admin/users", { email: "x@example.invalid" })],
      ["password resets", () => P("POST", `/admin/users/${fUid}/reset-password`, {})],
    ]) {
      const res = await call();
      r.ok(!res.success && (res.status === 403 || res.status === 401),
        `a participant is refused ${label}`, res.status);
    }

    // With the platform role, the same calls work — and a reset returns a link
    // rather than setting a password.
    priorGlobalRole = (
      await c.query("select coalesce(global_role,'user') r from public.profiles where id=$1", [fUid])
    ).rows[0].r;
    await c.query("update public.profiles set global_role='admin' where id=$1", [fUid]);
    const A = client(baseUrl, await token(ACCOUNTS.facilitator));
    const adminWs = await A("GET", "/admin/workshops");
    r.ok(adminWs.success && adminWs.data.length > 0,
      "an admin sees every workshop, including ones they are not a member of",
      adminWs.data?.length);
    r.ok(adminWs.data.every((x) => typeof x.facilitators === "number"),
      "with a facilitator count, so a workshop nobody can manage is visible");

    const reset = await A("POST", `/admin/users/${fUid}/reset-password`, {});
    r.ok(reset.success && typeof reset.data.reset_link === "string",
      "a password reset returns a one-time link", reset.error?.message);
    r.ok(!/password/i.test(JSON.stringify(reset.data).replace(/reset_link|password/gi, "")),
      "and never a password — an admin who chooses one knows it");

    const auditHasNoLink = (
      await c.query(
        "select count(*)::int n from public.audit_events where action='user.password_reset_issued' and metadata::text like '%token=%'",
      )
    ).rows[0].n;
    r.ok(auditHasNoLink === 0,
      "the link is NOT written to the audit trail — until used it is a credential for that account",
      auditHasNoLink);

    // ---- one name for the platform role ----
    //
    // 'platform_admin' used to be accepted by the column's CHECK and by the
    // /admin gate, but NOT by participant management, and the admin page
    // offered it in a dropdown. So an administrator could hand somebody a
    // role that opened the page and was refused on every action in it.
    r.section("the platform role has exactly one name");

    const secondName = await A("PUT", `/admin/users/${fUid}/role`, { global_role: "platform_admin" });
    r.ok(!secondName.success && secondName.error.code === "VALIDATION_ERROR",
      "'platform_admin' is refused — the second name for this role is gone",
      secondName.error?.message);

    const dbRefuses = await c
      .query("update public.profiles set global_role='platform_admin' where id=$1", [fUid])
      .then(() => null, (err) => err.message);
    r.ok(dbRefuses !== null,
      "and the CHECK constraint refuses it too, so it cannot be set behind Go's back",
      dbRefuses);

    // The two checks that disagreed now answer through one function, so a
    // platform admin who can open /admin can also act on the workshop
    // endpoints it drives.
    //
    // The condition is CONSTRUCTED rather than searched for. Looking for "a
    // workshop this account is not in" found none on dev, so the assertion
    // silently did not run — which is the same defect as one passing for the
    // wrong reason, just quieter. Dropping the admin's own membership from
    // this suite's own probe workshop makes it hold on any database.
    // Asserted on a WRITE, because the writes are what canManageParticipants
    // guards. Reading the roster is deliberately members-only — the admin
    // page reads it through /admin/workshops/{id}/participants instead — so
    // using the read here failed and said so, which is the assertion doing
    // its job rather than a bug in the gate.
    await c.query("delete from public.workshop_members where workshop_id=$1 and user_id=$2",
      [probeWorkshop, fUid]);

    // The REFUSAL goes first, deliberately. The invite below adds the
    // participant to this workshop, and once they are a member the refusal
    // would be about their role rather than about having no claim on the
    // workshop at all — a pass, for the wrong reason.
    const noClaim = await P("POST", `/workshops/${probeWorkshop}/participants`, {
      email: PROBE_EMAIL,
      role: "participant",
    });
    r.ok(!noClaim.success,
      "a non-member without the platform role cannot add participants",
      noClaim.status);

    // Invites an EXISTING demo account rather than a fresh address: an invite
    // that succeeds with a new address leaves a real auth user behind on the
    // shared dev project every time the suite runs.
    const adminInvites = await A("POST", `/workshops/${probeWorkshop}/participants`, {
      email: ACCOUNTS.participant,
      role: "participant",
    });
    r.ok(adminInvites.success,
      "while a platform admin can, on a workshop they are NOT a member of — the check that used to disagree with the /admin gate",
      adminInvites.error?.message);

    // ---- "disabled" has to disable ----
    //
    // SetUserStatus wrote profiles.status and nothing read it; authz never
    // joined profiles and supaadmin.SetUserBanned had no callers at all. So a
    // disabled person kept every workshop they had.
    r.section("a disabled account loses access, not just a column");

    const pTokenBefore = await token(ACCOUNTS.participant);
    const Pd = client(baseUrl, pTokenBefore);
    const beforeDisable = await Pd("GET", `/workshops/${WS}`);
    r.ok(beforeDisable.success,
      "the participant can read the workshop before being disabled",
      beforeDisable.error?.message);

    await c.query("update public.profiles set status='disabled' where id=$1", [pUid]);
    const afterDisable = await Pd("GET", `/workshops/${WS}`);
    r.ok(!afterDisable.success,
      "and is refused on the SAME token once disabled — this SUCCEEDED before authz joined profiles",
      afterDisable.status);
    await c.query("update public.profiles set status='active' where id=$1", [pUid]);

    const backAgain = await Pd("GET", `/workshops/${WS}`);
    r.ok(backAgain.success,
      "re-enabling restores access, so disabling is reversible rather than destructive",
      backAgain.error?.message);

    // No "last administrator cannot be disabled" check, because there is no
    // such guard and there must not be one: it would be unreachable. An
    // active administrator reaching this endpoint is either disabling
    // somebody else — so not the last — or themselves, which the
    // self-disable refusal below already covers. Asserting it here would
    // have passed on the self-disable refusal and reported a guard that does
    // not exist as working.
    const selfOff = await A("POST", `/admin/users/${fUid}/status`, { status: "disabled" });
    r.ok(!selfOff.success,
      "an admin cannot disable their own account — which is what keeps one administrator standing",
      selfOff.error?.message);
  } finally {
    // Restored UNCONDITIONALLY, not behind a flag. An earlier version only
    // restored when it believed it had demoted somebody, so a run that failed
    // mid-section left the demo facilitator as an analyst — and the NEXT run
    // then failed at the first management call, reporting a permissions bug
    // that was really leftover state. Suites share one database; cleanup has
    // to assume the body did not finish.
    void demotedFacilitator;
    await c.query(
      `update public.workshop_members set role = 'facilitator'
       where workshop_id = $1
         and user_id = (select id from public.profiles where email = $2)`,
      [WS, ACCOUNTS.facilitator],
    );
    if (priorGlobalRole !== null) {
      await c.query("update public.profiles set global_role=$2 where email=$1", [
        ACCOUNTS.facilitator,
        priorGlobalRole,
      ]);
    }


    if (probeWorkshop) {
      await c.query("update public.workshops set status='draft', archived_at=null, archived_by=null where id=$1", [probeWorkshop]);
      await c.query("delete from public.workshops where id=$1", [probeWorkshop]);
    }
    await cleanup(c, { titlePrefixes: [PREFIX], ids: { factors: made.factors } });

    // Delete the probe account, so the dev project does not accumulate one per
    // run. Membership cascades from profiles.
    // Probe accounts LAST, including any stranded by an interrupted run.
    //
    // Order matters and cost a failing run to learn: profiles is referenced by
    // factors.created_by, so deleting the account before its contributions
    // violates that foreign key. The content has to go first, which is why
    // this sits below cleanup() rather than beside the other state restores.
    const probeIDs = new Set(
      (
        await c.query(
          "select id::text id from public.profiles where email like 'iam-probe-%@example.invalid'",
        )
      ).rows.map((x) => x.id),
    );
    if (invitedUserID) probeIDs.add(invitedUserID);

    for (const id of probeIDs) {
      // Anything of theirs that outlived the title-prefix cleanup; without
      // this the profile delete fails on the FK rather than on anything real.
      await c.query("delete from public.weights where user_id=$1", [id]);
      await c.query("delete from public.factors where created_by=$1 and title like $2", [
        id,
        `${PREFIX}%`,
      ]);
      await c.query("delete from public.workshop_members where user_id=$1", [id]);
      await c.query("delete from public.workspace_members where user_id=$1", [id]);
      await c.query("delete from public.profiles where id=$1", [id]).catch(() => {});
      await fetch(`${e.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: {
          apikey: e.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }).catch(() => {});
    }
  }
});
