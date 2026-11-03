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
 * Where a note stops being square and starts growing taller.
 *
 * A post-it is square because a short note should look like a short note —
 * that is what makes a wall scannable. But clipping a long one hides content,
 * and shrinking the text to fit makes it unreadable on a projector. So a note
 * is square up to here and grows beyond it: the shape itself then tells you
 * which notes are long, which is information rather than a defect.
 */
export const SQUARE_NOTE_CHARS = 200;
