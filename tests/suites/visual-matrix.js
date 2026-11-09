// Does the strategy matrix LOOK right in a real browser?
//
// WHY A SECOND BROWSER SUITE. `tows-matrix.js` reads the source and drives
// the API, and both will pass on a grid that renders as a wrapped row, a
// 3-and-1, or a box that slides the document sideways. Between "the axes are
// derived from the categories" in the source and "there is a 3x3 on screen"
// sit the grid template, `min-width: auto` on a grid item, and a track floor
// that may be wider than the column it lives in. Every one of those has
// shipped a visible defect in this project while every other suite was green:
// the SWOT panels that could not grow past 304px, the relationship matrix
// that drew three-and-one the moment the AI column came out.
//
// A 3x3 with content on two edges and an empty corner is more geometry than
// either of those, so it is measured rather than reasoned about.
//
// It skips loudly when there is no browser or no dev UI — a suite that fails
// for want of Chrome teaches nothing about the matrix.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const EMAIL = process.env.SWOT_UI_EMAIL ?? "jane.smith@example.com";
const PASSWORD = process.env.SWOT_UI_PASSWORD ?? "SwotDemo2026!";
const SHOTS = process.env.SWOT_SHOT_DIR ?? path.join(ROOT, "tests", ".shots");

function findBrowser() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p)) ?? null;
}

runSuite("visual-matrix", async ({ results: r }) => {
  const exe = findBrowser();
  if (!exe) {
    r.skip("no Chrome or Edge on this machine — cannot check the matrix visually");
    return;
  }
  let pw;
  try {
    pw = await import("playwright-core");
  } catch {
    r.skip("playwright-core is not installed (npm i -D playwright-core)");
    return;
  }
  try {
    const res = await fetch(UI, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) {
    r.skip(`dev UI not reachable at ${UI} (${e.message}) — start it with: npx vite dev --mode dev`);
    return;
  }

  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`);
    });

    await page.goto(UI, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 30000 });
    r.ok(true, `signed in to ${UI} as ${EMAIL}`);

    const api = process.env.SWOT_API_BASE ?? "http://localhost:3001/api/v1";
    const token = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.includes("auth-token")) continue;
        try {
          const v = JSON.parse(localStorage.getItem(k));
          if (v?.access_token) return v.access_token;
        } catch {}
      }
      return null;
    });
    r.ok(Boolean(token), "the signed-in session is readable, so the suite can pick a workshop");
    const call = async (p) =>
      (await fetch(`${api}${p}`, { headers: { Authorization: `Bearer ${token}` } })).json();

    // THE AXIS LAYOUT IS OPTED INTO, so match on the config rather than on
    // the stage type. The capture-board suite's first version matched any
    // capture stage, picked a Transformation workshop and timed out waiting
    // for tiles that were never going to render.
    // "COULD NOT READ THE LIST" IS NOT "THERE IS NOTHING THERE".
    //
    // `api` defaults to localhost, so pointing this suite at production
    // without SWOT_API_BASE sends a production token to the dev server, gets
    // UNAUTHORIZED, and then reports "no workshop with an axis-layout relate
    // stage" — a confident statement about the deployment, from a request
    // that never reached it. The same failure the capture board's drag check
    // was written to avoid. So the envelope is read before the data.
    const listed = await call("/workshops");
    if (!listed?.success) {
      r.skip(
        `could not read the workshop list from ${api} — ${listed?.error?.code ?? "no response"}. ` +
          `Set SWOT_API_BASE when the UI is not the local dev server.`,
      );
      await browser.close();
      return;
    }
    const workshops = listed.data ?? [];
    let found = null;
    const considered = [];
    for (const w of workshops) {
      const detail = (await call(`/workshops/${w.id}`))?.data;
      const stage = detail?.methodology?.stages?.find(
        (s) => s.stage_type === "relate" && s.config?.layout === "axis",
      );
      if (!stage) {
        considered.push(`${w.name}: no axis relate stage`);
        continue;
      }
      // PICK ONE WITH THEMES ON IT. The first version took the first
      // match and landed on a leftover probe workshop with an empty board,
      // so the drag check skipped for a reason that had nothing to do with
      // dragging. Same lesson as choosing a capture stage by `layout`
      // rather than by stage type.
      const themes = (await call(`/workshops/${w.id}/syntheses`))?.data ?? [];
      const candidate = {
        workshop: w, stage, themes: themes.length,
        types: detail.methodology.relationship_types ?? [],
      };
      if (!found || themes.length > found.themes) found = candidate;
      if (themes.length === 0) considered.push(`${w.name}: no themes`);
    }
    if (!found) {
      r.skip(`no workshop with an axis-layout relate stage (${considered.join("; ")})`);
      return;
    }
    r.ok(true, `measuring ${found.workshop.name} / ${found.stage.key}`,
      `${found.types.length} relationship types, ${found.themes} themes`);

    await page.goto(`${UI}/w/${found.workshop.id}/stage/${found.stage.key}`,
      { waitUntil: "domcontentloaded" });

    // WAIT FOR THE THING UNDER TEST. The grid needs the object-kind
    // catalogue, the themes and the relationships, all of which land after
    // the shell paints. Five times in this project a probe has reported
    // "absent" when it meant "I looked too early".
    const appeared = await page
      .waitForFunction(() => document.querySelectorAll("[data-cell-type-id]").length > 0,
        { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!appeared) {
      r.skip("the quadrant cells never rendered — cannot tell a layout bug from a load failure");
      return;
    }

    r.section("the grid is a grid");

    const cells = await page.$$eval("[data-cell-type-id]", (els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return {
          x: Math.round(b.x), y: Math.round(b.y),
          w: Math.round(b.width), h: Math.round(b.height),
        };
      }));
    r.ok(cells.length === found.types.length,
      "one cell per relationship type, no more and no fewer",
      `${cells.length} cells for ${found.types.length} types`);

    const xs = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b);
    const ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);
    // A WRAPPED FLEX ROW WOULD PASS A COUNT CHECK AND FAIL THIS ONE. That is
    // precisely how the stage tiles came out six narrow above four wide.
    r.ok(xs.length * ys.length === cells.length,
      "they sit on a rectangular lattice rather than wrapping",
      `${xs.length} columns x ${ys.length} rows = ${cells.length}`);

    const widths = [...new Set(cells.map((c) => c.w))];
    r.ok(Math.max(...widths) - Math.min(...widths) <= 1,
      "every quadrant is the same width", widths.join(", "));
    // HEIGHT IS ASKED PER ROW, NOT ACROSS THE GRID, and the distinction is
    // a design decision rather than a loosened check. Cells in one row must
    // match or the row is ragged — grid `stretch` gives that, and losing it
    // would mean something had broken out of the track. Rows differing from
    // each other is correct: a quadrant holding six actions SHOULD be taller
    // than an empty one, and forcing every row to the tallest (auto-rows-fr,
    // which the stage tiles do need) would print a screenful of dead space
    // whenever one quadrant is busy and three are not.
    for (const y of ys) {
      const row = cells.filter((c) => c.y === y).map((c) => c.h);
      r.ok(Math.max(...row) - Math.min(...row) <= 1,
        `cells in the row at y=${y} are the same height`, row.join(", "));
    }

    r.section("the axes are on the edges, and the corner is empty");

    // SCOPED TO THE GRID. The first version queried the whole page and
    // found "Build status", "Stage 5" and "Methodology guidance" sitting
    // above and left of the first cell — a confident failure about the page
    // header rather than the corner. The corner is a property of the grid,
    // so the question has to be asked of the grid.
    const marks = await page.$$eval("[data-matrix-grid] .label-caps", (els) =>
      els.map((e) => {
        const b = e.getBoundingClientRect();
        return { t: (e.textContent ?? "").trim(), x: Math.round(b.x), y: Math.round(b.y) };
      }));
    const firstX = xs[0], firstY = ys[0];
    const colHeads = marks.filter((m) => m.y < firstY && m.x >= firstX);
    const rowHeads = marks.filter((m) => m.x < firstX && m.y >= firstY);
    r.ok(colHeads.length === xs.length,
      "one category heading above each column", colHeads.map((m) => m.t).join(", "));
    r.ok(rowHeads.length === ys.length,
      "one category heading beside each row", rowHeads.map((m) => m.t).join(", "));
    const corner = marks.filter((m) => m.x < firstX && m.y < firstY);
    r.ok(corner.length === 0,
      "the top-left corner is empty, as the mockup has it",
      corner.map((m) => m.t).join(", ") || "empty");

    r.section("it stays inside the page");

    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    // THE DEFECT ONLY A BROWSER CATCHES. Last round a grid item's default
    // `min-width: auto` let the content column grow past its track and slid
    // the whole document sideways, with tsc, the build and the source suite
    // all green.
    r.ok(overflow.doc <= overflow.win + 1,
      "the document does not scroll sideways at 1440",
      `document ${overflow.doc} vs viewport ${overflow.win}`);

    const right = Math.max(...cells.map((c) => c.x + c.w));
    const contentRight = await page.evaluate(() => {
      const el = document.querySelector("main") ?? document.body;
      const b = el.getBoundingClientRect();
      return Math.round(b.x + b.width);
    });
    r.ok(right <= contentRight + 2,
      "...and the matrix ends inside the content column",
      `matrix ${right}, content ${contentRight}`);

    await page.screenshot({ path: path.join(SHOTS, "matrix-1440.png") });

    r.section("a theme can be lifted off an axis");

    // ASK WHETHER IT IS ALLOWED TO MOVE BEFORE CONCLUDING IT CANNOT. On the
    // capture board every seeded note is approved and therefore frozen, so a
    // lift check without that question fails for the right reason and looks
    // exactly like the bug it was written to catch.
    const handle = await page.$("[class*='cursor-grab']");
    if (!handle) {
      r.skip("no draggable theme on an axis — group some notes into themes first");
    } else {
      await handle.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
      const box = await handle.boundingBox();
      if (!box) {
        r.skip("could not measure the theme card");
      } else {
        // PRESS THE MIDDLE, where a person presses. A corner press would
        // pass straight over the defect that only a card's rim was
        // draggable — the capture board shipped exactly that.
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        const hit = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest("[class*='cursor-grab']") ? "theme" : (el?.tagName ?? "nothing");
        }, [cx, cy]);
        if (hit !== "theme") {
          // A check that cannot tell "could not press it" from "pressing it
          // did nothing" reports the second when it means the first.
          r.skip(`something overlaps the theme card at its centre (${hit})`);
        } else {
          await page.mouse.move(cx, cy);
          await page.mouse.down();
          await page.mouse.move(cx + 50, cy + 50, { steps: 10 });
          const lifted = await page.evaluate(
            () => Boolean(document.querySelector("body > div.fixed.z-50")));
          r.ok(lifted, "pressing a theme and moving lifts a ghost");
          await page.screenshot({ path: path.join(SHOTS, "matrix-drag.png") });
          // Escape then release, so the suite changes nothing — it is safe
          // to point at production.
          await page.keyboard.press("Escape");
          await page.mouse.up();
          const cleared = await page.evaluate(
            () => !document.querySelector("body > div.fixed.z-50"));
          r.ok(cleared, "...and Escape puts it back, changing nothing");
        }
      }
    }

    r.section("tablet width");

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(400);
    const tablet = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
    }));
    // The GRID may scroll in its own box — a cell narrower than its content
    // is unusable — but the PAGE may not.
    r.ok(tablet.doc <= tablet.win + 1,
      "no sideways PAGE scroll at tablet width; the grid scrolls in its own box",
      `document ${tablet.doc} vs viewport ${tablet.win}`);
    await page.screenshot({ path: path.join(SHOTS, "matrix-1024.png") });

    r.section("the page is not throwing");
    r.ok(problems.length === 0, "no console errors or uncaught exceptions",
      problems.slice(0, 3).join(" | ") || "clean");

    console.log(`\n  screenshots: ${SHOTS}`);
  } finally {
    await browser.close();
  }
});
