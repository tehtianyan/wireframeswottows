// Does the brand actually get DISPLAYED?
//
// THE BUG THIS EXISTS FOR, reported from UAT: an administrator set a Display
// Name in /admin -> Branding, it saved correctly, every API response carried
// it, the exported report carried it — and the header showed nothing. The
// header gated the wordmark on `!brand.logoUrl`, so uploading a logo made the
// Display Name field silently do nothing.
//
// Everything that existed passed. `branding.js` asserted the value is STORED
// and returned; `reports_brand_test.go` asserted the report cover. Nothing
// asserted the header RENDERS it, so the defect sat precisely in the gap
// between "saved correctly" and "visible" — which is the only gap a person
// filling in a form can actually see.
//
// It reads the SOURCE, like invite-landing.js, because the alternative is
// importing brand.ts into node and brand.ts reads `import.meta.env`, which
// only exists under Vite. A re-implementation of the rule in this file would
// be testing the copy rather than the code.
//
// THE RULE (Brand.showWordmark):
//
//   logo + a display name you typed  -> logo AND the name
//   logo + no display name           -> logo alone
//   no logo + a display name         -> initials AND the name
//   no logo + no display name        -> initials AND the organization name
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const BRAND = read("src", "lib", "brand.ts");
const SHELL = read("src", "components", "AppShell.tsx");
const PANEL = read("src", "components", "BrandingPanel.tsx");

/** Source with // and /* *\/ comments removed, so an assertion cannot be
 *  satisfied by prose explaining the very thing it is checking for. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

runSuite("brand-display", async ({ results: r }) => {
  const brand = codeOnly(BRAND);
  const shell = codeOnly(SHELL);
  const panel = codeOnly(PANEL);

  r.section("the rule exists and is derived from what was TYPED");

  r.ok(/showWordmark\s*:\s*boolean/.test(brand), "Brand declares showWordmark");

  // The whole point: it must depend on the display name being non-empty, not
  // only on whether a logo exists.
  r.ok(
    /showWordmark\s*:\s*!logo\s*\|\|\s*typed\s*!==\s*""/.test(brand),
    "resolveBrand computes showWordmark from the TYPED display name, not from the logo alone",
    (brand.match(/showWordmark:.*/g) ?? []).join(" | "),
  );
  r.ok(
    /const typed = org\.display_name\.trim\(\)/.test(brand),
    "and `typed` is the raw display_name, so a fallback to the organization name is distinguishable",
  );

  r.section("the header honours it");

  // The regression itself. If this ever reverts, the Display Name field goes
  // back to doing nothing whenever a logo is set.
  const wordmarkGates = shell
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /brand\.(showWordmark|logoUrl)\s*&&/.test(line));

  r.ok(
    wordmarkGates.length > 0,
    "the header gates its wordmark on something",
    wordmarkGates.map(([n]) => n).join(","),
  );
  const badGate = wordmarkGates.filter(([, line]) => /!brand\.logoUrl\s*&&/.test(line));
  r.ok(
    badGate.length === 0,
    "the header does NOT hide the wordmark merely because a logo exists — THE REPORTED BUG",
    badGate.map(([n, l]) => `line ${n}: ${l.trim()}`).join(" ; ") || "no such gate",
  );
  r.ok(
    /brand\.showWordmark\s*&&/.test(shell),
    "the header gates on brand.showWordmark",
  );

  r.section("the browser tab follows the brand too");

  // Second half of the same complaint: head() in __root can only know the
  // build brand, so without this the tab keeps the old product name.
  r.ok(
    /document\.title\s*=\s*brand\.name/.test(shell),
    "the document title is set from the resolved brand, not left at the build default",
  );

  r.section("the admin preview cannot drift from the header");

  // It drifted once already: both hid the name when a logo was set, so the
  // preview reproduced the bug and gave no warning.
  r.ok(
    /showWordmark\s*&&/.test(panel),
    "the preview uses showWordmark, the same rule the header uses",
  );
  r.ok(
    !/\{!logoUrl\s*&&/.test(panel),
    "the preview does not gate the name on the logo either",
  );
  r.ok(
    /function PreviewHeader\(\{\s*mode,\s*brand\s*\}/.test(panel),
    "the preview takes the whole resolved Brand, so it cannot be fed a different rule",
  );
  r.ok(
    /resolveBrand\(/.test(panel),
    "and the preview renders through resolveBrand — the same function as the live header",
  );

  r.section("the admin is told the rule");

  r.ok(
    /clear the display name/i.test(PANEL),
    "the panel says how to show a wordmark logo on its own, since that is the non-obvious case",
  );
});
