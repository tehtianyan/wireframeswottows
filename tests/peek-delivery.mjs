// Put real actions on the delivery board, spread them across the columns,
// photograph it, and remove them.
//
// Every geometry and source assertion in tests/suites/delivery.js passed on a
// board that had never been LOOKED at. That is the same position the TOWS
// matrix was in when a screenshot found two initiatives drawing in reverse
// with 1103 checks green, and the capture board when its notes came out the
// wrong shape twice in a day. So this exists before the deploy, not after it.
//
//   SWOT_ENV_FILE=.env.dev node tests/peek-delivery.mjs
import fs from "node:fs";
import path from "node:path";
import { env, token, client, db, DEMO_WORKSHOP } from "./lib/harness.js";

const BASE = process.argv[2] ?? "http://localhost:3001";
const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const MARK = "peek-delivery";
const e = env();

const F = client(BASE, await token("jane.smith@example.com"));
const P = client(BASE, await token("dana.whitfield@example.com"));
const c = await db();

const detail = (await F("GET", `/workshops/${DEMO_WORKSHOP}`)).data;
const stages = detail.methodology.stages ?? [];
const reportStage = stages.find((s) => s.stage_type === "report" && s.config?.delivery);
if (!reportStage) {
  console.log("no stage declares a delivery board");
  process.exit(0);
}
const cfg = reportStage.config.delivery;
const typeKeys = (detail.methodology.relationship_types ?? []).map((t) => t.key);
console.log(`using ${detail.name} / ${reportStage.key}`);
console.log(`columns: ${cfg.states.map((s) => s.name).join(" | ")}`);

const made = { initiatives: [], recommendations: [] };

try {
  // Two initiatives in DIFFERENT quadrants with the SAME name, which is the
  // shape the Jira export has to disambiguate — worth seeing on screen too.
  const mkInit = async (title, typeKey) => {
    const res = await F("POST", `/workshops/${DEMO_WORKSHOP}/initiatives`, {
      title: `${MARK} ${title}`,
      relationship_type_key: typeKey,
    });
    if (!res.success) throw new Error(`initiative: ${res.error?.message}`);
    made.initiatives.push(res.data.id);
    return res.data.id;
  };
  const sales = await mkInit("Build out new focussed sales campaigns", typeKeys[0]);
  const partners = await mkInit("Invest in partners", typeKeys[1] ?? typeKeys[0]);

  const mkAction = async (parent, title, priority, desc) => {
    const res = await F("POST", `/workshops/${DEMO_WORKSHOP}/recommendations`, {
      title: `${MARK} ${title}`,
      description: desc,
      fields: { priority },
      parent_id: parent,
    });
    if (!res.success) throw new Error(`action: ${res.error?.message}`);
    made.recommendations.push(res.data.id);
    return res.data.id;
  };

  const a1 = await mkAction(sales, "Build out AI messaging that differentiates us", "critical",
    "All competitors are claiming the same things, so the message has to be ours.");
  const a2 = await mkAction(sales, "Create a campaign using Keyless for verified trust", "high",
    "Aimed at privacy-concerned markets.");
  const a3 = await mkAction(sales, "Refresh the FSI-specific pitch", "medium",
    "Leverage the wins already landed in this space.");
  const a4 = await mkAction(partners, "Cross-functional campaign to support the partner ecosystem",
    "medium", "");
  const a5 = await mkAction(partners, "Run a quarterly partner enablement day", "low", "");

  // Spread them, so no column is empty and the longest title is in the
  // narrowest place — a card that overflows its column is the thing a
  // geometry assertion over an empty board cannot see.
  const place = async (id, stateKey) => {
    const res = await F("PUT",
      `/workshops/${DEMO_WORKSHOP}/delivery/${id}?stage_key=${reportStage.key}`, { state: stateKey });
    if (!res.success) console.log(`  could not place: ${res.error?.message}`);
  };
  await place(a1, cfg.states[1].key);
  await place(a4, cfg.states[1].key);
  await place(a2, cfg.states[cfg.states.length - 1].key);

  // The room rates two of them, and the facilitator's rank disagrees — the
  // same disagreement the matrix has to show, carried onto this board.
  const weightKey = (detail.methodology.weights ?? []).find((w) => w.applies_to === "recommendation")?.key;
  if (weightKey) {
    await P("PUT", `/workshops/${DEMO_WORKSHOP}/recommendations/${a3}/weights/${weightKey}`, { value: 5 });
    await P("PUT", `/workshops/${DEMO_WORKSHOP}/recommendations/${a1}/weights/${weightKey}`, { value: 2 });
    await F("PUT", `/workshops/${DEMO_WORKSHOP}/recommendations/order`, {
      scope_id: sales, ids: [a1, a3, a2],
    });
  }

  // ---- what the export actually says ----
  const csvRes = await F("GET",
    `/workshops/${DEMO_WORKSHOP}/delivery/export/jira.csv?stage_key=${reportStage.key}`,
    undefined, { raw: true });
  console.log("\n==== the Jira file a person would upload ====\n");
  console.log(csvRes.text.split(/\r?\n/).slice(0, 14).join("\n"));
  console.log("\n==== end of excerpt ====\n");

  // ---- photograph ----
  const exe = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((p) => fs.existsSync(p));
  if (!exe) {
    console.log("no browser found; the data is left in place for manual viewing");
    process.exit(0);
  }

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const dir = "tests/.shots-delivery";
  fs.mkdirSync(dir, { recursive: true });

  for (const width of [1440, 900, 420]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    await page.goto(UI, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', "jane.smith@example.com");
    await page.fill('input[type="password"]', e.DEMO_PASSWORD ?? "SwotDemo2026!");
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 30000 });
    await page.goto(`${UI}/w/${DEMO_WORKSHOP}/stage/${reportStage.key}`, {
      waitUntil: "domcontentloaded",
    });
    // Wait for the CARDS, not for the page.
    await page
      .waitForFunction((m) => document.body.innerText.includes(m), MARK, { timeout: 30000 })
      .catch(() => console.log(`  ${width}px: the probe's actions never appeared`));

    // Measure what a passing source check cannot: does the document scroll
    // sideways, and do the columns sit on one row?
    const geom = await page.evaluate(() => {
      const grid = document.querySelector("[data-delivery-grid]");
      const cols = [...document.querySelectorAll("[data-delivery-column]")];
      const cards = [...document.querySelectorAll("[data-delivery-card]")];
      const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      return {
        overflow,
        columns: cols.map((el) => {
          const b = el.getBoundingClientRect();
          return { w: Math.round(b.width), top: Math.round(b.top), h: Math.round(b.height) };
        }),
        cardsWiderThanColumn: cards.filter((card) => {
          const col = card.closest("[data-delivery-column]");
          return col && card.getBoundingClientRect().width > col.getBoundingClientRect().width;
        }).length,
        gridFound: Boolean(grid),
      };
    });
    const rows = new Set(geom.columns.map((x) => x.top)).size;
    console.log(
      `${width}px · grid:${geom.gridFound} · columns:${geom.columns.length} on ${rows} row(s)` +
        ` · widths ${geom.columns.map((x) => x.w).join("/")}` +
        ` · document overflow ${geom.overflow}px` +
        ` · cards wider than their column: ${geom.cardsWiderThanColumn}`,
    );

    const file = path.join(dir, `delivery-${width}.png`);
    await page.screenshot({ path: file, fullPage: width === 1440 });
    console.log(`  shot: ${path.resolve(file)}`);
    await page.close();
  }
  await browser.close();
} finally {
  for (const id of made.recommendations) {
    await c.query("delete from public.weights where object_id = $1", [id]).catch(() => {});
    await F("DELETE", `/workshops/${DEMO_WORKSHOP}/recommendations/${id}`);
  }
  for (const id of made.initiatives) {
    await F("DELETE", `/workshops/${DEMO_WORKSHOP}/initiatives/${id}`);
  }
  const left = (await F("GET", `/workshops/${DEMO_WORKSHOP}/initiatives`)).data ?? [];
  const stray = left.filter((i) => (i.title ?? "").includes(MARK)).length;
  console.log(stray === 0 ? "cleaned up" : `WARNING: ${stray} left behind`);
  await c.end().catch(() => {});
}
