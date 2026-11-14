// Where the stages are, and whether the way to them exists on screen.
//
// UAT 2026-11-14: "take the orphaned Stage 7 (Recommendations) to Stage 10
// (Insight Generation) from the Stages panel and put it in the Overview page.
// Create a button to the Overview page for the Facilitator to access."
//
// NOTHING ABOUT THIS IS VISIBLE TO AN HTTP CHECK. Every one of those stages
// returned the right data before the change and returns the same data after;
// the whole report is about WHERE a correct list is drawn. The source suite
// asserts the lists are passed to the right panels, and this opens the pages
// and counts the tiles — because "the class is present" has never been the
// same claim as "the box on screen is right" in this project, and a control
// that is rendered and wired to nothing photographs exactly like one that
// works.
//
// IT WRITES NOTHING, so it is safe against production. Point it there with
// SWOT_API_BASE / SWOT_UI_BASE.
import fs from "node:fs";
import path from "node:path";

const RAW = process.env.SWOT_API_BASE ?? "http://localhost:3001";
// SWOT_API_BASE MEANS TWO THINGS. tests/lib/harness.js appends /api/v1, so
// everywhere else it is an ORIGIN; the browser suites call fetch directly and
// want it WITH the path. Passing the value that works for every other suite
// surfaced as "Unexpected non-whitespace character after JSON at position 4".
const API = RAW.replace(/\/+$/, "").endsWith("/api/v1") ? RAW : `${RAW.replace(/\/+$/, "")}/api/v1`;
const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const SUPA = process.env.SUPA_URL;
const KEY = process.env.SUPA_KEY;
const PASSWORD = process.env.SWOT_PASSWORD ?? "SwotDemo2026!";
const FACILITATOR = process.env.SWOT_FACILITATOR ?? "jane.smith@example.com";

const out = [];
const say = (s) => { out.push(s); console.log(s); };

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

const call = (tok) => async (method, p) => {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
  });
  return res.json();
};

const F = call(await signIn(FACILITATOR));

// A workshop whose methodology HAS tool stages — otherwise there is nothing to
// have moved, and a probe reporting "no tools panel" would be describing the
// config rather than the screen.
//
// THE BUSIEST ONE, not the first. The first version took whatever came back
// first and landed on a leftover probe workshop with no factors in it, so every
// stage tile read "Not started" and the screenshots showed the panels over an
// empty room — true, and not what anybody is going to be looking at. The
// statuses on those tiles are derived from content, so a board with notes on it
// is the only version of this screen worth photographing.
const workshops = (await F("GET", "/workshops")).data ?? [];
const candidates = [];
for (const w of workshops) {
  if (w.status === "archived") continue;
  const d = (await F("GET", `/workshops/${w.id}`)).data;
  const stages = d?.methodology?.stages ?? [];
  const tools = stages.filter((s) => Array.isArray(s.config?.visible_to_roles));
  const flow = stages.filter((s) => !Array.isArray(s.config?.visible_to_roles));
  if (tools.length > 0 && flow.length > 0 && d.my_role === "facilitator") {
    const factors = (await F("GET", `/workshops/${w.id}/factors`)).data ?? [];
    candidates.push({ w, d, tools, flow, factors: factors.length });
  }
}
candidates.sort((a, b) => b.factors - a.factors);
const target = candidates[0];
if (!target) { say("no workshop with both a flow and tool stages, as a facilitator"); process.exit(0); }
say(`using ${target.w.name} — ${target.flow.length} flow stages, ${target.tools.length} tools, ${target.factors} factors`);

const exe = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!exe) { say("no browser installed — nothing to look at"); process.exit(0); }

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const dir = "tests/.shots-stages";
fs.mkdirSync(dir, { recursive: true });
const shot = async (name) => {
  const p = path.join(dir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  say(`  shot: ${path.resolve(p)}`);
};
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

try {
  await page.goto(UI, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', FACILITATOR);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 30000 });

  // ---------------------------------------------------------- the overview --
  await page.goto(`${UI}/w/${target.w.id}/overview`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.body.innerText.includes("Stages"), null, { timeout: 30000 });
  // Wait for the panel to have its tiles, not merely for the heading.
  await page.waitForFunction(
    () => document.querySelectorAll('a[href*="/stage/"]').length > 0, null, { timeout: 30000 },
  ).catch(() => {});
  // ...AND FOR THE STATUSES, which are a SECOND request. The first version of
  // this probe photographed ten tiles all reading "Not started" over a
  // workshop whose API was reporting nine of them in progress with real
  // counts — the panel was stating a fact while the answer was in flight, and
  // the probe was reporting the flash as the result. Both were fixed: the tile
  // now says nothing until it knows, which is what makes this wait
  // expressible at all.
  const unknownAtFirst = await page.evaluate(
    () => document.querySelectorAll('[data-stage-status="unknown"]').length);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-stage-status="unknown"]').length === 0,
    null, { timeout: 30000 },
  ).catch(() => say("  WARNING: the stage statuses never arrived"));
  say(`  tiles that withheld a status until it arrived: ${unknownAtFirst}`);
  // The metrics are a THIRD request, and they sit below the panels this change
  // moved — so a screenshot taken the moment the statuses land shows the page
  // with a hole in it. Waiting for them is the difference between
  // photographing the page and photographing a stage of its loading.
  await page.waitForFunction(
    () => document.body.innerText.includes("Workshop health"), null, { timeout: 30000 },
  ).catch(() => say("  WARNING: the metrics panel never arrived"));

  // COUNT PER PANEL, which is the whole claim. A count across the page would
  // be the same number before and after the change.
  const panels = await page.evaluate(() => {
    const headings = [...document.querySelectorAll("section")].map((sec) => {
      const title = sec.innerText.split("\n")[0]?.trim() ?? "";
      const tiles = [...sec.querySelectorAll('a[href*="/stage/"]')].map((a) =>
        a.innerText.replace(/\s+/g, " ").trim());
      const dashed = [...sec.querySelectorAll('a[href*="/stage/"]')].filter((a) => {
        const box = a.closest("div[class]");
        return box && getComputedStyle(box).borderStyle.includes("dashed");
      }).length;
      return { title, tiles, dashed };
    });
    return headings.filter((h) => h.tiles.length > 0);
  });
  for (const p of panels) {
    say(`  panel "${p.title}": ${p.tiles.length} tiles, ${p.dashed} dashed`);
    for (const t of p.tiles) say(`      ${t.replace(/\n/g, " · ")}`);
  }
  const stagesPanel = panels.find((p) => /^Stages/.test(p.title));
  const toolsPanel = panels.find((p) => /Facilitator tools/.test(p.title));
  say(`  the Stages panel holds the flow only: ${
    stagesPanel?.tiles.length === target.flow.length}`);
  say(`  a Facilitator tools panel exists with every tool in it: ${
    toolsPanel?.tiles.length === target.tools.length}`);
  say(`  and nothing in it is dashed as well as grouped: ${toolsPanel?.dashed === 0}`);
  await shot("overview-flow-and-tools");

  // ------------------------------------------------- the strip, and the way --
  const first = target.flow[0];
  await page.goto(`${UI}/w/${target.w.id}/stage/${first.key}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector('nav[aria-label="Methodology stages"]'), null, { timeout: 30000 });
  const strip = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Methodology stages"]');
    return [...nav.querySelectorAll("a")].map((a) => a.innerText.replace(/\s+/g, " ").trim());
  });
  say(`  strip on stage 1: ${strip.length} entries — ${strip.join(" | ")}`);
  say(`  it is the flow, not everything: ${strip.length === target.flow.length}`);

  // THE BUTTON. Found by its own text, then CONFIRMED by pressing it — a
  // control rendered and wired to nothing photographs identically to one that
  // works, which is how two controls inside a stack shipped doing nothing.
  const btn = page.locator('a[href*="/overview"]', { hasText: /^Overview$/ }).first();
  const present = (await btn.count()) > 0;
  say(`  an Overview control is on the stage header: ${present}`);
  if (present) {
    const box = await btn.boundingBox();
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? (el.closest('a[href*="/overview"]') ? "the control" : el.tagName) : "nothing";
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    say(`  the point at its centre is inside ${hit}`);
    await shot("stage-header-overview-button");
    await btn.click();
    await page.waitForFunction(
      () => location.pathname.endsWith("/overview"), null, { timeout: 15000 },
    ).catch(() => {});
    say(`  pressing it lands on the overview: ${
      await page.evaluate(() => location.pathname.endsWith("/overview"))}`);
  }

  // ----------------------------------- a tool stage still knows where it is --
  const tool = target.tools.find((s) => s.stage_type !== "knowledge") ?? target.tools[0];
  await page.goto(`${UI}/w/${target.w.id}/stage/${tool.key}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector('nav[aria-label="Methodology stages"]'), null, { timeout: 30000 });
  const onTool = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Methodology stages"]');
    const links = [...nav.querySelectorAll("a")];
    const current = links.find((a) => location.pathname.endsWith(a.getAttribute("href").split("/").pop()));
    return {
      entries: links.map((a) => a.innerText.replace(/\s+/g, " ").trim()),
      highlighted: current ? getComputedStyle(current).borderColor : null,
      hasCurrent: Boolean(current),
    };
  });
  say(`  strip on "${tool.name}": ${onTool.entries.length} entries — ${onTool.entries.join(" | ")}`);
  // A pasted URL still opens a tool stage — `visible_to_roles` is an
  // affordance, not a boundary — so the strip must still say where you are.
  say(`  the tool you are on is in its own strip: ${onTool.hasCurrent}`);
  await shot("tool-stage-strip");

  say(errors.length === 0 ? "no console errors" : `CONSOLE ERRORS: ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
