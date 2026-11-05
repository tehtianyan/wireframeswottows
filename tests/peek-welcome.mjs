// Open a REAL invitation link in a REAL browser and see what the invitee sees.
//
// WHY THIS CANNOT BE AN API TEST. The reported defect was "the link directed
// the participant to the login page without keying in their password", and
// every HTTP response in that flow was correct — the server minted a valid
// link, returned it and logged it. What went wrong happened in the browser
// afterwards. tests/suites/invite-landing.js pins the SOURCE properties that
// make it work; this probe is the only thing that answers "and does the page
// actually ask for a password?".
//
// It mints a genuine one-time token for a throwaway account, opens the link,
// reports what rendered, and then deletes the account — so the token is spent
// on a probe rather than on anybody real.
//
// Needs the dev UI (`npx vite dev --mode dev`, port 8080) and the devserver
// (port 3001). Run:
//
//   SWOT_ENV_FILE=.env.dev node tests/peek-welcome.mjs
import fs from "node:fs";
import { env, token, client, db, ACCOUNTS, DEMO_WORKSHOP } from "./lib/harness.js";

const UI = process.argv[2] ?? "http://localhost:8080";
const API = process.argv[3] ?? "http://localhost:3001";
const SHOTS = "tests/.shots";

function findBrowser() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p)) ?? null;
}

const exe = findBrowser();
if (!exe) {
  console.log("SKIP: no Chrome or Edge found.");
  process.exit(0);
}
if ((await fetch(UI).then((r) => r.status).catch(() => 0)) !== 200) {
  console.log(`SKIP: no dev UI on ${UI} — run: npx vite dev --mode dev`);
  process.exit(0);
}

const e = env();
const c = await db();
const probe = `peek-welcome-${Date.now()}@example.invalid`;
let userID = null;

try {
  const F = client(API, await token(ACCOUNTS.facilitator));
  const ws = DEMO_WORKSHOP ?? (await c.query("select id from public.workshops limit 1")).rows[0].id;

  // `deliver: "link"` so the link comes back in the response instead of being
  // mailed. Emailing and showing a link are mutually exclusive for one
  // invitation — GoTrue keeps one token per user — so asking for the link is
  // how a probe gets one without killing a mailed one.
  const invited = await F("POST", `/workshops/${ws}/participants`, {
    email: probe, name: "Sam Rivera", role: "participant", deliver: "link",
  });
  userID = invited.data?.user_id ?? null;
  const link = invited.data?.invite_link;
  if (!link) {
    console.log("no link came back:", JSON.stringify(invited.error ?? invited.data));
    process.exit(1);
  }

  // The link the server minted points at SITE_URL, which on dev is the vite
  // port; rewritten here only if the probe was pointed somewhere else.
  const url = new URL(link);
  const target = `${UI}${url.pathname}${url.search}`;
  console.log(`opening ${target.replace(/token_hash=[^&]+/, "token_hash=…")}`);

  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

  const problems = [];
  page.on("pageerror", (err) => problems.push(String(err).slice(0, 160)));

  await page.goto(target, { waitUntil: "networkidle", timeout: 45000 });
  // The exchange is a round trip to GoTrue, so give the screen a moment to
  // settle past "Checking your invitation…".
  await page.waitForTimeout(2500);

  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const heading = await page.locator("h1").first().innerText().catch(() => "(none)");
  const passwordFields = await page.locator('input[type="password"]').count();
  const emailFields = await page.locator('input[type="email"]').count();
  const addressBar = page.url();

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/welcome-invite.png`, fullPage: true });

  console.log(`\nheading:          ${heading}`);
  console.log(`password inputs:  ${passwordFields}`);
  console.log(`email inputs:     ${emailFields}`);
  console.log(`token still in URL: ${/token_hash/.test(addressBar) ? "YES — it should be stripped once spent" : "no"}`);
  console.log(`page errors:      ${problems.length ? problems.join(" | ") : "none"}`);
  console.log(`\nfirst 300 chars: ${text.slice(0, 300)}`);

  // THE VERDICT, phrased as the defect. "Asked for a password" is the fix;
  // "asked for an email and a password" is the sign-in form, which is the bug.
  const asksForPassword = passwordFields >= 2 && emailFields === 0;
  const isSignInForm = emailFields >= 1 && passwordFields === 1;
  console.log(
    `\nVERDICT: ${
      asksForPassword
        ? "the invitee is asked to choose a password — the reported defect is fixed"
        : isSignInForm
          ? "FELL THROUGH TO THE SIGN-IN FORM — this is the reported defect"
          : "neither screen; read the screenshot at " + SHOTS + "/welcome-invite.png"
    }`,
  );
  console.log(`screenshot: ${SHOTS}/welcome-invite.png`);

  // And the second visit must NOT silently work: the token is spent, which is
  // the state a mail scanner leaves behind. The page has to say so.
  const page2 = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page2.goto(target, { waitUntil: "networkidle", timeout: 45000 });
  await page2.waitForTimeout(2500);
  const second = (await page2.locator("body").innerText()).replace(/\s+/g, " ").trim();
  await page2.screenshot({ path: `${SHOTS}/welcome-spent.png`, fullPage: true });
  const explains = /no longer works|could not be used|expire/i.test(second);
  console.log(
    `\nsecond visit (token already spent): ${
      explains ? "explained, with a way to ask for another" : "NOT EXPLAINED — " + second.slice(0, 160)
    }`,
  );
  console.log(`screenshot: ${SHOTS}/welcome-spent.png`);

  await browser.close();
} finally {
  if (userID) {
    await c.query("delete from public.workshop_members where user_id=$1", [userID]).catch(() => {});
    await c.query("delete from public.workspace_members where user_id=$1", [userID]).catch(() => {});
    await c.query("delete from public.profiles where id=$1", [userID]).catch(() => {});
    await fetch(`${e.SUPABASE_URL}/auth/v1/admin/users/${userID}`, {
      method: "DELETE",
      headers: {
        apikey: e.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }).catch(() => {});
  }
  await c.query("delete from public.email_deliveries where to_email like '%@example.invalid'").catch(() => {});
  await c.end().catch(() => {});
}
