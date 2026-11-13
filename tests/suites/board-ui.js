// Does the capture board actually LOOK the way it was asked to?
//
// Five of the ten things reported from UAT were purely visual, and not one of
// them could have been caught by an API test: the board returned correct data
// throughout. The defects were that the notes were the wrong shape, that the
// panels pushed each other off screen, that new notes landed at the top, that
// a drag gave no feedback, and that the group's figure was nowhere on the
// wall. Every one of those sits in the gap between "the data is right" and
// "the screen is right" — which is the only gap the person in front of the
// board can see, and the gap the branding display bug taught this project to
// test for explicitly.
//
// It reads the SOURCE, like brand-display.js and invite-landing.js, because
// these components import React and Vite-only modules and so cannot be loaded
// into node. Re-implementing their logic here would test the copy.
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

runSuite("board-ui", async ({ results: r }) => {
  const board = codeOnly(read("src", "components", "methodology", "CaptureBoard.tsx"));
  const note = codeOnly(read("src", "components", "methodology", "StickyNote.tsx"));
  const drag = codeOnly(read("src", "lib", "useBoardDrag.ts"));
  const limits = codeOnly(read("src", "lib", "limits.ts"));

  // ================================================================
  r.section("A note is a small square");
  // ================================================================

  // TWO WRONG VERSIONS IN ONE DAY, AND THIS SECTION IS THE RECORD OF BOTH.
  //   1. `aspect-square` with one note per row at the panel's full width:
  //      right shape, absurd size — a three-letter note became a ~300px box.
  //   2. Dropping the ratio so the box fitted its content: right size, no
  //      shape — notes became wide rectangles.
  // The size was never the ratio's fault, it was the LAYOUT's. So both halves
  // are asserted together here, and the geometry itself is measured in a real
  // browser by visual-board.js — these are the source-level rules that make
  // that geometry possible, not a substitute for measuring it.
  const noteRoot = /"group relative flex[^"]*"/.exec(note)?.[0] ?? "";
  r.ok(noteRoot.length > 0, "the note's own class list can be identified", noteRoot);

  r.ok(/aspect-square/.test(note), "a note is square");
  r.ok(
    // `min-height: auto` is the default for a flex item, so without this a
    // long note pushes the box past the ratio and the tile stops being
    // square. This is wrong version 1, and it is invisible in the class list
    // unless you know to look for it.
    /aspect-square min-h-0 overflow-hidden/.test(note),
    "...and the square is HARD: min-h-0 defeats the flex item's content-based minimum",
  );
  r.ok(
    // The note must not state a width. The grid does — which is what keeps
    // the square SMALL, and is the half that wrong version 1 got wrong.
    !/\bw-\d/.test(noteRoot) && !/\bw-\[/.test(noteRoot),
    "...and the note sets no width of its own — the panel's grid sizes it",
    noteRoot,
  );
  r.ok(
    /expanded \? "h-auto"/.test(note),
    "...except when expanded, where it grows so the full text has somewhere to go",
  );

  // The layout half, in CaptureBoard: a grid of small tiles rather than one
  // note per row. This is the line whose absence made the squares enormous.
  r.ok(
    /gridTemplateColumns: NOTE_TRACK/.test(board) && /auto-fill/.test(board),
    "the panel lays notes out as a GRID of tiles, several to a row",
    /const NOTE_TRACK = "[^"]*"/.exec(board)?.[0],
  );
  // Scoped to NOTE_TRACK's own definition. A blanket search for `1fr` hits
  // the PANEL grid (`repeat(n, minmax(0, 1fr))`), which is fluid on purpose —
  // four panels should share the width. Checking the wrong string would have
  // failed for a reason other than the one it names.
  const track = /const NOTE_TRACK = "([^"]*)"/.exec(board)?.[1] ?? "";
  r.ok(
    track.length > 0 && !/1fr/.test(track),
    "...at a FIXED track size, so a note in a theme is not bigger than one beside it",
    track,
  );
  // Stated once. It was two values, and a note changed size on joining a
  // theme — which reads as a different kind of object.
  r.ok(
    (board.match(/gridTemplateColumns: NOTE_TRACK/g) ?? []).length >= 2,
    "...and the panel and the theme use the SAME constant for it",
  );

  // ================================================================
  r.section("A long note truncates with an ellipsis and expands");
  // ================================================================

  r.ok(
    /WebkitLineClamp/.test(note),
    "a long note is clamped, which is what produces the browser's own ellipsis",
  );
  r.ok(
    /WebkitBoxOrient/.test(note) && /display:\s*"-webkit-box"/.test(note),
    "...with the two properties the clamp needs to take effect at all",
  );
  // THE CLAMP IS MEASURED, NOT A CONSTANT. The panels are wider in grid view
  // than in column view, so one hardcoded line count would be square in one
  // view and wrong in the other. A literal `line-clamp-6` on the note root is
  // the easy mistake, and it is the one this asserts against.
  // THE CLAMP MUST USE THE COMPUTED VALUE, and this is asserted on the
  // property itself rather than on the presence of the measuring code. A
  // first version of this check looked only for `getComputedStyle` and
  // `lineHeight` somewhere in the file, and PASSED with the clamp hardcoded
  // to 6 — the hook was still there, simply ignored. The measurement existing
  // is not the same as the clamp using it.
  r.ok(
    /WebkitLineClamp:\s*clampLines/.test(note),
    "...and the clamp applies the COMPUTED line count, not a literal",
    /WebkitLineClamp:[^,]*/.exec(note)?.[0],
  );
  r.ok(
    /getComputedStyle/.test(note) && /lineHeight/.test(note),
    "...which is derived from the REAL line height, not a hardcoded figure",
  );
  r.ok(
    /ResizeObserver/.test(note),
    "...recomputed when the column changes width, so the ceiling holds in both views",
  );
  // The loop guard. Applying a clamp changes the note's HEIGHT; an observer
  // reacting to height would set a clamp, observe the height it caused, and
  // set it again.
  r.ok(
    /contentRect\.width/.test(note) && /lastWidth/.test(note),
    "...and only WIDTH changes trigger it, so the clamp cannot feed itself",
  );
  r.ok(
    /setExpanded/.test(note) && /Show more/.test(note),
    "a truncated note can be expanded in place",
  );
  // The ellipsis and the control must agree. A threshold in characters cannot
  // decide whether text overflowed — that depends on the width, the font and
  // the line height — so it would show "more" on complete notes and hide it on
  // cut-off ones.
  r.ok(
    /scrollHeight\s*-\s*\w+\.clientHeight/.test(note),
    "...and 'Show more' appears only when the BOX is actually overflowing, not past a character count",
  );
  r.ok(
    !/SQUARE_NOTE_CHARS/.test(limits) && /MIN_NOTE_LINES/.test(limits),
    "the clamp's floor is named in limits.ts and the old character threshold is gone",
  );
  r.ok(
    /MIN_NOTE_LINES/.test(note),
    "...and the note actually READS it — the previous constant was imported by nothing",
  );

  // ================================================================
  r.section("A note may hold a long thought");
  // ================================================================

  const cap = Number(/MAX_FACTOR_TITLE\s*=\s*(\d+)/.exec(limits)?.[1]);
  r.ok(cap >= 500, `the title cap is at least 500 characters`, `${cap}`);
  r.ok(
    /maxLength=\{MAX_FACTOR_TITLE\}/.test(note),
    "the note's editor uses the shared cap",
  );
  r.ok(
    /MAX_FACTOR_TITLE\s*-\s*title\.length/.test(note),
    "a remaining-characters count appears as the limit is approached",
  );

  // ================================================================
  r.section("Every panel stays on screen");
  // ================================================================

  // THE REPORTED DEFECT: with notes in Strengths and Weaknesses, a user had to
  // scroll the page to reach Opportunities and Threats, so the four were never
  // visible together — which is the one thing a SWOT board is for.
  r.ok(
    /overflow-y-auto/.test(board),
    "a panel's notes scroll INSIDE the panel — THE REPORTED DEFECT",
  );
  r.ok(
    /max-h-\[[^\]]+\]/.test(board),
    "...and the panel's height is capped, so one full panel cannot push the others off screen",
    /max-h-\[[^\]]+\]/.exec(board)?.[0],
  );
  r.ok(
    /overscroll-contain/.test(board),
    "...and scrolling a full panel does not then scroll the page past the board",
  );

  // ================================================================
  r.section("Oldest note at the top");
  // ================================================================

  const compare = /export function compareForBoard[\s\S]*?\n}/.exec(board)?.[0] ?? "";
  r.ok(compare.length > 0, "the board has its own ordering rather than taking the API's");
  r.ok(
    /created_at\.localeCompare/.test(compare) && !/b\.created_at\.localeCompare\(a/.test(compare),
    "creation order is ASCENDING — the earliest entry is at the top, not the newest",
  );
  // The API orders by votes for the prioritize stage. If that leaked into the
  // board, a note would jump up the wall the moment somebody voted on it,
  // mid-session, under everyone's eyes.
  r.ok(
    !/votes/.test(compare),
    "...and the board's order never considers votes",
  );
  r.ok(
    /board_position/.test(compare),
    "a hand-set position takes precedence over creation order",
  );
  r.ok(
    /a\.id\.localeCompare/.test(compare),
    "ties break on a stable key, so the wall cannot reshuffle between renders",
  );

  // ================================================================
  r.section("Dragging is visible, and not laggy");
  // ================================================================

  // The old board used HTML5 drag-and-drop, which gives a browser-drawn ghost
  // and no state to render. These assertions pin the replacement's two
  // performance-critical choices, both of which are easy to undo by accident.
  r.ok(
    !/onDragStart|dataTransfer/.test(board) && !/onDragStart|dataTransfer/.test(note),
    "the board no longer uses HTML5 drag-and-drop (which does not work on touch at all)",
  );
  r.ok(
    /pointermove/.test(drag) && /pointerType/.test(drag),
    "it is driven by pointer events, so a tablet in a workshop can move a note",
  );
  r.ok(
    /requestAnimationFrame/.test(drag) && /node\.style\.transform/.test(drag),
    "the dragged note's position is written to the node, NOT held in React state",
  );
  r.ok(
    !/setState\w*\(\{?\s*x:/.test(drag) && !/useState[^;]*pointer/i.test(drag),
    "...because pointer coordinates in state would re-render the whole board every mouse move",
  );
  r.ok(
    /sameTarget/.test(drag),
    "the drop target is only pushed into state when it CHANGES",
  );
  r.ok(
    /createPortal/.test(board) && /document\.body/.test(board),
    "the note in hand is rendered to the body, so a scrolling panel cannot clip it",
  );
  r.ok(
    /GhostNote/.test(board) && /intent/.test(board),
    "...and it says what the drop will do, on the thing being dragged",
  );

  // The move must not wait for the network. This is the other half of the
  // reported lag: the note used to stay put until a PATCH round-tripped.
  r.ok(
    /onMutate/.test(board) && /setQueryData/.test(board),
    "a move is applied optimistically — THE OTHER HALF OF THE REPORTED LAG",
  );
  r.ok(
    /ctx\?\.previous/.test(board),
    "...and rolled back if the server refuses it, so an optimistic move cannot lie",
  );
  r.ok(
    /onSettled/.test(board),
    "...and a refetch follows regardless, so Go remains the source of truth",
  );

  // ================================================================
  r.section("The group's figure is on the note");
  // ================================================================

  r.ok(/ScorePill/.test(note), "a note carries the group's prioritization figure");
  // TWO NUMBERS, NEVER ONE — the rule the leaderboard and the report follow.
  r.ok(
    /score\.voters/.test(note) && /score\.value/.test(note),
    "...with how many people are behind it, not the total alone",
  );
  r.ok(
    /contributors/.test(note),
    "...and the denominator is available, so 3 of 4 is distinguishable from 3 of 20",
  );
  r.ok(
    /perParticipant/.test(note),
    "a single agreed rating omits the voter count rather than claiming '1 voter'",
  );
  // The weight must come from config. A literal 'vote' here would make the
  // pill SWOT-specific and silently wrong on a risk or capability board.
  r.ok(
    !/["']vote["']/.test(board),
    "the figure comes from the methodology's own weight, not a hardcoded 'vote'",
  );
  r.ok(
    /applies_to === "factor"/.test(board),
    "...chosen as the first weight the methodology attaches to a factor",
  );

  // ================================================================
  r.section("Column view");
  // ================================================================

  r.ok(
    /ViewMode/.test(board) && /"columns"/.test(board) && /"grid"/.test(board),
    "the board offers a column layout as well as the grid",
  );
  r.ok(
    /aria-pressed/.test(board),
    "...and the toggle says which layout is active, to a screen reader too",
  );
  r.ok(
    /localStorage/.test(board) && /catch/.test(board),
    "...and the choice is remembered per viewer, without taking the board down if storage is blocked",
  );

  // THE STRIP FILLS THE WIDTH IT IS GIVEN (2026-11-07). UAT: "the SWOT in
  // columns view should span the full width as with other panels. Currently the
  // combined SWOT width in columns view looks shorter than the full width of
  // the panels above it." Four fixed 19rem panels come to ~1252px and stop
  // there, so on anything wider the wall was visibly narrower than its own
  // header with dead space beside it.
  r.ok(
    /view === "columns" \? "min-w-\[15rem\] flex-1"/.test(board),
    "a column-view panel grows to share the width, with a floor rather than a fixed size",
  );
  // THE FLOOR IS PART OF THE FIX, NOT A DETAIL. 4 x 19rem plus gaps is 1252px
  // and the content column at 1440 is 1192, so the first version kept a floor
  // ABOVE the width it was trying to fill: the panels stayed 304px and
  // overflowed into the strip's own scroll instead of growing. Nothing changed
  // on screen while every source check passed. visual verification caught it.
  r.ok(
    !/min-w-\[1[6-9]rem\]/.test(board) && !/min-w-\[2[0-9]rem\]/.test(board),
    "...and that floor is low enough for four panels to fit the column they are growing into",
  );
  r.ok(
    !/w-\[19rem\] shrink-0/.test(board),
    "...so no panel is pinned to a width the screen is wider than",
  );
  // The floor is what keeps the sideways scroll honest when the categories
  // genuinely cannot fit — nine PESTLE categories, or a tablet. Growing without
  // one would squeeze nine panels into a viewport and make every one unusable.
  r.ok(
    /overflow-x-auto/.test(board),
    "...and the strip still scrolls sideways when they cannot fit",
  );

  // "ADD A NOTE" SITS IN THE SAME PLACE IN EVERY PANEL. UAT asked for this as a
  // consequence of the guidance text, and equal-length guidance is the fragile
  // way to get it: the panels are laid out with the default `stretch`, so
  // pinning the composer to the bottom of its own panel aligns all four
  // whatever the text's length and however many notes are on the wall.
  r.ok(
    /<div className="mt-auto shrink-0">/.test(board),
    "the composer is pinned to the foot of the panel, not left wherever the content above ends",
  );
  // The move-select renders only when there IS something to move, so below the
  // composer it would have shifted it by its own height in some panels and not
  // others — the same misalignment from a second cause.
  const foot = /<div className="mt-auto shrink-0">([\s\S]*?)\n        <\/div>/.exec(board)?.[1] ?? "";
  r.ok(
    foot.indexOf("Move a note to…") !== -1 &&
      foot.indexOf("Move a note to…") < foot.indexOf("Add a note…"),
    "...with the keyboard move-select above it, since that control is conditional and the composer is not",
    `select at ${foot.indexOf("Move a note to…")}, composer at ${foot.indexOf("Add a note…")}`,
  );

  // ================================================================
  r.section("Stacking notes into a theme");
  // ================================================================

  r.ok(
    /stage_type === "synthesize"/.test(board),
    "the theme route comes from the object registry, so stacking is configuration",
  );
  r.ok(
    /methodologySynthesizes/.test(board),
    "...and a methodology with no synthesize stage offers no stacking at all",
  );
  r.ok(
    /evidence: \{ factor:/.test(board),
    "a theme is created with its notes as EVIDENCE, so traceability holds",
  );
  r.ok(
    /ThemeTitlePrompt/.test(board),
    "...and the user is asked to name it, because an unnamed theme is just a pile",
  );
  r.ok(
    /noteThemed/.test(drag) && /continue/.test(drag),
    "a note already in a theme is not a drop target — the drop falls through to its theme",
  );
  // Same-category is a client AFFORDANCE. Whether a theme may span categories
  // is a methodology question, and the engine must not answer it.
  r.ok(
    /categoryKey === source\.categoryKey/.test(drag),
    "stacking is offered within one category only",
  );

  // ================================================================
  r.section("A note can be taken back out of a theme");
  // ================================================================

  // UAT: "notes already within a theme could not be dragged out to other
  // notes to create a new theme". They were deliberately fixed in place —
  // right about REORDERING (a themed note's position belongs to its theme)
  // and wrong about REGROUPING, which is the main reason to pick one up.
  // SCOPED TO ThemeStack'S OWN BODY. Phrased against the whole file,
  // `canMove={canMove}` also matched the line where Quadrant passes the prop
  // INTO ThemeStack — so restoring `canMove={false}` on the themed note left
  // the check green. Verified by doing exactly that.
  const themeStack = board.slice(board.indexOf("function ThemeStack("));
  r.ok(
    themeStack.length > 0 &&
      /canMove=\{canMove\}/.test(themeStack) &&
      !/canMove=\{false\}/.test(themeStack) &&
      /onDragHandle=\{canMove \?/.test(themeStack),
    "a note inside a theme can be lifted out again",
  );
  r.ok(
    /themeId\?: string/.test(drag),
    "...and the drag carries the theme it came FROM, so a regroup is distinguishable from a reorder",
  );
  r.ok(
    /themeId === source\.themeId/.test(drag),
    "...dropping it back on its own stack is a no-op, not an 'add to that theme' that cannot happen",
  );
  r.ok(
    /if \(source\.themeId\) \{[\s\S]{0,400}?kind: "stack"/.test(drag),
    "...the whole of a target note means 'group with this', since a reorder is meaningless for a themed note",
  );
  // EMPTYING A THEME DELETES IT, AND THIS CHECK USED TO ASSERT THE OPPOSITE.
  //
  // The old rule refused the last note out and pointed at the Synthesis
  // stage; UAT reported that as a defect and it was reversed on 2026-11-10.
  // The check is rewritten rather than deleted, because the thing worth
  // pinning never changed: emptying a theme must not leave a titled claim
  // citing nothing. It used to be prevented and is now resolved.
  r.ok(
    /detachPlan/.test(board) && /kind: "delete", themeId/.test(board),
    "emptying a theme removes it rather than leaving a titled claim citing nothing",
  );
  r.ok(
    !/only note in its theme|Delete the theme on the Synthesis stage/.test(board),
    "...and the old refusal, which sent the facilitator to another screen, is gone",
  );
  // The one case that IS still refused, and for a different reason: a
  // reviewed theme is a decision about a named set of notes, so dissolving it
  // as a side effect of a drag would retract somebody's approval silently.
  r.ok(
    /has been reviewed, so it cannot be emptied/.test(board),
    "...but a REVIEWED theme is still refused, and the message says that is why",
  );

  // ORDER MATTERS AND IS NOT ARBITRARY: a note joins its new home before it
  // leaves the old one, so a failure leaves it grouped as it was rather than
  // in no theme at all. The mechanism changed on 2026-11-10 — both edits now
  // go to one mutation as an ordered list — so the check asks about the ORDER
  // rather than about the two chained calls it used to be written against.
  r.ok(
    /kind: "set", themeId: target\.themeId, ids: \[\.\.\.existing, \.\.\.joining\] \},\s*\.\.\.plans/.test(
      board,
    ),
    "a note joins the new theme BEFORE leaving the old one, so a failure cannot orphan it",
  );
  r.ok(
    /for \(const e of edits\)/.test(board),
    "...and the edits are sent in that order rather than fired off together",
  );
  r.ok(
    /if \(leaving && leaving\.length > 0\)/.test(board) &&
      /onSuccess: \(\) => \{[\s\S]{0,400}?editThemes\.mutate\(leaving\)/.test(board),
    "...a new theme is created first and only then do the notes leave their old ones",
  );

  // ================================================================
  r.section("one gesture, several notes (UAT 2026-11-10)");
  // ================================================================
  r.ok(
    /selected\.has\(factorId\) && selected\.size > 1/.test(board),
    "dragging a selected note carries the whole selection",
  );
  r.ok(
    /: \[factorId\]/.test(board),
    "...and dragging an UNSELECTED one carries only itself, leaving the selection alone",
  );
  // The order a selection lands in is the wall's, not the order it was
  // clicked in: a Set keeps insertion order and the room is reading the wall.
  r.ok(
    /orderedSelection = useMemo\([\s\S]{0,200}?sort\(compareForBoard\)/.test(board),
    "a bulk move keeps the board's order, not the order the notes were clicked",
  );
  r.ok(
    /metaKey \|\| e\.ctrlKey \|\| e\.shiftKey/.test(note),
    "a modifier-click selects a note instead of opening its editor",
  );
  // THE PROPERTY, NOT THE SPELLING. The first version of this matched the
  // literal `selectable || selected`, and went red the moment that condition
  // was lifted into a named `showSelect` — a correct refactor failing a check
  // that was really asserting how the condition was written. What matters is
  // that the checkbox is gated on selection being live at all, and that it is
  // a real button rather than a decoration.
  r.ok(
    /showSelect =[^;]*selectable[^;]*selected/.test(note) &&
      /\{showSelect && \(/.test(note),
    "...and a checkbox appears once selection is live, so touch has a way in and out",
  );
  r.ok(
    /aria-pressed=\{Boolean\(selected\)\}/.test(note),
    "...as a real control, which says whether it is on",
  );
  // A frozen note in a big selection must not cancel the whole move — the
  // same choice planCleanup makes, and for the same reason.
  r.ok(
    /frozen\+\+/.test(board) && /left where they are/.test(board),
    "a reviewed note in a selection is skipped and reported, not a refusal for all of them",
  );
  r.ok(
    /carrying > 1/.test(board),
    "the ghost says how many notes are in hand, since the rest fade out behind it",
  );

  // ================================================================
  r.section("a theme of one note, without inventing a second (UAT 2026-11-10)");
  // ================================================================
  r.ok(
    /Group into a \{themeLabel\.toLowerCase\(\)\}/.test(board),
    "the selection bar offers to group what is selected",
  );
  r.ok(
    /SelectionBar/.test(board) && /count: number/.test(board),
    "...and it is the same control for one note as for twenty",
  );
  r.ok(
    /selectionCategories\.size === 1/.test(board),
    "...offered only within one category, the affordance the drop already follows",
  );

  // ================================================================
  r.section("theme membership changes in one cache write (UAT 2026-11-10)");
  // ================================================================
  // "The theme shows only the new note, then organizes itself back" was two
  // server calls each invalidating, so the board rendered what the server
  // happened to know between them. Writing both edits to the cache at once
  // leaves no frame in which to render the half-done state.
  r.ok(
    /onMutate: async \(edits\)/.test(board) && /setQueryData<WorkObject\[\]>/.test(board),
    "theme edits are applied to the cache before the network, so a drop lands instantly",
  );
  r.ok(
    /const removed = new Set\([\s\S]{0,200}?const set = new Map\(/.test(board),
    "...and all of an operation's edits are applied in ONE write, leaving no half-done frame",
  );
  r.ok(
    /ctx\?\.previous/.test(board),
    "...rolled back if the server refuses, so the optimism is not a lie",
  );
  // The × inside a stack was revealed by `group-hover` with no `group`
  // ancestor, so it appeared on keyboard focus and NEVER on hover: with a
  // mouse there was no way out of a theme at all.
  r.ok(
    /className="group relative"/.test(board),
    "the 'take it out of this theme' control has a group ancestor, so hovering reveals it",
  );
  // Two controls that were rendered and wired to nothing.
  r.ok(
    /onSave=\{\(input\) => onSave\(f\.id, input\)\}/.test(board),
    "editing a note inside a theme really saves it, instead of discarding what was typed",
  );
  // THE GUARD AROUND THE BIN, not how it is spelled.
  //
  // This check used to match the literal `editable && onDelete` and went red
  // the day a third condition was added to a correct change — the same way
  // `selectable || selected` did on 2026-11-10. It now reads the conditional
  // that actually wraps the control and asks what that conditional knows.
  const binAt = note.indexOf("<Trash2");
  const binGuard = binAt > 0 ? note.slice(Math.max(0, binAt - 600), binAt) : "";
  r.ok(
    /onDelete/.test(binGuard),
    "...and no bin is drawn where deleting is not the action",
    binAt > 0 ? "guard found" : "no Trash2 in the note at all",
  );
  // NOR ON A NOTE THE ROOM HAS DECIDED ON (2026-11-14). A facilitator may now
  // reword an approved note, which made `editable` true for one — and the API
  // refuses to DELETE an approved factor ("reject it instead so the decision
  // stays on the record"). Without this the correction fix would have put a
  // bin on every approved note that could only ever return an error.
  r.ok(
    /!decided/.test(binGuard),
    "...and none on a reviewed note, which the API refuses to delete",
  );
  r.ok(
    /fromTheme/.test(board) && /Out of this \$\{label\}/.test(board),
    "the ghost says the note is LEAVING its theme, so the drop is not a surprise",
  );
  r.ok(
    /drag one out of a group/.test(board),
    "...and the board's own instructions mention it, because an undiscoverable gesture is not one",
  );

  // ================================================================
  r.section("Reordering is the facilitator's");
  // ================================================================

  r.ok(
    /reorder: facilitator/.test(board),
    "only a facilitator can rearrange the shared wall",
  );
  r.ok(
    /EDGE_BAND/.test(drag),
    "the edge of a note means 'insert here' and its middle means 'stack'",
  );
  r.ok(
    /InsertLine/.test(note),
    "...and the insertion point is drawn, so the gesture is not guesswork",
  );
  // THREE THINGS HAVE TO AGREE ON THE AXIS, and only one of them is code the
  // compiler sees. The notes are tiles in rows, so "before" means to the
  // LEFT: the drag must read x, the insertion line must be drawn vertically,
  // and the on-screen hint must say so. When the layout changed, the first
  // two were updated and the hint still read "top or bottom edge" — found by
  // looking at a screenshot, not by any assertion, so here it is.
  r.ok(
    /const where = \(x - rect\.left\) \/ Math\.max\(1, rect\.width\)/.test(drag),
    "the reorder band is on the HORIZONTAL axis, matching tiles that flow in rows",
  );
  r.ok(
    /inset-y-0[^"]*flex-col/.test(note) && /-left-2/.test(note),
    "...the insertion line is drawn vertically, between two side-by-side notes",
  );
  r.ok(
    /left or right edge/.test(board) && !/top or bottom edge/.test(board),
    "...and the on-screen hint describes THAT gesture, not the previous layout's",
  );
  r.ok(
    /setFactorOrder\(workshopId, v\.categoryKey, v\.ids\)/.test(board),
    "the whole category's order is sent, so a reorder cannot half-apply",
  );

  // ================================================================
  r.section("The wall is the screen, and the assistant is in the composer");
  // ================================================================

  // UAT: "the SWOT grid should be top of mind. Other panels should be hidden
  // or minimized. The AI assistant panel should not be [beside the board]
  // where it takes up screenspace, but somehow incorporated into the 'Add a
  // note…'".
  //
  // Everything here is about COMPOSITION — what else is on the screen beside
  // the four panels — which is exactly the class of thing an API test cannot
  // see and the class of thing that was reported. visual-board.js measures the
  // result; these are the source-level rules behind it.
  const stageRoute = codeOnly(read("src", "routes", "w.$workshopId.stage.$stageKey.tsx"));
  const shell = codeOnly(read("src", "components", "methodology", "StageShell.tsx"));

  // The board branch has to be identified before anything is asserted about
  // it: every OTHER stage type keeps its side panel, and a check that matched
  // the whole file would pass on those and say nothing about this one.
  const boardBranch = /if \(board\) \{([\s\S]*?)\n      \}/.exec(stageRoute)?.[1] ?? "";
  r.ok(boardBranch.length > 0, "the board's own branch of the stage route can be identified");

  r.ok(
    !/aiPanel=/.test(boardBranch),
    "the board stage passes NO aiPanel, so StageShell draws no 340px column beside the wall",
  );
  r.ok(
    /aiSlot=\{<AiActionPanel/.test(boardBranch),
    "...it hands the same panel to the board instead, so the route stays the only place AI is wired",
  );
  // THE OTHER SIX STAGE TYPES LOST THE COLUMN TOO (2026-11-07).
  //
  // This check used to assert the opposite — "the column is still there for
  // every other stage type, which did not ask for this" — and then UAT asked:
  // "integrate the AI Assistant function into the panels on the left so that we
  // can remove the AI Assistant panel altogether and free up the screen space
  // at the right." The board's move was simply half-made. A 340px track of a
  // 1192px screen for one or two buttons, and on the TOWS matrix that column
  // rendered EMPTY beside the matrix at 1440.
  r.ok(
    !/340px/.test(shell) && !/aiPanel/.test(shell),
    "no stage type reserves a 340px column any more: the shell has no second track at all",
  );
  r.ok(
    !/aiPanel=/.test(stageRoute) && (stageRoute.match(/assistant=\{<StageAssistant/g) ?? []).length >= 5,
    "...and every non-board stage type passes the same panel as a header control instead",
  );
  // A COLUMN THAT IS NOT CONFIGURED SIMPLY DOES NOT APPEAR; A BUTTON SITS THERE
  // AND OPENS NOTHING. AiActionPanel returning null was enough for the one and
  // is not enough for the other, so the availability question is asked before
  // the trigger exists — the same shape as `scope='object'` with empty
  // `applies_to`, and as a "disable user" that disabled nothing.
  const assistant = codeOnly(read("src", "components", "methodology", "StageAssistant.tsx"));
  r.ok(
    /if \(!available\) return null;/.test(assistant),
    "the header trigger renders nothing when the stage has no stage-scoped AI function",
  );
  r.ok(
    /queryKey: \["ai-status", workshopId, stageKey\]/.test(assistant),
    "...and it asks through the panel's own query key, so the gate costs no extra request",
  );
  r.ok(
    /f\.scope === "stage"/.test(assistant),
    "...filtering to stage scope, since an object-scoped action could not run from here",
  );
  r.ok(
    !/aiApi\.execute/.test(assistant) && /<AiActionPanel/.test(assistant),
    "the panel is reused rather than reimplemented, so the rate limit and the review rules have one home",
  );

  r.ok(
    !/guidance=/.test(boardBranch),
    "the shell's guidance block is not passed either — the panels already print that text",
  );
  r.ok(
    /category\.guidance_text/.test(board),
    "...and it genuinely does print it, so dropping it from the shell loses nothing",
  );
  // EVERY PANEL, NOT JUST THE FOCUSED ONE (2026-11-07). UAT: "the methodology
  // guidance for each SWOT should all appear throughout Stage 1-4." It was
  // gated on `focused`, so three of the four panels a facilitator can write in
  // said nothing about what belongs in them — and the odd one out being taller
  // is what pushed the composers out of line.
  r.ok(
    !/focused && category\.guidance_text/.test(board),
    "a panel's guidance is not gated on the stage being focused: it is per-category config",
  );
  r.ok(/dense\b/.test(boardBranch) && /dense = false/.test(shell),
    "the header runs in its dense form, and dense is OFF by default for every other stage",
  );

  // THE ZERO MINIMUM THE AI COLUMN USED TO SUPPLY BY ACCIDENT.
  //
  // A grid item's default min-width is `auto`, so the shell's content column
  // cannot shrink below its content's min-content width. Column view is a
  // strip of fixed-width panels whose min-content is their TOTAL, so the
  // column grew past its track and slid the whole document sideways.
  //
  // It was invisible until the panel was removed, because the two-column class
  // carried a `minmax(0,1fr)` track whose 0 did the job. visual-board.js
  // caught it by measuring the document; this pins the remedy so it cannot be
  // tidied away as a redundant utility — which is exactly how it would read.
  r.ok(
    /<div className="min-w-0 space-y-4">\{children\}<\/div>/.test(shell),
    "the shell's content column declares a zero minimum of its own, not one borrowed from the AI column's grid track",
  );

  // THE PANEL IS REUSED, NOT REIMPLEMENTED. A composer-sized copy of it would
  // be a second implementation of the governance rules — the rate limit, the
  // per-suggestion review, the renderer chosen from the declared output_kind,
  // the refusal for somebody who may not add — and a second place for them to
  // drift out of step with the server.
  r.ok(
    !/aiApi/.test(board),
    "the board itself calls no AI endpoint: it is handed a node and renders it",
  );
  r.ok(
    /assist \?\? /.test(board) === false && /assist &&/.test(board),
    "the assistant renders only when one was supplied",
  );
  r.ok(
    /category\.key === focusedKey && aiSlot/.test(board),
    "it is offered on the FOCUSED panel only — the functions are stage-scoped, and a capture stage is one category",
  );

  // The trigger sits INSIDE the add-a-note form, where a button's default
  // type submits the form it is in: the ✨ would have posted an empty note, or
  // whatever was half-typed, on every click.
  const assistButton = board.slice(board.indexOf("function AssistButton("));
  r.ok(
    /type="button"/.test(assistButton.slice(0, assistButton.indexOf("</Popover>"))),
    "the ✨ is type=button, so clicking it cannot submit the composer it lives in",
  );
  r.ok(
    /sr-only/.test(assistButton),
    "...and it carries a text label for anyone not seeing the icon",
  );
  r.ok(
    /assist && !canAdd/.test(board),
    "somebody with no composer — an observer — still reaches the assistant, rather than losing it with the textarea",
  );

  // Two panels of chrome between the header and the wall became one row.
  r.ok(
    !/function BoardStatus\(/.test(board),
    "the separate status panel is gone",
  );
  r.ok(
    /<LiveState status=\{status\}/.test(board) && /<Presence present=\{present\}/.test(board),
    "...its two pieces of information are in the toolbar row instead, not dropped",
  );
  // The degraded cases must keep their words. "Live" is only worth a sentence
  // when it is not true, and a board that has silently stopped updating looks
  // exactly like a board where nobody is typing.
  r.ok(
    /Not live — refreshing every few seconds/.test(board) && /Connecting…/.test(board),
    "...and a board that is NOT live still says so in words",
  );

  const cleanup = codeOnly(read("src", "components", "methodology", "CleanupPanel.tsx"));
  r.ok(
    /Deduplicate and Fix/.test(cleanup) && !/Merge and Fix/.test(cleanup),
    "the tidy-up button says Deduplicate, not Merge — on this board 'merge' already means grouping notes into a theme",
  );
  r.ok(
    /<details/.test(cleanup),
    "...and its four sentences of first-run guidance are behind a disclosure rather than above the wall",
  );
  r.ok(
    /!configured \?/.test(cleanup),
    "...but the reason a disabled button is disabled is NOT hidden, which is the one thing nobody could diagnose",
  );
});
