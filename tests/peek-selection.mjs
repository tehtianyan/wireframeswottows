// READ-ONLY. Selects notes in a real browser and photographs what that looks
// like, then opens a theme's hidden notes on the strategy matrix.
//
// EVERY ITEM IN THE 2026-11-10 UAT ROUND IS VISUAL, and the source suites
// assert that the code says the right things — which is not the claim "the
// screen shows them". That gap is where the note's shape was wrong twice in a
// day, where a wrapped kanban column came out double width, and where "not
// yet rated" was printed over work the room had rated.
//
// IT WRITES NOTHING. Selection is client state and the drag is cancelled with
// Escape, so this is safe to point at any deployment.
//
//   SWOT_ENV_FILE=.env.dev node tests/peek-selection.mjs
import fs from "node:fs";
import path from "node:path";
import { token, client } from "./lib/harness.js";

const UI = process.env.SWOT_UI_BASE ?? "http://localhost:8080";
const API = process.env.SWOT_API_BASE ?? "http://localhost:3001";
const EMAIL = "jane.smith@example.com";
const PASSWORD = process.env.DEMO_PASSWORD ?? "SwotDemo2026!";

const F = client(API, await token(EMAIL));

// A board-layout capture stage with the most notes on it, so the wall is not
// empty. Picked on `config.layout`, not on the stage type: the first version
// of visual-board matched any capture stage and timed out on a methodology
// that renders a plain canvas.
const listed = await F("GET", "/workshops");
if (!listed?.success) {
  console.log(`could not read the workshop list from ${API}: ${JSON.stringify(listed?.error)}`);
  process.exit(1);
}
let best = null;
for (const w of listed.data ?? []) {
  const detail = (await F("GET", `/workshops/${w.id}`))?.data;
  const stage = (detail?.methodology?.stages ?? []).find(
    (s) => s.stage_type === "capture" && s.config?.layout === "board",
  );
  if (!stage) continue;
  const factors = (await F("GET", `/workshops/${w.id}/factors`))?.data ?? [];
  const here = factors.filter((f) => f.category_key === stage.config.factor_category_key);
  if (!best || here.length > best.n) best = { w, stage, n: here.length };
}
if (!best) {
  console.log("no workshop has a board-layout capture stage");
  process.exit(1);
}
console.log(`using ${best.w.name} / ${best.stage.key} — ${best.n} note(s) in this category`);

const exe = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => fs.existsSync(p));
if (!exe) {
  console.log("no browser installed; nothing to look at");
  process.exit(0);
}

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: exe, headless: true });
const dir = "tests/.shots-selection";
fs.mkdirSync(dir, { recursive: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(UI, { waitUntil: "domcontentloaded" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForSelector('input[type="email"]', { state: "detached", timeout: 40000 });

// ---- the tab icon ----
const icon = await page.evaluate(() => {
  const link = document.querySelector('link[rel="icon"]');
  return link ? link.getAttribute("href") : null;
});
console.log(`tab icon: ${icon}`);
const iconRes = await page.request.get(new URL(icon ?? "/favicon.ico", UI).href);
const iconBody = iconRes.ok() ? await iconRes.text() : "";
console.log(
  `  fetched: ${iconRes.status()} · ${iconRes.headers()["content-type"]} · ` +
    `mentions the scaffold builder in what it draws: ${/lovable/i.test(
      iconBody.replace(/<!--[\s\S]*?-->/g, ""),
    )}`,
);

// ---- the capture board ----
await page.goto(`${UI}/w/${best.w.id}/stage/${best.stage.key}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-note-id]", { timeout: 40000 });
await page.waitForLoadState("networkidle").catch(() => {});

/**
 * Scroll to an element, read its box after the scroll has settled, and CHECK
 * THAT THE POINT REALLY HITS IT.
 *
 * The confirmation is the whole value. `styles.css` sets `scroll-behavior:
 * smooth`, so a box read mid-animation is the wrong box; the app header is
 * fixed and covers the top of the viewport; and a board panel scrolls inside
 * itself. Any of those puts the click somewhere else, and the page then
 * reports exactly what a broken control reports — nothing happened. A probe
 * that cannot tell "could not press it" from "pressing it did nothing" says
 * the second when it means the first, which is what this one did on its first
 * run against a board whose notes were fine.
 */
async function aim(handle, label = "element", within = "[data-note-body]") {
  await handle.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(150);
  // Aim at the note's TEXT, which is what a person presses and what carries
  // the click handler, rather than at the middle of the tile.
  const inner = within === "[data-note-body]" ? await handle.$(within) : null;
  const box = await (inner ?? handle).boundingBox();
  if (!box) {
    console.log(`  ! ${label}: no box — it is not rendered`);
    return null;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hit = await page.evaluate(
    ([px, py, sel]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return { ok: false, what: "(nothing)" };
      if (sel !== "[data-note-body]") {
        const hit = el.closest(sel);
        return {
          ok: Boolean(hit),
          what: el.tagName.toLowerCase(),
          covered: hit ? null : (el.className ?? "").toString().slice(0, 60),
        };
      }
      // THE BODY, NOT JUST "SOMEWHERE ON THE NOTE". A note's footer carries
      // an avatar, a chevron and a score pill, none of which select — so a
      // point that lands there reports a note under the pointer and then
      // does nothing when pressed, which is the exact ambiguity this
      // function exists to remove. The first run of this probe aimed at the
      // note's centre, hit a footer span on a short note, and reported the
      // feature dead while it worked.
      const body = el.closest("[data-note-body]");
      const note = el.closest("[data-note-id]");
      return {
        ok: Boolean(body),
        what: el.tagName.toLowerCase() + (body ? " in the note body" : note ? " in the note chrome" : ""),
        covered: note ? null : (el.className ?? "").toString().slice(0, 60),
      };
    },
    [x, y, within],
  );
  if (!hit.ok) {
    console.log(`  ! ${label}: the point is covered by ${hit.what} ${hit.covered ?? ""}`.trim());
    return null;
  }
  return { x, y, box, hit: hit.what };
}

const allNotes = await page.$$("[data-note-id]:not([data-note-themed='true'])");
// PREFER NOTES THAT ARE ALLOWED TO MOVE. Almost every note on a real board is
// approved, hence frozen by design, and a frozen note shows no ghost because
// it cannot be lifted at all. Selecting two of those and reporting "no ghost"
// would look exactly like the drag being broken — the same trap visual-board
// documents about `cursor: grab`.
const movable = [];
for (const n of allNotes) {
  const grab = await n.evaluate((el) => getComputedStyle(el).cursor === "grab");
  if (grab) movable.push(n);
}
const notes = movable.length >= 2 ? movable : allNotes;
console.log(
  `loose notes on screen: ${allNotes.length} · of those, movable: ${movable.length}` +
    (movable.length < 2 ? " — selecting frozen ones, so no ghost is expected" : ""),
);

if (notes.length >= 2) {
  // Ctrl+click two notes. The MIDDLE of each, where a person clicks — a
  // corner press would pass straight over a control that only works on the
  // rim, which is the defect class this board has had before.
  // HOLD THE KEY AROUND THE CLICKS. `page.mouse.click` takes no `modifiers`
  // option — that belongs to `locator.click` — so passing one is accepted
  // and ignored, and every click arrives plain. The probe then reported the
  // selection dead twice while it worked, which is the third aiming mistake
  // in this file and the reason each one is written down.
  await page.keyboard.down("Control");
  let clicked = 0;
  for (const n of notes) {
    if (clicked >= 2) break;
    const at = await aim(n, `note ${clicked + 1}`);
    if (!at) continue;
    console.log(`  pressing ${at.hit} at ${Math.round(at.x)},${Math.round(at.y)}`);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(150);
    clicked++;
  }
  await page.keyboard.up("Control");
  console.log(`ctrl-clicked ${clicked} note(s)`);

  const state = await page.evaluate(() => {
    const bar = document.querySelector("[data-selection-bar]");
    const ringed = [...document.querySelectorAll("[data-note-id]")].filter((n) =>
      n.className.includes("ring-2"),
    ).length;
    const boxes = document.querySelectorAll("[data-note-id] button[aria-pressed]").length;
    return {
      bar: bar ? bar.innerText.replace(/\s+/g, " ").trim() : null,
      ringed,
      boxes,
      groupButton: [...document.querySelectorAll("button")].some((b) =>
        /group into a/i.test(b.textContent ?? ""),
      ),
    };
  });
  console.log(`selection bar: ${state.bar ?? "(not shown)"}`);
  console.log(
    `  notes ringed: ${state.ringed} · checkboxes drawn: ${state.boxes} · ` +
      `"Group into a…" offered: ${state.groupButton}`,
  );
  await page.screenshot({ path: path.join(dir, "selection.png"), fullPage: true });
  console.log(`  shot: ${path.resolve(dir, "selection.png")}`);

  // ---- the ghost says how many are in hand, then Escape puts them back ----
  const first = await aim(notes[0], "drag source");
  if (first) {
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    await page.mouse.move(first.x + 40, first.y + 40, { steps: 8 });
    await page.waitForTimeout(120);
    const ghost = await page.evaluate(() => {
      // BY ITS OWN ATTRIBUTE. The first version looked for a body child with
      // `style.position === "fixed"`, which is empty here: the ghost is
      // positioned by a Tailwind CLASS, not an inline style. It found
      // nothing and reported a drag that drew nothing.
      const node = document.querySelector("[data-drag-ghost]");
      return {
        found: Boolean(node),
        text: node ? node.innerText.replace(/\s+/g, " ").trim() : "",
      };
    });
    console.log(
      `ghost while dragging the selection: ${ghost.text || "(none)"}` +
        (movable.length < 2 ? " (expected: these notes are frozen)" : ""),
    );
    await page.screenshot({ path: path.join(dir, "dragging.png") });
    console.log(`  shot: ${path.resolve(dir, "dragging.png")}`);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
} else {
  console.log("fewer than two loose notes here — nothing to select");
}

// ---- the matrix's hidden notes ----
const relate = (await F("GET", `/workshops/${best.w.id}`))?.data?.methodology?.stages?.find(
  (s) => s.stage_type === "relate" && s.config?.layout === "axis",
);
if (relate) {
  await page.goto(`${UI}/w/${best.w.id}/stage/${relate.key}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const more = await page.$('button:has-text("more")');
  if (!more) {
    console.log("no theme on an axis has more notes than the card shows — nothing to expand");
  } else {
    const before = await page.evaluate(
      () => document.querySelectorAll("[data-matrix-grid] li").length,
    );
    const at = await aim(more, '"+N more"', "button");
    if (at) await page.mouse.click(at.x, at.y);
    else console.log("  could not press it — so this says nothing about whether it works");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      items: document.querySelectorAll("[data-matrix-grid] li").length,
      closes: [...document.querySelectorAll("button")].some((b) =>
        /show fewer/i.test(b.textContent ?? ""),
      ),
    }));
    console.log(
      `"+N more": ${before} list items before, ${after.items} after · ` +
        `offers "show fewer": ${after.closes}`,
    );
    await page.screenshot({ path: path.join(dir, "theme-expanded.png"), fullPage: true });
    console.log(`  shot: ${path.resolve(dir, "theme-expanded.png")}`);
  }
}

await browser.close();
console.log(errors.length === 0 ? "no console errors" : `CONSOLE ERRORS:\n  ${errors.join("\n  ")}`);
