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
const WELCOME = read("src", "routes", "welcome.tsx");
const FORGOT = read("src", "routes", "forgot-password.tsx");
const ROOT_TSX = read("src", "routes", "__root.tsx");

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
  // ordinary visit. The gate must say something when EITHER signal is present.
  //
  // This assertion used to look for `needsPassword && (` and it broke when the
  // second signal was added — correctly, and it is fixed by asserting the
  // RELATIONSHIP rather than one operand: the explanation must be reached from
  // both, because `needsPassword` alone cannot see a spent link (its error
  // fragment carries no `type=recovery`), which is how this went unexplained
  // for so long.
  const explains = /\(\s*linkFailure\s*\|\|\s*needsPassword\s*\)\s*&&/.test(AUTH);
  r.ok(explains,
    "AuthGate explains BOTH a link that did not sign you in and one GoTrue refused, rather than silently asking for a password they cannot have",
    explains);

  r.ok(/needsPassword/.test(AUTH) && AUTH.indexOf("if (!session)") < AUTH.lastIndexOf("needsPassword"),
    "and still shows the set-password screen on the authenticated path, after the session check");

  // The error must be read from a module-load snapshot too. A spent link's
  // `#error=...` fragment is cleared by exactly the things that clear a token,
  // so reading it late is reading it after it is gone — the same trap, one
  // field over.
  r.ok(/export function linkFailureFromURL/.test(LANDING),
    "the failure is read from the same module-load snapshot as the token, not from the live URL");
  const readsBoth = /initialHash\.replace/.test(LANDING) && /params\.get\("error_code"\)/.test(LANDING);
  r.ok(readsBoth,
    "and from the hash AND the query, because which one carries it depends on the flow",
    readsBoth);

  r.section("the link is spent by a POST, not by anything that merely opens it");

  // THE SECOND HALF OF THE REPORTED DEFECT. GoTrue's own link is a GET to
  // /auth/v1/verify, so Outlook Safe Links, Gmail's prefetcher, antivirus
  // gateways and a provider's click tracking each burn a one-time token before
  // the recipient ever clicks. The app-hosted form is exchanged by verifyOtp,
  // which is a POST only a real browser running the app will make.
  r.ok(/token_hash/.test(WELCOME) && /verifyOtp/.test(WELCOME),
    "/welcome exchanges a token_hash through verifyOtp rather than relying on a GET having already done it");

  const welcomeCode = codeOnly(WELCOME);
  r.ok(!/detectSessionInUrl/.test(welcomeCode),
    "and does not depend on the client's own URL detection, which only handles the fragment form");

  // Same ordering rule as the fragment: tidy the address bar only once the
  // credential is spent. Here the evidence is in the QUERY, which nothing else
  // would have cleared — so the rule is upheld deliberately rather than by
  // luck, and the check is phrased on the order.
  const exchangeAt = welcomeCode.indexOf("verifyOtp");
  const stripAt = welcomeCode.indexOf("replaceState");
  r.ok(exchangeAt > -1 && stripAt > exchangeAt,
    "and strips the token from the URL only AFTER the exchange, never before",
    `verifyOtp at ${exchangeAt}, replaceState at ${stripAt}`);

  // A failed exchange must not land on a bare form either. This route is the
  // one place that knows the token was refused.
  r.ok(/explainLinkFailure/.test(WELCOME),
    "a refused token is explained on the page the link landed on");

  r.section("there is a way back in, and no seeded account named on the way");

  // THE REPORTED DEFECT, LITERALLY: a real demo address sat in the production
  // sign-in form's placeholder, which both named an account worth attacking
  // and made the page read as a demo to a client's staff.
  // Over the CODE, not the comments. The comment beside the fix names the
  // address it removed, which is worth keeping as the record of why the line
  // looks the way it does — and a check that reads it would fail for the
  // wrong reason, on a file that satisfies the property perfectly. Same
  // reasoning as codeOnly's other uses here, and as the skins suite stripping
  // comments before looking for a font name it had explained in prose.
  const authCode = codeOnly(AUTH);
  r.ok(!/jane\.smith@example\.com/.test(authCode),
    "the sign-in page RENDERS no seeded account, in any build — the placeholder and the dev hint were two copies of one mistake",
    authCode.match(/jane\.smith@example\.com/g)?.length ?? 0);

  r.ok(/to="\/forgot-password"/.test(AUTH),
    "and offers a way to reset a forgotten password, which is the one screen where somebody discovers they need it");

  // Both new screens must render for somebody who is NOT signed in. Inside
  // AuthGate, /welcome would show a sign-in form — which is precisely the
  // defect — and /forgot-password would be unreachable by definition.
  const standalone = /STANDALONE_AUTH_PATHS[\s\S]{0,200}?"\/welcome"[\s\S]{0,80}?"\/forgot-password"/.test(ROOT_TSX);
  r.ok(standalone,
    "/welcome and /forgot-password render outside AuthGate, so somebody with no password can reach them",
    standalone);

  r.ok(/forgotPassword/.test(FORGOT) && /res\.message/.test(FORGOT),
    "the reset screen prints the SERVER'S sentence — the answer is identical whether or not the address has an account, and composing one here would re-introduce that branch");

  r.section("setting a password confirms itself");

  // Item 5. Setting a password on a one-time link is the moment somebody
  // becomes a participant and nothing confirmed it; they were left wondering
  // whether the link had worked.
  r.ok(/confirmPasswordSet/.test(GATE),
    "the set-password screen asks the server to confirm by email once the password is saved");

  // It must NOT be awaited in a way that can fail the onboarding. Their
  // password is set and they are signed in; an error here would make a
  // successful onboarding look broken.
  const fireAndForget = /void authApi\.confirmPasswordSet\(\)\.catch\(/.test(GATE);
  r.ok(fireAndForget,
    "and does not let a mail failure fail the sign-up — the password is already set by then",
    fireAndForget);
});
