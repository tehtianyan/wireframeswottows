// The way IN, and what each screen leads with.
//
// Four things reported from UAT, all of them about navigation and attention
// rather than about data:
//
//   - "Rename Workshops to My Workshops in the menu."
//   - "Instead of displaying all the workshops in its own screen, create a
//      dropdown of links to the active workshops in the menu bar."
//   - "Hide the Recent activity and Participants panels into links so that
//      they don't occupy screen space."
//   - "The facilitator clicks into an active Workshop, then sees the panel
//      with the Workshop name, the stages, and the SWOT grid. The SWOT grid
//      should be top of mind."
//
// Every one of those is invisible to an API test: the endpoints behind them
// were right throughout, and the complaint was where the result was PUT. That
// is the same gap brand-display.js exists for — a Display Name that saved
// correctly, round-tripped correctly, and never appeared in the header.
//
// So this reads the SOURCE. These components import React and Vite-only
// modules and cannot be loaded into node; re-implementing their logic here
// would test the copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../lib/harness.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/** Source with comments removed, so prose explaining a rule cannot satisfy an
 *  assertion that the rule is implemented. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

runSuite("shell-ui", async ({ results: r }) => {
  const appShell = codeOnly(read("src", "components", "AppShell.tsx"));
  const overview = codeOnly(read("src", "routes", "w.$workshopId.overview.tsx"));
  const listScreen = codeOnly(read("src", "routes", "w.index.tsx"));

  // ================================================================
  r.section("The menu says My Workshops, and carries them");
  // ================================================================

  const navItems = /const navItems = \[([\s\S]*?)\];/.exec(appShell)?.[1] ?? "";
  r.ok(navItems.length > 0, "the nav registry can be identified");

  r.ok(
    /label: "My Workshops"/.test(navItems),
    'the entry is labelled "My Workshops"',
  );
  r.ok(
    !/label: "Workshops"/.test(navItems),
    "...and the bare plural is gone, not merely joined by the new one",
  );

  // THE LABEL IS ALSO THE ACTIVE-STATE KEY. `activeLabel` is compared against
  // these labels by string, so renaming one and not the other leaves the
  // highlight stuck on Dashboard for every workshop screen — a rename that
  // silently breaks the thing that tells you where you are.
  r.ok(
    /const WORKSHOPS_LABEL = "My Workshops"/.test(appShell),
    "the label is stated once",
  );
  r.ok(
    /\? WORKSHOPS_LABEL/.test(appShell) &&
      /item\.label === WORKSHOPS_LABEL/.test(appShell),
    "...and the active-state test and the menu both read that one statement, rather than repeating the string",
  );

  // ---- the two shapes ----
  //
  // THE SIDEBAR DISCLOSES IN PLACE; EVERYTHING ELSE USES THE POPOVER. The
  // first version opened a popover beside the sidebar for every surface, and
  // UAT read that as the list arriving "at the right" — detached from the
  // word that produced it and covering the page. The sidebar now expands the
  // list underneath the entry and pushes the entries below it down.
  //
  // Both shapes are asserted because each is right in exactly one place: a
  // 56px collapsed rail and a phone's bottom bar have no column to disclose
  // INTO, so a disclosure there would have nowhere to put a workshop's name.
  r.ok(
    /function WorkshopsDisclosure\(/.test(appShell),
    "the sidebar's workshops entry is a disclosure, not a popover",
  );
  r.ok(
    /function WorkshopsMenu\(/.test(appShell),
    "...and the popover survives for the surfaces that have no column to disclose into",
  );
  r.ok(
    /<DropdownMenuTrigger asChild>\{children\}<\/DropdownMenuTrigger>/.test(appShell),
    "...built on the same accessible primitive as the rest of the header, not a hand-rolled popup",
  );

  // The disclosure must be INLINE, which is the whole of the reported
  // complaint. A DropdownMenuContent renders through a portal and floats over
  // the page, so finding one inside this component would mean the list was
  // still detached from the column however it was labelled.
  const disclosure = appShell.slice(appShell.indexOf("function WorkshopsDisclosure("));
  r.ok(
    disclosure.length > 0 && !/DropdownMenuContent/.test(disclosure),
    "...it renders no floating layer, so the list sits in the column and pushes the entries below it down",
  );
  r.ok(
    /aria-expanded=\{open\}/.test(disclosure) && /aria-controls=/.test(disclosure),
    "...and the trigger states its expanded state, since a disclosure is only usable if it says it is one",
  );

  // BOTH NAVIGATIONS, OR IT IS UNREACHABLE ON A PHONE. The sidebar is hidden
  // below md and the bottom bar takes over; a menu wired into only one of them
  // leaves the other as a plain link to the screen this was meant to replace.
  // Bounded by the <main> between them and by the second <nav>. An earlier
  // version sliced to `indexOf("setCollapsed")`, which matches the useState at
  // the top of the file — so the slice was EMPTY and the check failed for a
  // reason that had nothing to do with the sidebar.
  const sidebar = appShell.slice(appShell.indexOf("<nav"), appShell.indexOf("<main"));
  const mobile = appShell.slice(appShell.lastIndexOf("<nav"));
  r.ok(sidebar.includes("navItems.map") && mobile.includes("navItems.map"),
    "both navigations can be isolated", `${sidebar.length} / ${mobile.length} chars`);
  r.ok(
    /<WorkshopsDisclosure/.test(sidebar),
    "the expanded desktop sidebar discloses the list in place",
  );
  r.ok(
    /collapsed\)/.test(sidebar) && /<WorkshopsMenu/.test(sidebar),
    "...and the collapsed rail falls back to the popover, having no room for a workshop's name",
  );
  r.ok(
    /<WorkshopsMenu/.test(mobile),
    "...and the phone's bottom bar keeps it too, having no sidebar to disclose into",
  );
  r.ok(
    !/<WorkshopsDisclosure/.test(mobile),
    "...and does NOT disclose, which in a bottom bar would expand downwards off the screen",
  );

  // The column scrolls, or the disclosure breaks the thing underneath it. The
  // Collapse button is pinned with `mt-auto`; a long expanded list in a
  // fixed-height column would push it past the bottom edge, where nothing can
  // reach it — the list floated before, so this cost nothing before.
  r.ok(
    /overflow-y-auto/.test(sidebar),
    "the sidebar scrolls, so an expanded list cannot push the Collapse control out of reach",
  );

  // ONE statement of which workshops, now that two components render them.
  // This is the rule most likely to rot: a second filter written beside the
  // first looks right and drifts the day a lifecycle state is added.
  r.ok(
    /function useMyWorkshops\(/.test(appShell),
    "both shapes read one shared source for the list",
  );
  r.ok(
    (appShell.match(/useMyWorkshops\(/g) ?? []).length >= 3,
    "...declared once and called by each of them, rather than each filtering for itself",
    `${(appShell.match(/useMyWorkshops\(/g) ?? []).length} references`,
  );
  r.ok(
    (appShell.match(/inPlay\(/g) ?? []).length === 2,
    "...and inPlay is applied in exactly one place, beside its own definition",
    `${(appShell.match(/inPlay\(/g) ?? []).length} references (definition + 1 use)`,
  );

  // ---- which workshops ----
  //
  // Phrased as what it EXCLUDES. `status === "active"` would have been the
  // obvious reading of "active workshops" and would hide a workshop that had
  // reached Analysis — further along, not less current — and anything still in
  // Draft, which is exactly where a facilitator left off.
  r.ok(
    /const FINISHED = new Set\(\["completed", "archived"\]\)/.test(appShell),
    "the menu lists everything except the two finished states",
  );
  r.ok(
    /!FINISHED\.has\(w\.status\)/.test(appShell),
    "...by exclusion, so a lifecycle state added later appears rather than silently vanishing",
  );
  r.ok(
    /created_at\.localeCompare/.test(appShell),
    "...most recent first",
  );

  // The screen is not deleted: it carries each workshop's status and objective,
  // the finished ones, and the New button. Taking the list out of the menu's
  // reach would be replacing one dead end with another.
  r.ok(
    /to="\/w"/.test(appShell) && /to="\/w\/new"/.test(appShell),
    "the full list and the creation wizard are both still reachable from the menu",
  );
  r.ok(
    /My Workshops/.test(listScreen),
    "...and the screen's own heading matches the menu, so they are recognisably the same thing",
  );

  // ================================================================
  r.section("The roster and the audit trail are links, not panels");
  // ================================================================

  // DrawerLink was local to the overview until 2026-11-06, when the dashboard's
  // own "Recent activity" panel needed the same treatment and it moved to
  // src/components/DrawerLink.tsx. The property under test is unchanged — these
  // are drawers rather than page panels — so it is asserted where it now lives
  // rather than relaxed. Two copies of this component would have drifted the
  // way the two presence channels did.
  const drawer = codeOnly(read("src", "components", "DrawerLink.tsx"));

  r.ok(
    /from "@\/components\/DrawerLink"/.test(overview) && /<DrawerLink/.test(overview),
    "the overview has a link-that-opens-a-drawer",
  );
  r.ok(
    /<SheetTrigger asChild>/.test(drawer) && /<SheetContent/.test(drawer),
    "...implemented as a real drawer, so it occupies no page space until opened",
  );

  // THE POINT IS THAT THEY ARE NO LONGER SECTIONS. Both used to be full-width
  // `console-panel` blocks between the header and the stages. A disclosure
  // would still have cost a row each; a drawer costs a chip.
  const participantsUse = overview.indexOf("<ParticipantsPanel");
  r.ok(participantsUse !== -1, "the roster is still rendered — moved, not removed");
  r.ok(
    /label="Participants"/.test(overview) && /label="Recent activity"/.test(overview),
    "both are behind labelled links",
  );
  r.ok(
    /<DrawerLink[\s\S]{0,400}<ParticipantsPanel/.test(overview),
    "...and the roster is INSIDE one of them rather than beside it",
  );
  r.ok(
    !/title="Recent activity"\s*hint=/.test(overview) &&
      !/PanelHeading[^/]*title="Recent activity"/.test(overview),
    "the activity feed is no longer a panel heading on the page",
  );

  // The count is on the link, so the glance the panel was there for — how many
  // people, has anything happened — is answered without opening anything.
  r.ok(
    /count=\{summaryQuery\.data\?\.participants\}/.test(overview),
    "the participant count is on the link itself",
  );
  r.ok(
    /count=\{summaryQuery\.data\?\.recent_activity\.length\}/.test(overview),
    "...and so is the number of recent events",
  );

  // Invite rights still come from the caller's real role, not from the fact
  // that the panel moved into a drawer.
  r.ok(
    /canManage=\{workshop\.my_role === "facilitator"\}/.test(overview),
    "the roster's manage rights are still the caller's real workshop role",
  );
  r.ok(
    /readOnly=\{workshop\.status === "archived"\}/.test(overview),
    "...and an archived workshop is still read-only here",
  );

  // ================================================================
  r.section("The stages are what the workshop screen leads with");
  // ================================================================

  // ORDER IS THE WHOLE ASSERTION. Every one of these panels was correct and
  // live; the complaint was that the way into the work sat below four blocks
  // of reference material.
  const stagesAt = overview.indexOf('title="Stages"');
  const summaryAt = overview.indexOf("<SummaryPanels");
  const aiAt = overview.indexOf("<AiInlineActions");

  r.ok(stagesAt !== -1 && summaryAt !== -1 && aiAt !== -1,
    "the three blocks of the overview can be located", `${stagesAt} ${summaryAt} ${aiAt}`);
  r.ok(
    stagesAt < summaryAt,
    "the stages come before the metrics and the health score",
    `stages at ${stagesAt}, summary at ${summaryAt}`,
  );
  r.ok(
    stagesAt < aiAt,
    "...and before the workshop-level AI action",
    `stages at ${stagesAt}, AI at ${aiAt}`,
  );

  // ================================================================
  r.section("Clicking a workshop lands in stage 1, drafts included");
  // ================================================================

  // UAT, the day after the redirect shipped: "My Workshops → workshop still
  // brings the user to the Overview page. It should have brought the user
  // straight to Stage 1."
  //
  // The redirect was there and worked; `firstStageFor` sent every DRAFT
  // workshop to the overview instead, reading `draft` as "still being set up".
  // §8.7's lifecycle is draft → configured → active, two manual advances that
  // nothing in capture, theming, rating or review requires — so production had
  // five of its seven workshops in `draft`, one of them with seven members and
  // a wall of real notes, and the rule meant for the exception fired on the
  // normal case.
  //
  // This is phrased about the STATUS LIST rather than by re-implementing the
  // function, because the bug was a status being in it.
  const stages = codeOnly(read("src", "lib", "stages.ts"));
  // `\n}` alone matched the END OF THE PARAMETER OBJECT — `}): MethodologyStage`
  // — so the first version of this captured the signature and nothing else, and
  // the "no draft" check below passed because the body was not in the string.
  // The archived check is what caught it. Read the reason, not the PASS.
  const firstStage = /export function firstStageFor[\s\S]*?\n\}\n/.exec(stages)?.[0] ?? "";
  r.ok(
    /status === "archived"/.test(firstStage),
    "firstStageFor's BODY can be located, not just its signature",
    `${firstStage.length} chars`,
  );
  r.ok(
    !/"draft"/.test(firstStage),
    "a draft workshop lands in stage 1 like any other: draft is a lifecycle label, not an unready screen",
  );
  r.ok(
    /"archived"/.test(firstStage),
    "...and an archived one still goes to the overview, which is the page that says why writes are refused",
  );
  // The entry point must stay a COMPONENT. As a route loader it ran on the
  // server for a hard navigation, where this app's client-side session does not
  // exist, so a pasted or bookmarked /w/{id} 401'd and showed "This page didn't
  // load". Every suite passed through that; only a real browser caught it.
  const entry = codeOnly(read("src", "routes", "w.$workshopId.index.tsx"));
  r.ok(
    /component: WorkshopEntry/.test(entry) && !/loader:/.test(entry),
    "the entry route resolves the redirect in a component, never in a loader — auth here is client-side",
  );

  // ================================================================
  r.section("Every stage tile is the same size");
  // ================================================================

  // UAT: "the Stages in the overview page should have a more consistent size."
  // A wrapping FLEX row of `flex-1` tiles cannot be consistent: a flex line
  // shares out its OWN free space, so ten stages over two rows came out six
  // narrow above four wide. A grid's tracks are shared by every row.
  const stageList = codeOnly(read("src", "components", "methodology", "StageList.tsx"));
  r.ok(
    /gridTemplateColumns: "repeat\(auto-fill, minmax\([\d.]+rem, 1fr\)\)"/.test(stageList),
    "the tiles are grid tracks, so one declaration sizes every row the same",
  );
  // Asked of the TILE's own class, not of the file: the link inside a tile is
  // legitimately `flex-1` (it fills the tile), and a blanket search for that
  // utility would fail on a correct implementation — which is how a check ends
  // up loosened until it asserts nothing.
  const tileClass = /"group flex[^"]*"/.exec(stageList)?.[0] ?? "";
  r.ok(tileClass.length > 0, "the tile's own class list can be located", tileClass);
  r.ok(
    !/flex-wrap/.test(stageList) && !/flex-1/.test(tileClass) && !/max-w-/.test(tileClass),
    "...and no tile sizes itself, which is what made one row's tiles differ from the next's",
  );
  r.ok(
    /auto-rows-fr/.test(stageList),
    "the rows are equal height too, so a two-line stage name does not make a short tile",
  );
  r.ok(
    /line-clamp-2[^"]*text-xs font-medium/.test(stageList),
    "...which takes a clamp on the name, or the longest name in the methodology sets the height of all ten",
  );

  // ================================================================
  r.section("Type is part of a skin, and the picker shows it");
  // ================================================================

  const picker = codeOnly(read("src", "components", "SkinPicker.tsx"));
  const root = codeOnly(read("src", "routes", "__root.tsx"));

  r.ok(
    /fontFamily: s\.displayFamily/.test(picker),
    "each row in the picker is set in that skin's own display face",
  );
  // Using the `font-display` utility here would have been the obvious thing
  // and would have set all five rows in the face of the skin currently
  // applied — a preview that previews nothing, and one that looks right.
  r.ok(
    !/font-display/.test(picker),
    "...declared from the registry, not via the utility, which resolves to the ACTIVE skin's face",
  );
  r.ok(
    /s\.typeNote/.test(picker),
    "...and the pairing is named in words as well",
  );

  // Every skin's faces have to be loaded before one is chosen, or picking a
  // skin silently falls back to a system face.
  for (const family of [
    "Source+Serif+4",
    "Source+Sans+3",
    "Libre+Baskerville",
    "Libre+Franklin",
    "Zilla+Slab",
    "Work+Sans",
    "Archivo",
    "IBM+Plex+Sans",
    "Spectral",
    "Karla",
  ]) {
    r.ok(root.includes(family), `${family.replace(/\+/g, " ")} is loaded`);
  }
  r.ok(
    !/Space\+Grotesk/.test(root) && !/DM\+Sans/.test(root),
    "and the faces nothing uses any more are not still being fetched",
  );

  // ================================================================
  r.section("The tab icon is this product's (UAT 2026-11-10)");
  // ================================================================
  //
  // `public/favicon.ico` shipped with the scaffold and was still the
  // BUILDER'S logo, so every tab, bookmark and history entry for this
  // product — on the client-facing deployment too — carried another
  // company's mark. Nothing caught it because nothing had ever been asked
  // to look at the thing in the tab.
  r.ok(
    !fs.existsSync(path.join(ROOT, "public", "favicon.ico")),
    "the scaffold's favicon.ico is gone, not merely unreferenced",
  );
  r.ok(
    fs.existsSync(path.join(ROOT, "public", "favicon.svg")),
    "...and this product ships one of its own",
  );
  r.ok(
    /href: "\/favicon\.svg"/.test(root) && !/favicon\.ico"/.test(root),
    "...which is what the document head points at",
  );
  const favicon = read("public", "favicon.svg");
  // THE MARKUP, NOT THE COMMENT. The file explains at length which logo it
  // replaced and why, so its raw text names the scaffold builder on purpose —
  // the same reason TowsMatrix.tsx is read with its comments stripped. What
  // must not carry that name is the thing that renders.
  const drawn = favicon.replace(/<!--[\s\S]*?-->/g, "");
  r.ok(
    !/lovable/i.test(drawn),
    "nothing the icon DRAWS comes from the scaffold builder",
  );
  // A tab strip follows the OS theme, so a single fill works on one ground
  // and disappears on the other.
  r.ok(
    /prefers-color-scheme: dark/.test(favicon),
    "...and it is drawn for both a light and a dark tab strip",
  );
  // The whole repo, not just the head: a stray reference would 404 silently
  // and the browser would fall back to no icon with nobody the wiser.
  for (const file of ["src/routes/__root.tsx", "index.html", "vite.config.ts"]) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const body = codeOnly(fs.readFileSync(full, "utf8"));
    r.ok(!/favicon\.ico/.test(body), `${file} no longer asks for favicon.ico`);
  }
});
