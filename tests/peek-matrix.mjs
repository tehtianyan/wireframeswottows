// Put real initiatives and actions in a quadrant, photograph it, remove them.
//
// Every geometry assertion passed on a matrix with NO actions in it, which
// means the part of the screen the whole change exists for has not been
// looked at. Screenshots have caught two defects in this project that a full
// green suite did not.
import fs from "node:fs";
import path from "node:path";

const API = process.env.SWOT_API_BASE ?? "http://localhost:3001/api/v1";
const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const SUPA = process.env.SUPA_URL;
const KEY = process.env.SUPA_KEY;
const EMAIL = "jane.smith@example.com";
const PARTICIPANT = "dana.whitfield@example.com";
const PASSWORD = "SwotDemo2026!";
const MARK = "peek-action";

async function signIn(email) {
  const res = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return j.access_token;
}

const call = (tok) => async (method, p, body) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
};

const fTok = await signIn(EMAIL);
const F = call(fTok);
const P = call(await signIn(PARTICIPANT));

const workshops = (await F("GET", "/workshops")).data ?? [];
let target = null;
for (const w of workshops) {
  const d = (await F("GET", `/workshops/${w.id}`)).data;
  const s = (d?.methodology?.stages ?? []).find(
    (x) => x.stage_type === "relate" && x.config?.layout === "axis");
  const rels = (await F("GET", `/workshops/${w.id}/relationships`)).data ?? [];
  if (s && rels.length > 0) { target = { w, s, d, rels }; break; }
}
if (!target) { console.log("no axis workshop with a pairing already made"); process.exit(0); }
console.log(`using ${target.w.name} / ${target.s.key}`);

const typeKey = target.d.methodology.relationship_types.find(
  (t) => target.rels.some((r) => r.relationship_type_id === t.id))?.key
  ?? target.d.methodology.relationship_types[0].key;
const weightKey = target.s.config.actions.weight;

const made = [];
const init = await F("POST", `/workshops/${target.w.id}/initiatives`, {
  title: `${MARK} Build out new focussed sales campaigns`,
  relationship_type_key: typeKey,
});
if (!init.success) { console.log("initiative failed:", init.error); process.exit(1); }
made.push(["initiatives", init.data.id]);

const titles = [
  ["Build out AI messaging that differentiates us", "All competitors are claiming the same things"],
  ["Create a campaign using Keyless for verified trust", "Aimed at privacy-concerned markets"],
  ["Refresh the FSI-specific pitch", "Leverage the wins already landed in this space"],
];
const actionIds = [];
for (const [t, d] of titles) {
  const a = await F("POST", `/workshops/${target.w.id}/recommendations`, {
    title: `${MARK} ${t}`, description: d, fields: { priority: "high" },
    parent_id: init.data.id,
  });
  if (a.success) { actionIds.push(a.data.id); made.push(["recommendations", a.data.id]); }
}

// A second initiative, because the mockup's cells hold several.
const init2 = await F("POST", `/workshops/${target.w.id}/initiatives`, {
  title: `${MARK} Invest in partners`, relationship_type_key: typeKey,
});
if (init2.success) {
  made.push(["initiatives", init2.data.id]);
  const a = await F("POST", `/workshops/${target.w.id}/recommendations`, {
    title: `${MARK} Cross-functional campaign to support the partner ecosystem`,
    description: "", fields: { priority: "medium" }, parent_id: init2.data.id,
  });
  if (a.success) made.push(["recommendations", a.data.id]);
}

// The room rates; the facilitator then ranks AGAINST the rating, which is the
// disagreement the screen has to show.
if (actionIds.length >= 2) {
  await P("PUT", `/workshops/${target.w.id}/recommendations/${actionIds[0]}/weights/${weightKey}`, { value: 5 });
  await P("PUT", `/workshops/${target.w.id}/recommendations/${actionIds[1]}/weights/${weightKey}`, { value: 2 });
  await F("PUT", `/workshops/${target.w.id}/recommendations/order`, {
    scope_id: init.data.id, ids: [actionIds[1], actionIds[0], ...actionIds.slice(2)],
  });
}

// ---- photograph ----
const exe = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));

try {
  if (!exe) { console.log("no browser; data left in place for manual viewing"); process.exit(0); }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(UI, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 30000 });
  await page.goto(`${UI}/w/${target.w.id}/stage/${target.s.key}`, { waitUntil: "domcontentloaded" });
  // Wait for the ACTIONS, not for the page.
  await page.waitForFunction(
    (m) => document.body.innerText.includes(m), MARK, { timeout: 30000 }).catch(() => {});
  const dir = "tests/.shots-matrix";
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, "matrix-with-actions.png") });
  console.log(`shot: ${path.resolve(dir, "matrix-with-actions.png")}`);
  await browser.close();
} finally {
  // ---- remove everything this probe made ----
  for (const [route, id] of made.reverse()) {
    await F("DELETE", `/workshops/${target.w.id}/${route}/${id}`);
  }
  const left = (await F("GET", `/workshops/${target.w.id}/initiatives`)).data ?? [];
  const stray = left.filter((i) => (i.title ?? "").includes(MARK));
  console.log(stray.length === 0 ? "cleaned up" : `WARNING: ${stray.length} left behind`);
}
