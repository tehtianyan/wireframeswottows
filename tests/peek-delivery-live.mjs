// READ-ONLY. Opens the delivery board on a deployment and measures it.
//
// `tests/peek-delivery.mjs` plants actions and is therefore for dev ONLY —
// several suites and probes in this repo write, and production is where UAT
// happens. This one signs in, looks, and writes nothing, so it is the thing to
// run after a deploy.
//
//   SWOT_ENV_FILE=.env SWOT_UI_BASE=https://… SWOT_API_BASE=https://…/api/v1 \
//     node tests/peek-delivery-live.mjs
import fs from "node:fs";
import path from "node:path";
import { token } from "./lib/harness.js";

const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const API = process.env.SWOT_API_BASE ?? "http://localhost:3001/api/v1";
const EMAIL = "jane.smith@example.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "SwotDemo2026!";

const tok = await token(EMAIL);
const call = async (p) =>
  (await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${tok}` } })).json();

const listed = await call("/workshops");
if (!listed?.success) {
  console.log(`could not read the workshop list from ${API}: ${JSON.stringify(listed?.error)}`);
  process.exit(1);
}

// Pick the workshop with the most actions, so the board is not empty — the
// same lesson as visual-matrix picking by theme count rather than taking the
// first match and then skipping for an unrelated reason.
let best = null;
for (const w of listed.data ?? []) {
  const detail = (await call(`/workshops/${w.id}`))?.data;
  const stage = (detail?.methodology?.stages ?? []).find(
    (s) => s.stage_type === "report" && s.config?.delivery,
  );
  if (!stage) continue;
  const board = (await call(`/workshops/${w.id}/delivery?stage_key=${stage.key}`))?.data;
  const n = board?.items?.length ?? 0;
  if (!best || n > best.n) best = { w, stage, n, board };
}
if (!best) {
  console.log("no workshop on this deployment declares a delivery board");
  process.exit(1);
}
console.log(`using ${best.w.name} / ${best.stage.key} — ${best.n} card(s)`);
console.log(`columns: ${best.board.states.map((s) => s.name).join(" | ")}`);
console.log(`exports: ${JSON.stringify(best.board.exports)} · can_move: ${best.board.can_move}`);

const exe = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!exe) {
  console.log("no browser installed; skipping the visual part");
  process.exit(0);
}

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: exe, headless: true });
const dir = "tests/.shots-prod-delivery";
fs.mkdirSync(dir, { recursive: true });
const errors = [];

for (const width of [1440, 420]) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(UI, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 40000 });
  await page.goto(`${UI}/w/${best.w.id}/stage/${best.stage.key}`, { waitUntil: "domcontentloaded" });
  await page
    .waitForSelector("[data-delivery-column]", { timeout: 40000 })
    .catch(() => console.log(`  ${width}px: the board never rendered`));
  // MEASURE THE SETTLED STATE. The ratings arrive in a second request, and a
  // card deliberately shows no figure until it has — so measuring too early
  // reports an empty pill as if the rating were missing, which is the
  // opposite of the defect this line exists to watch for.
  await page.waitForLoadState("networkidle").catch(() => {});

  const geom = await page.evaluate(() => {
    const cols = [...document.querySelectorAll("[data-delivery-column]")];
    const cards = [...document.querySelectorAll("[data-delivery-card]")];
    const exportBtn = [...document.querySelectorAll("button")].find((b) =>
      /export to jira/i.test(b.textContent ?? ""),
    );
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      columns: cols.map((el) => {
        const b = el.getBoundingClientRect();
        return { w: Math.round(b.width), top: Math.round(b.top) };
      }),
      cards: cards.length,
      exportVisible: Boolean(exportBtn && exportBtn.offsetParent !== null),
      // A card that says "not yet rated" while the ratings are still loading
      // is a confident wrong statement — the defect a screenshot caught on dev.
      unratedLabels: [...document.querySelectorAll("[data-delivery-card]")].filter((c) =>
        /not yet rated/.test(c.textContent ?? ""),
      ).length,
    };
  });
  const rows = new Set(geom.columns.map((x) => x.top)).size;
  console.log(
    `${width}px · columns ${geom.columns.length} on ${rows} row(s) · widths ${geom.columns
      .map((x) => x.w)
      .join("/")} · cards ${geom.cards} · overflow ${geom.overflow}px` +
      ` · Export to Jira visible: ${geom.exportVisible} · "not yet rated" on ${geom.unratedLabels}`,
  );

  const file = path.join(dir, `delivery-${width}.png`);
  await page.screenshot({ path: file, fullPage: width === 1440 });
  console.log(`  shot: ${path.resolve(file)}`);
  await page.close();
}
await browser.close();
console.log(errors.length === 0 ? "no console errors" : `CONSOLE ERRORS:\n  ${errors.join("\n  ")}`);
