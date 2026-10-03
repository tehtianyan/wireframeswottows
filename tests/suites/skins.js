// The skins, and the promise that dark mode keeps working in each of them.
//
// A pure check over styles.css and src/lib/skins.ts — no server, no database.
// It lives here so `npm test` runs it, because the failure it guards against is
// invisible by inspection: a skin block that omits ONE token silently inherits
// that token from another palette. Miss `--muted-foreground` in a warm light
// skin and you get a cool grey on a cream ground, which looks like a rendering
// bug rather than a missing line of CSS.
//
// It also enforces the property the feature was asked for: every skin must
// define BOTH modes, so the day/night toggle keeps working whichever skin is
// picked.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
const SKINS_TS = fs.readFileSync(path.join(ROOT, "src", "lib", "skins.ts"), "utf8");

/** Custom properties declared inside one `selector { ... }` block. */
function tokensIn(selector) {
  const i = CSS.indexOf(selector + " {");
  if (i === -1) return null;
  const body = CSS.slice(i + selector.length + 2, CSS.indexOf("}", i));
  return new Set([...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]));
}

/** The L of the first oklch() for a token in a block, or null. */
function lightnessOf(selector, token) {
  const i = CSS.indexOf(selector + " {");
  if (i === -1) return null;
  const body = CSS.slice(i, CSS.indexOf("}", i));
  const m = body.match(new RegExp(`${token}\\s*:\\s*oklch\\(\\s*([0-9.]+)`));
  return m ? Number(m[1]) : null;
}

runSuite("skins", async ({ results: r }) => {
  // The keys the picker offers, read from the registry rather than restated,
  // so adding a skin to the registry without styling it fails here.
  const keys = [...SKINS_TS.matchAll(/^\s*key:\s*"([a-z]+)"/gim)].map((m) => m[1]);

  r.section("the registry and the stylesheet agree");
  r.ok(keys.length === 5, "five skins are offered", keys.join(", "));
  r.ok(keys[0] === "console",
    "the default is first, and is the palette the app already had", keys[0]);

  // `console` is intentionally unstyled: it IS :root / .light. Everything else
  // must have both blocks.
  const styled = keys.filter((k) => k !== "console");
  for (const k of styled) {
    for (const mode of ["dark", "light"]) {
      r.ok(tokensIn(`html[data-skin="${k}"].${mode}`) !== null,
        `${k} defines its ${mode} palette — without it the toggle would fall back to another skin`,
      );
    }
  }
  r.ok(tokensIn('html[data-skin="console"].dark') === null,
    "console has NO block, so the default cannot drift out of step with :root",
  );

  // ---- the real check: every styled block declares the same tokens ----
  r.section("no skin is missing a token");

  const reference = tokensIn('html[data-skin="boardroom"].dark');
  r.ok(reference !== null && reference.size > 20,
    "the reference block declares a full palette", reference?.size);

  for (const k of styled) {
    for (const mode of ["dark", "light"]) {
      const got = tokensIn(`html[data-skin="${k}"].${mode}`);
      if (!got) continue;
      const missing = [...reference].filter((t) => !got.has(t));
      const extra = [...got].filter((t) => !reference.has(t));
      r.ok(missing.length === 0,
        `${k}.${mode} declares every token the others do`,
        missing.length ? `MISSING ${missing.join(", ")}` : "complete",
      );
      r.ok(extra.length === 0,
        `${k}.${mode} declares nothing the others lack`,
        extra.length ? `EXTRA ${extra.join(", ")}` : "consistent",
      );
    }
  }

  // ---- contrast, as far as a stylesheet can be checked ----
  //
  // oklch's L is perceptual lightness, so the gap between foreground and
  // background is a fair proxy for legibility. These are deliberately loose
  // bounds: they catch a palette pasted into the wrong mode, which is the
  // mistake that actually happens, not a subtle contrast-ratio shortfall.
  r.section("each skin is readable in both modes");

  for (const k of styled) {
    const dBg = lightnessOf(`html[data-skin="${k}"].dark`, "--background");
    const dFg = lightnessOf(`html[data-skin="${k}"].dark`, "--foreground");
    const lBg = lightnessOf(`html[data-skin="${k}"].light`, "--background");
    const lFg = lightnessOf(`html[data-skin="${k}"].light`, "--foreground");

    r.ok(dBg !== null && dBg < 0.3, `${k} dark has a dark ground`, dBg);
    r.ok(lBg !== null && lBg > 0.9, `${k} light has a light ground`, lBg);
    r.ok(dFg - dBg > 0.6, `${k} dark text stands off its ground`, (dFg - dBg).toFixed(2));
    r.ok(lBg - lFg > 0.6, `${k} light text stands off its ground`, (lBg - lFg).toFixed(2));

    // The muted foreground is the one most easily left too faint, and it is
    // what every secondary line of copy uses.
    const dMuted = lightnessOf(`html[data-skin="${k}"].dark`, "--muted-foreground");
    const lMuted = lightnessOf(`html[data-skin="${k}"].light`, "--muted-foreground");
    r.ok(dMuted - dBg > 0.4, `${k} dark muted text is still legible`, (dMuted - dBg).toFixed(2));
    r.ok(lBg - lMuted > 0.4, `${k} light muted text is still legible`, (lBg - lMuted).toFixed(2));
  }

  // ---- semantics must not be re-skinned ----
  r.section("meaning does not change with branding");

  for (const k of styled) {
    for (const mode of ["dark", "light"]) {
      const got = tokensIn(`html[data-skin="${k}"].${mode}`);
      if (!got) continue;
      const semantic = ["--success", "--destructive", "--warning", "--strength", "--threat"];
      const overridden = semantic.filter((t) => got.has(t));
      r.ok(overridden.length === 0,
        `${k}.${mode} leaves the semantic and SWOT colours alone — green meaning approved should not change because somebody picked a warmer palette`,
        overridden.length ? `OVERRIDES ${overridden.join(", ")}` : "inherited",
      );
    }
  }

  // ---- the mode-level chrome ----
  r.section("chrome follows the mode, not the skin");

  r.ok(CSS.includes(".dark .grid-backdrop") && CSS.includes(".light .grid-backdrop"),
    "the grid texture is defined for both modes, so a light skin never gets white lines on white",
  );
  r.ok(/\.light\s*\{[^}]*--shadow-console/.test(CSS),
    "and the panel shadow is re-weighted for daylight rather than reused from the night build",
  );
});
