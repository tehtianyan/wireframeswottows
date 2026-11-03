// Field limits the BROWSER must agree with the server about.
//
// These were scattered as literal `maxLength={120}` across four forms, each a
// copy of a number enforced in Go. A copy is fine until one of them changes:
// then a form either refuses text the server would accept, or accepts text
// the server refuses and the person loses what they typed on submit. Naming
// the figure once makes the forms follow the rule instead of remembering it.
//
// KEEP IN STEP WITH pkg/handlers.MaxFactorTitle. Nothing can import a Go
// constant into the bundle, so `tests/suites/board-ui.js` reads both files and
// asserts they match — the drift is caught by a test rather than by a user
// losing a long note.

/** A capture note's title. Mirrors pkg/handlers.MaxFactorTitle. */
export const MAX_FACTOR_TITLE = 500;

/**
 * An analysis object's title — a theme, an insight, a recommendation.
 * Mirrors pkg/handlers.MaxObjectTitle.
 *
 * Deliberately shorter than a note's. A note is something somebody said in a
 * room and may be a whole sentence; a theme's title is a NAME somebody chose
 * for a group of them, and a name that runs to a paragraph is not a name.
 */
export const MAX_OBJECT_TITLE = 200;

/**
 * The fewest lines of a note's text the board will ever show at rest.
 *
 * A note sizes itself to its content and stops at roughly a square, with the
 * rest behind "Show more" (see StickyNote). That ceiling is measured from the
 * rendered box, so in a very narrow column it could compute down to one line
 * or none — which would clamp notes that are not long at all, and put a "Show
 * more" on a sentence. This is the floor under that arithmetic.
 *
 * NOT a character count. The previous version of this constant was
 * SQUARE_NOTE_CHARS, a threshold in characters, and it was never imported by
 * anything: whether text overflows depends on the column width, the font and
 * the theme's line height, so a figure in characters could not have decided
 * it. A test asserted the constant existed, which is not the same as asserting
 * anything reads it.
 */
export const MIN_NOTE_LINES = 2;
