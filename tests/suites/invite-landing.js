// Where an invite link lands, and in what order the client reads it.
//
// A pure check over the source — no server, no database — because the bug it
// guards against cannot be reached from the API at all. Every HTTP test of the
// invite flow passed while the flow was broken: the server minted a correct
// link, returned it, and recorded it properly. What failed happened in the
// browser, after the link was opened, and in a specific ORDER:
//
//   1. useRecoveryLanding's effect detected the token in the URL fragment
//   2. ...and immediately stripped the fragment to keep the credential out of
//      browser history, which was a good reason
//   3. the Supabase client is constructed LAZILY, on first property access,
//      and that first access came next — so it read a URL with no token in it
//   4. no session was established, AuthGate fell through to "not signed in",
//      and the invitee was shown a sign-in form asking for the password the
//      link existed to let them choose
//
// Both halves were right on their own. Only their order was wrong, and nothing
// in a passing test suite or a code read made the order visible. These checks
// assert the two properties that keep it fixed: the question is answered from a
// snapshot taken at module load, and nothing strips the fragment before a
// session exists.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const LANDING = read("src", "lib", "recovery-landing.ts");
const GATE = read("src", "components", "SetPasswordGate.tsx");
const AUTH = read("src", "components", "AuthGate.tsx");

/**
 * The file with its comments removed, for checks about what the CODE does.
 * These files are heavily commented — deliberately, since the bug here was an
 * ordering nobody could see — and a check that reads a comment explaining the
 * old behaviour as if it were the behaviour would fail for the wrong reason.
 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

runSuite("invite-landing", async ({ results: r }) => {
  r.section("the question is answered before anything can clear the evidence");

  // The hash must be read at module scope, not inside a function that runs
  // later. `const x = window.location.hash` at the top level is the property;
  // a read inside a hook or callback is not.
  const moduleScopeRead = /^const\s+initialHash\s*=[^;]*window\.location\.hash/m.test(LANDING);
  r.ok(moduleScopeRead,
    "recovery-landing reads window.location.hash at module load, not inside a function",
    moduleScopeRead);

  r.ok(/type=\(recovery\|invite\)/.test(LANDING),
    "and matches both type=recovery and type=invite — the server mints invites through the recovery endpoint");

  // Detection must not live here any more. stripHash still touches
  // window.location — it has to, to rewrite the address bar — so the property
  // asserted is that no DETECTION happens here: no link-type literal.
  const gateCode = codeOnly(GATE);
  r.ok(!/type=(recovery|invite)/.test(gateCode),
    "SetPasswordGate recognises no link type of its own — detection moved to the module-load snapshot",
    gateCode.match(/type=(recovery|invite)/g)?.length ?? 0);

  r.ok(/useState\(landedOnRecoveryLink\)/.test(GATE),
    "the screen's initial state comes from that snapshot, so it does not depend on an event arriving in time");

  r.section("nothing strips the token before it has been exchanged");

  // The one surviving stripHash() call must be guarded by a session. This is
  // the actual defect: an unguarded strip discards the credential unused.
  // Every CALL SITE, line by line, excluding the declaration. Asserted this
  // way rather than with one regex over the file because the thing that must
  // hold is a property of each call: no unguarded strip anywhere.
  const callSites = GATE.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /stripHash\(\)/.test(line) && !/function stripHash/.test(line))
    .map(([n, line]) => [n, line.trim()]);

  r.ok(callSites.length >= 1,
    "the fragment is still cleared eventually — until used it is a bearer credential",
    `${callSites.length} call site(s)`);

  // `if (session) stripHash();` is the only acceptable shape: the strip must
  // be reached from a session existing, which means the token is already
  // spent. A strip reached from DETECTING the link is the original bug — it
  // ran before the client was even constructed, so the client was handed a
  // URL with nothing in it.
  const unguarded = callSites.filter(([, line]) => !/^if \(session\) stripHash\(\);$/.test(line));
  r.ok(unguarded.length === 0,
    "and every one is guarded by a session, so none can run before the token has been exchanged",
    unguarded.length === 0 ? "all guarded" : unguarded.map(([n, l]) => `line ${n}: ${l}`).join(" | "));

  r.section("a link that cannot sign you in says so");

  // Landing on the sign-in form with no explanation is what a broken invite
  // looked like from the invitee's side, and it is indistinguishable from an
  // ordinary visit. The gate must say something when both are true.
  r.ok(/needsPassword\s*&&\s*\(/.test(AUTH),
    "AuthGate tells somebody who arrived on a link that did not sign them in, rather than silently asking for a password they cannot have");

  r.ok(/needsPassword/.test(AUTH) && AUTH.indexOf("if (!session)") < AUTH.lastIndexOf("needsPassword"),
    "and still shows the set-password screen on the authenticated path, after the session check");
});
