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
  r.ok(
    /canDetach/.test(board) && /only note in its theme/.test(board),
    "a theme cannot be emptied by dragging its last note away — an empty theme cites nothing",
  );
  // ORDER MATTERS AND IS NOT ARBITRARY: the note joins its new home before it
  // leaves the old one, so a failure leaves it grouped as it was rather than
  // in no theme at all.
  r.ok(
    /mutateAsync\([\s\S]{0,200}?\.then\(\(\) => \(from \? detach/.test(board),
    "...and it joins the new theme BEFORE leaving the old one, so a failure cannot orphan it",
  );
  r.ok(
    /detach: \{ themeId: source\.themeId, factorId: source\.factorId \}/.test(board) &&
      /if \(leaving\) void detach/.test(board),
    "...a new theme is created first and only then does the note leave its old one",
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
  r.ok(
    /editable && onDelete/.test(note),
    "...and no bin is drawn where deleting is not the action",
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
  r.ok(
    /xl:grid-cols-\[minmax\(0,1fr\)_340px\]/.test(shell) && /aiPanel &&/.test(shell),
    "...and the column is still there for every other stage type, which did not ask for this",
  );
  r.ok(
    !/guidance=/.test(boardBranch),
    "the shell's guidance block is not passed either — the focused panel already prints that text",
  );
  r.ok(
    /category\.guidance_text/.test(board),
    "...and it genuinely does print it, so dropping it from the shell loses nothing",
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
