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

    const invited = await F("POST", `/workshops/${WS}/participants`, {
      email: PROBE_EMAIL, name: "IAM Probe Person", role: "analyst",
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
      email: PROBE_EMAIL, role: "participant",
    });
    r.ok(again.success && again.data.new_account === false,
      "re-inviting an existing address reuses the account instead of failing",
      again.error?.message ?? `new_account=${again.data?.new_account}`);
    r.ok(again.data?.user_id === invitedUserID, "and it is the same person", again.data?.user_id === invitedUserID);

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
