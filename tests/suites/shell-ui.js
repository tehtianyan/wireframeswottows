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
  const overview = codeOnly(read("src", "routes", "w.$workshopId.index.tsx"));
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

  // ---- the dropdown ----
  r.ok(
    /function WorkshopsMenu\(/.test(appShell),
    "the workshops entry opens a menu",
  );
  r.ok(
    /<DropdownMenuTrigger asChild>\{children\}<\/DropdownMenuTrigger>/.test(appShell),
    "...built on the same accessible primitive as the rest of the header, not a hand-rolled popup",
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
    /<WorkshopsMenu/.test(sidebar),
    "the desktop sidebar uses it",
  );
  r.ok(
    /<WorkshopsMenu/.test(mobile),
    "...and so does the phone's bottom bar",
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

  r.ok(
    /function DrawerLink\(/.test(overview),
    "the overview has a link-that-opens-a-drawer",
  );
  r.ok(
    /<SheetTrigger asChild>/.test(overview) && /<SheetContent/.test(overview),
    "...implemented as a real drawer, so it occupies no page space until opened",
  );

  // THE POINT IS THAT THEY ARE NO LONGER SECTIONS. Both used to be full-width
  // `console-panel` blocks between the header and the stages. A disclosure
  // would still have cost a row each; a drawer costs a chip.
  const participantsUse = overview.indexOf("<ParticipantsPanel");
  const drawerStart = overview.indexOf("function DrawerLink(");
  r.ok(participantsUse !== -1, "the roster is still rendered — moved, not removed");
  r.ok(
    /label="Participants"/.test(overview) && /label="Recent activity"/.test(overview),
    "both are behind labelled links",
  );
  r.ok(
    participantsUse < drawerStart && /<DrawerLink[\s\S]{0,400}<ParticipantsPanel/.test(overview),
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
});
