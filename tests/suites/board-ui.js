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
  r.section("A note is the size of what it holds");
  // ================================================================

  // THE REPORTED DEFECT, AND IT WAS MY OWN DECISION REVERSED. The first
  // version made every note `aspect-square`, on the argument that a post-it is
  // square. A three-letter note then rendered as a large box of empty colour:
  // a wall of short notes needed as much scrolling as a wall of long ones, and
  // the size of a note told you nothing about it — the opposite of the
  // scannability the square was justified by. The square is now a CEILING on
  // the text, not a shape imposed on the box.
  // Scoped to the note's OWN class list: the insertion line between notes
  // legitimately uses `h-3`, and a blanket search for a fixed height across
  // the file would fail on it — a test that passes or fails for a reason
  // other than the one it names is the thing this project keeps catching.
  const noteRoot = /"group relative flex[^"]*"/.exec(note)?.[0] ?? "";
  r.ok(noteRoot.length > 0, "the note's own class list can be identified", noteRoot);

  r.ok(
    !/aspect-square/.test(note),
    "a note sets NO aspect ratio — THE REPORTED DEFECT (a 3-letter note was a huge square)",
    /aspect-square/.test(note) ? "aspect-square still present" : "no aspect ratio",
  );
  r.ok(
    // The lookbehind is load-bearing: `min-h-[4.25rem]` contains `h-[`, so
    // without it this reports a fixed height where there is a minimum — a
    // check failing for a reason other than the one it names.
    !/(?<!-)\bh-\d/.test(noteRoot) && !/(?<!-)\bh-\[/.test(noteRoot),
    "...and no fixed height either, so the box follows its content",
    noteRoot,
  );
  // A floor, not a height: a three-word note should still read as a sticky
  // rather than as a chip. The distinction matters — `h-` would reintroduce
  // the defect.
  r.ok(
    /min-h-\[[^\]]+\]/.test(noteRoot),
    "...with a minimum so a very short note still looks like a sticky",
    /min-h-\[[^\]]+\]/.exec(noteRoot)?.[0],
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
  r.ok(
    /setFactorOrder\(workshopId, v\.categoryKey, v\.ids\)/.test(board),
    "the whole category's order is sent, so a reorder cannot half-apply",
  );
});
