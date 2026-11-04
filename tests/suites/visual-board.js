// Does the capture board LOOK right in a real browser?
//
// WHY THIS EXISTS, AND WHY THE OTHER SUITES WERE NOT ENOUGH. The notes were
// reported as the wrong shape TWICE in one day, and on neither occasion could
// any existing suite see it. `capture-board.js` drives the real API and the
// API was correct throughout. `board-ui.js` reads the source and passed both
// times too — it asserted the CLASS was present, which is not the same claim
// as "the box on screen is square". Between a class name and a rendered box
// sit the grid that sets the width, `min-height: auto` on flex items, the
// aspect-ratio cascade and the panel's own padding. Every one of those was
// involved in one of the two wrong versions.
//
// So this one opens the page in a browser, measures the boxes, and saves
// screenshots. It asserts GEOMETRY, which is the thing that was wrong.
//
// It needs no browser download: `playwright-core` drives the Chrome or Edge
// already installed on the machine. It skips cleanly when neither is present
// or the dev server is not up, because a suite that fails for want of a
// browser teaches nothing about the board.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const EMAIL = process.env.SWOT_UI_EMAIL ?? "jane.smith@example.com";
const PASSWORD = process.env.SWOT_UI_PASSWORD ?? "SwotDemo2026!";
const SHOTS = process.env.SWOT_SHOT_DIR ?? path.join(ROOT, "tests", ".shots");

/** A browser already on this machine, or null. */
function findBrowser() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Is it square? Asked with a TOLERANCE, because it has to be.
 *
 * A browser lays a grid track out in fractional pixels and `aspect-ratio`
 * rounds the result, so an exactly-square box is not something to assert on.
 * 6% of the width is tight enough to fail every rectangle that was actually
 * reported — the ones shipped were 2-4x wider than tall — and loose enough
 * not to fail on subpixel rounding.
 */
const SQUARE_TOLERANCE = 0.06;
function squareness(box) {
  return Math.abs(box.width - box.height) / Math.max(1, box.width);
}

runSuite("visual-board", async ({ results: r }) => {
  const exe = findBrowser();
  if (!exe) {
    r.skip("no Chrome or Edge on this machine — cannot check the page visually");
    return;
  }

  let pw;
  try {
    pw = await import("playwright-core");
  } catch {
    r.skip("playwright-core is not installed (npm i -D playwright-core)");
    return;
  }

  // The dev UI has to be up. Checked before launching a browser so the
  // failure says which thing is missing.
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
    // A desktop viewport, and a second pass at tablet width below. The bug
    // depended on how wide the panel was, so one width would not have caught
    // it in both views.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`);
    });

    await page.goto(UI, { waitUntil: "domcontentloaded" });

    // ---- sign in ----
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 30000 });
    r.ok(true, `signed in to ${UI} as ${EMAIL}`);

    // ---- find a capture stage with notes on it ----
    // Navigated by URL rather than by clicking through, so the suite does not
    // also depend on the dashboard's markup.
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

    const call = async (p) => {
      const res = await fetch(`${api}${p}`, { headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    };
    const workshops = (await call("/workshops"))?.data ?? [];
    let found = null;
    const considered = [];
    for (const w of workshops) {
      const detail = (await call(`/workshops/${w.id}`))?.data;
      // THE BOARD IS OPTED INTO BY CONFIG (`"layout": "board"`), so a capture
      // stage without it renders CaptureCanvas and has no tiles to measure.
      // The first version of this suite matched any capture stage, picked a
      // Transformation workshop, and timed out waiting for notes that were
      // never going to appear — a failure that said nothing about the board.
      const stage = detail?.methodology?.stages?.find(
        (s) => s.stage_type === "capture" && s.config?.layout === "board",
      );
      if (!stage) {
        considered.push(`${w.name}: no board-layout capture stage`);
        continue;
      }
      const factors = (await call(`/workshops/${w.id}/factors`))?.data ?? [];
      if (factors.length >= 2) {
        found = { workshop: w, stage, factors };
        break;
      }
      considered.push(`${w.name}: ${factors.length} notes`);
    }
    if (!found) {
      r.skip(
        `no workshop with a board-layout capture stage and 2+ notes (${considered.join("; ")})`,
      );
      return;
    }
    r.ok(
      true,
      `measuring ${found.workshop.name} / ${found.stage.key}`,
      `${found.factors.length} notes`,
    );

    const url = `${UI}/w/${found.workshop.id}/stage/${found.stage.key}`;

    /** Loads the stage and returns every rendered note's box. */
    async function boxes(label) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-note-id]", { timeout: 30000 });
      // Let the clamp's layout effect and the ResizeObserver settle.
      await page.waitForTimeout(600);
      // fullPage, because the board sits well below the fold behind the
      // stage header, the guidance and the AI panel — a viewport shot of
      // this page shows everything EXCEPT the thing under test.
      await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true });
      return page.$$eval("[data-note-id]", (els) =>
        els.map((el) => {
          const b = el.getBoundingClientRect();
          const body = el.querySelector("button");
          const text = el.querySelector("button span");

          // DO ANY TWO CONTROLS INSIDE THE NOTE OVERLAP? On production the
          // footer was crowded enough that the delete icon sat on top of the
          // expand control and swallowed its clicks — the click failed, the
          // note never expanded, and no amount of measuring boxes would have
          // said why. Asked geometrically so it holds whatever the data is.
          const controls = [...el.querySelectorAll("button")].map((c) =>
            c.getBoundingClientRect(),
          );
          let overlap = null;
          for (let i = 0; i < controls.length; i++) {
            for (let j = i + 1; j < controls.length; j++) {
              const a = controls[i];
              const c = controls[j];
              // The body button legitimately contains nothing else; only
              // SIBLING controls sitting on each other are a defect.
              const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
              const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
              const contains =
                (a.left <= c.left && a.right >= c.right && a.top <= c.top && a.bottom >= c.bottom) ||
                (c.left <= a.left && c.right >= a.right && c.top <= a.top && c.bottom >= a.bottom);
              if (w > 1 && h > 1 && !contains) {
                overlap = `${Math.round(w)}x${Math.round(h)}px`;
              }
            }
          }

          return {
            id: el.dataset.noteId,
            themed: el.dataset.noteThemed === "true",
            // Viewport coordinates, so a check can actually press on the tile
            // rather than only measure it.
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            // Can this note be picked up at all? An APPROVED note is frozen
            // on purpose, and every seeded note on dev is approved — so a
            // lift check that did not ask this would fail there for the right
            // reason and look like the bug it was written to catch.
            grabbable: getComputedStyle(el).cursor === "grab",
            category: el.dataset.noteCategory,
            // How much of the tile is the note, rather than its chrome.
            textShare: body ? body.getBoundingClientRect().height / Math.max(1, b.height) : 0,
            clamp: text ? getComputedStyle(text).webkitLineClamp : null,
            overflowing: text ? text.scrollHeight - text.clientHeight > 1 : false,
            overlap,
            chars: (el.textContent ?? "").trim().length,
          };
        }),
      );
    }

    // ================================================================
    r.section("Every note is square on screen (grid view, 1440px)");
    // ================================================================

    const grid = await boxes("capture-grid-1440");
    r.ok(grid.length > 0, "notes are rendered", `${grid.length} boxes measured`);

    const loose = grid.filter((b) => !b.themed);
    const worst = loose.reduce(
      (acc, b) => (squareness(b) > squareness(acc) ? b : acc),
      loose[0] ?? { width: 1, height: 1 },
    );
    r.ok(
      loose.length > 0 && loose.every((b) => squareness(b) <= SQUARE_TOLERANCE),
      "EVERY loose note is square — THE REPORTED DEFECT (they were wide rectangles)",
      `worst: ${Math.round(worst.width)}x${Math.round(worst.height)} (${(
        squareness(worst) * 100
      ).toFixed(1)}% off)`,
    );

    // The size, which is the OTHER half of the report. A square that fills
    // the panel was the first wrong version: correct shape, absurd size.
    const widest = Math.max(...loose.map((b) => b.width));
    r.ok(
      widest <= 260,
      "...and a note is a POST-IT, not a panel — the first wrong version was a ~300px square",
      `widest ${Math.round(widest)}px`,
    );
    r.ok(
      Math.min(...loose.map((b) => b.width)) >= 100,
      "...and not so small it cannot be read across a room",
      `narrowest ${Math.round(Math.min(...loose.map((b) => b.width)))}px`,
    );

    // Several to a row is what makes it a wall. If the grid were still one
    // note per row, the squares would be panel-width again.
    const rows = new Set(grid.filter((b) => !b.themed).map((b) => Math.round(b.width)));
    r.ok(loose.length < 2 || rows.size <= 2, "...and the tiles are a consistent size", [...rows].join(", ") + "px");

    // A NOTE INSIDE A THEME IS THE SAME NOTE. The first version of this suite
    // measured only loose notes, and a screenshot then showed themed ones
    // noticeably larger and not square — the exclusion was hiding exactly the
    // thing the user had said WAS right before. They are the user's reference
    // point for the shape, so they are checked, not skipped.
    const themed = grid.filter((b) => b.themed);
    if (themed.length === 0) {
      r.skip("no theme on this board — themed notes not measured");
    } else {
      const worstThemed = themed.reduce(
        (a, b) => (squareness(b) > squareness(a) ? b : a),
        themed[0],
      );
      r.ok(
        themed.every((b) => squareness(b) <= SQUARE_TOLERANCE),
        "a note INSIDE a theme is square too",
        `worst: ${Math.round(worstThemed.width)}x${Math.round(worstThemed.height)}`,
      );
      r.ok(
        Math.abs(Math.max(...themed.map((b) => b.width)) - widest) <= 24,
        "...and the same size as a note beside it, so joining a theme does not resize it",
        `themed ${Math.round(Math.max(...themed.map((b) => b.width)))}px vs loose ${Math.round(
          widest,
        )}px`,
      );

      // CAN IT BE PICKED UP? The reported defect was that a note inside a
      // theme could not be dragged out at all, and no amount of measuring
      // boxes would show that: the note was the right shape and simply inert.
      // So this presses on a themed note and moves the pointer, which must
      // lift a ghost — then presses Escape, which puts it back. READ-ONLY:
      // nothing is dropped, so the suite stays safe against production.
      //
      // It presses the MIDDLE of the note, where a person presses. That is
      // the note's own text button, and until this was fixed every button
      // refused to start a drag — leaving only a ~10px padding rim draggable
      // on a 120px tile, which is indistinguishable from "it cannot be
      // dragged". Pressing a corner would have passed over that entirely.
      const themedTile = themed.find((b) => b.grabbable);
      if (!themedTile) {
        r.skip(
          "every note in a theme here is approved, so frozen by design — nothing to lift. " +
            "Needs a board with a submitted note inside a theme.",
        );
      } else {
        // SCROLLED INTO VIEW AND RE-MEASURED. The collected box is a viewport
        // rectangle taken at an earlier scroll position, and the board sits
        // well below the fold — pressing those coordinates lands on whatever
        // happens to be there now, which reports "no drag started" for a
        // reason that has nothing to do with the note.
        const handle = await page.$(`[data-note-id="${themedTile.id}"]`);
        await handle.scrollIntoViewIfNeeded();
        const live = await handle.boundingBox();
        const cx = live.x + live.width / 2;
        const cy = live.y + live.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 40, cy + 10, { steps: 6 });
        const ghost = await page.$$eval("[aria-hidden]", (els) =>
          els
            .filter((el) => /will-change-transform/.test(String(el.className)))
            .map((el) => el.textContent ?? ""),
        );
        r.ok(
          ghost.length > 0,
          "a note inside a theme can be LIFTED — the reported defect",
          ghost.length ? "ghost rendered" : "no ghost: the press started no drag",
        );
        // And it says what releasing would do, rather than leaving the person
        // to guess whether the note is leaving its group.
        r.ok(
          ghost.some((t) => /out of this|release|move|new /i.test(t)),
          "...and the ghost says what the drop will do to its theme",
          ghost.join(" | ").slice(0, 140),
        );
        await page.keyboard.press("Escape");
        await page.mouse.up();
        const stillThere = await page.$(`[data-note-id="${themedTile.id}"]`);
        r.ok(Boolean(stillThere), "...and Escape puts it back, changing nothing");

        // AND DROPPING IT ON A LOOSE NOTE REALLY OFFERS THE NEW THEME. This
        // is the user's gesture end to end: out of one group, onto another
        // note. It stops at the naming prompt and cancels, so nothing is
        // written — but everything up to the write is exercised, including
        // handleDrop's refusal path, which a source-level check can only
        // claim.
        const dropOnto = loose.find(
          (b) => b.grabbable && b.category === themedTile.category,
        );
        if (!dropOnto) {
          r.skip("no loose movable note in the same category to drop onto");
        } else {
          const src = await (await page.$(`[data-note-id="${themedTile.id}"]`)).boundingBox();
          const dst = await (await page.$(`[data-note-id="${dropOnto.id}"]`)).boundingBox();
          await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
          await page.mouse.down();
          await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 10 });
          await page.mouse.up();
          const prompt = await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => null);
          r.ok(
            Boolean(prompt),
            "dragging it onto another note offers a NEW theme — the gesture the user asked for",
            prompt ? "naming prompt opened" : "no prompt: the drop did nothing",
          );
          if (prompt) {
            await page.screenshot({
              path: path.join(SHOTS, "regroup-prompt.png"),
              fullPage: true,
            });
            await page.keyboard.press("Escape");
          }
        }
      }
    }

    // ================================================================
    r.section("A long note truncates with an ellipsis, and expands");
    // ================================================================

    r.ok(
      loose.every((b) => b.clamp && b.clamp !== "none"),
      "every note's text is clamped, which is what renders the '...'",
      `clamp values: ${[...new Set(loose.map((b) => b.clamp))].join(", ")}`,
    );

    // MOST OF A NOTE MUST BE THE NOTE. On production every factor is
    // `submitted`, so every tile carried an "IN REVIEW" pill that wrapped to
    // two lines and took a third of the note — leaving two lines for what
    // somebody had written. Dev's notes are approved and show no pill at all,
    // so this never appeared there: the check has to be about the PROPORTION,
    // not about the pill, or it only holds for the data it was written
    // against.
    const leanest = Math.min(...grid.map((b) => b.textShare));
    r.ok(
      leanest >= 0.45,
      "...and the text gets most of the tile, rather than the status chrome",
      `thinnest text area is ${Math.round(leanest * 100)}% of the note`,
    );

    const collided = grid.find((b) => b.overlap);
    r.ok(
      !collided,
      "no two controls inside a note overlap — a buried control eats its own clicks",
      collided ? `overlap of ${collided.overlap} on note ${collided.id}` : "none",
    );

    // The clamp has to be MEASURED. If it were a constant, every note would
    // report the same line count regardless of the space it has.
    const clampedTo = [...new Set(loose.map((b) => b.clamp))];
    r.ok(clampedTo.length >= 1 && Number(clampedTo[0]) >= 2, "...to at least two lines", clampedTo.join(", "));

    // Expand a truncated note and confirm something actually changed.
    const expandable = await page.$('[data-note-id] button[aria-expanded="false"]');
    if (!expandable) {
      r.skip("no truncated note on this board to expand — add a long note to cover this");
    } else {
      const noteId = await expandable.evaluate(
        (el) => el.closest("[data-note-id]").dataset.noteId,
      );
      const before = await page.$eval(
        `[data-note-id="${noteId}"]`,
        (el) => el.getBoundingClientRect().height,
      );
      await expandable.click();
      await page.waitForTimeout(350);
      const after = await page.$eval(
        `[data-note-id="${noteId}"]`,
        (el) => el.getBoundingClientRect().height,
      );
      await page.screenshot({ path: path.join(SHOTS, "capture-expanded.png") });
      r.ok(
        after > before + 4,
        "expanding a clamped note reveals the rest of it",
        `${Math.round(before)}px -> ${Math.round(after)}px`,
      );
      const stillHidden = await page.$eval(
        `[data-note-id="${noteId}"] button span`,
        (el) => el.scrollHeight - el.clientHeight > 1,
      );
      r.ok(!stillHidden, "...and once expanded nothing is left cut off");
    }

    // ================================================================
    r.section("Column view, and a tablet");
    // ================================================================

    // RELOADED FIRST, because the expand check above left a note open and an
    // expanded note is SUPPOSED not to be square. Measuring on top of it made
    // this check fail on the test's own leftover state rather than on the
    // layout — a failure for a reason other than the one it names.
    await boxes("capture-grid-reset");

    // The clamp is measured from the box, so a narrower panel must still
    // produce squares — that is the case a hardcoded line count fails.
    // Targeted by its accessible name, not by `aria-pressed="false"`, which
    // matches any unpressed toggle on the page.
    const toggled = await page.$('[aria-label="Board layout"] button:has-text("Columns")');
    if (toggled) {
      await toggled.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, "capture-columns-1440.png") });
      const cols = await page.$$eval("[data-note-id]", (els) =>
        els
          .filter((el) => el.dataset.noteThemed !== "true")
          .map((el) => {
            const b = el.getBoundingClientRect();
            return { width: b.width, height: b.height };
          }),
      );
      const worstCol = cols.reduce(
        (a, b) =>
          Math.abs(b.width - b.height) / b.width > Math.abs(a.width - a.height) / a.width ? b : a,
        cols[0] ?? { width: 1, height: 1 },
      );
      r.ok(
        cols.length > 0 && cols.every((b) => squareness(b) <= SQUARE_TOLERANCE),
        "notes stay square in the other view, where the panels are narrower",
        `worst: ${Math.round(worstCol.width)}x${Math.round(worstCol.height)}`,
      );

      // Column view is a horizontally scrolling strip of panels. It must
      // scroll INSIDE itself — if it pushes the document wider, the whole
      // page slides sideways, which is the one layout failure that makes a
      // board unusable rather than merely ugly.
      const pageSlides = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      r.ok(!pageSlides, "...and column view scrolls inside itself, not the whole page");

      // Back to grid, so the choice this suite made does not leak into the
      // next measurement through localStorage.
      const back = await page.$('[aria-label="Board layout"] button:has-text("Grid")');
      await back?.click();
      await page.waitForTimeout(300);
    } else {
      r.skip("no view toggle found — the layout switch could not be exercised");
    }

    const tablet = await context.newPage();
    await tablet.setViewportSize({ width: 820, height: 1180 });
    await tablet.goto(url, { waitUntil: "domcontentloaded" });
    await tablet.waitForSelector("[data-note-id]", { timeout: 30000 });
    await tablet.waitForTimeout(600);
    await tablet.screenshot({ path: path.join(SHOTS, "capture-tablet-820.png") });
    const tabletBoxes = await tablet.$$eval("[data-note-id]", (els) =>
      els
        .filter((el) => el.dataset.noteThemed !== "true")
        .map((el) => {
          const b = el.getBoundingClientRect();
          return { width: b.width, height: b.height };
        }),
    );
    r.ok(
      tabletBoxes.length > 0 && tabletBoxes.every((b) => squareness(b) <= SQUARE_TOLERANCE),
      "...and at tablet width, which the project supports",
      `${tabletBoxes.length} notes, widest ${Math.round(
        Math.max(...tabletBoxes.map((b) => b.width)),
      )}px`,
    );

    // No horizontal page scroll — the one layout failure that makes a board
    // unusable rather than merely ugly.
    const overflows = await tablet.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    r.ok(!overflows, "...with no sideways page scroll at that width");

    // ================================================================
    r.section("The page is not throwing");
    // ================================================================
    // Dropbox corrupting node_modules/.vite renders the page but leaves it
    // dead, which looks exactly like a styling bug. Worth naming explicitly.
    r.ok(
      problems.length === 0,
      "no console errors or uncaught exceptions while rendering the board",
      problems.slice(0, 3).join(" | ") || "clean",
    );

    console.log(`\n  screenshots: ${SHOTS}`);
  } finally {
    await browser.close();
  }
});
