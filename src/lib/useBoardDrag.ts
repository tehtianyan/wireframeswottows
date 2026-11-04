import { useCallback, useEffect, useRef, useState } from "react";

// Dragging a sticky note on the capture board.
//
// WHY THIS REPLACED HTML5 DRAG-AND-DROP. The board used the native API, and
// UAT reported the notes felt laggy and the drag hard to see. Both complaints
// were accurate and neither was really about speed:
//
//  1. The native API hands the browser a translucent screenshot of the element
//     and then tells you nothing until the drop. There is no "the note is in
//     my hand" state to render, so a facilitator dragging in front of a room
//     cannot see what they are holding or where it will land. A physical
//     sticky note is unambiguous about both.
//  2. `dragover` fires at the browser's own cadence, and the only feedback the
//     old board drew from it was a panel-level shadow — so the pointer moved
//     smoothly while the UI changed in steps, which reads as lag.
//  3. It does not work on touch at all. A tablet in a workshop could not move
//     a note, which is the device most likely to be passed around a table.
//
// So the note is dragged with pointer events and rendered as a real element
// that follows the cursor. Two rules keep it smooth:
//
//  - THE GHOST MOVES WITHOUT REACT. Its transform is written straight to the
//    node inside a rAF callback. Putting pointer coordinates in state would
//    re-render the whole board on every mouse move, which is the one way to
//    turn a 60fps gesture back into the stutter this replaced.
//  - TARGET STATE CHANGES ONLY WHEN THE TARGET CHANGES. Moving within the same
//    drop zone re-renders nothing.
//
// Hit-testing reads `data-` attributes out of elementsFromPoint rather than
// caching rectangles, so a panel that scrolls under the pointer mid-drag is
// handled for free.

/** Where a drop would put the note. */
export type DropTarget =
  /** Into a category, at the end — the old "move between quadrants". */
  | { kind: "panel"; categoryKey: string }
  /** Above or below a specific note: a reorder within the category. */
  | { kind: "before"; categoryKey: string; factorId: string }
  | { kind: "after"; categoryKey: string; factorId: string }
  /** Onto a note's middle: stack the two into a new theme. */
  | { kind: "stack"; categoryKey: string; factorId: string }
  /** Onto an existing theme stack: add this note to that theme. */
  | { kind: "theme"; categoryKey: string; themeId: string };

export interface DragState {
  factorId: string;
  categoryKey: string;
  /**
   * The theme this note is currently IN, when it is in one.
   *
   * A note in a theme is dragged to REGROUP it — that is the only reason to
   * pick it up, since its position on the wall is its theme's. So the source's
   * own theme has to be known here: without it, dropping a themed note back on
   * its own stack would read as "add to that theme" (it is already there) and
   * the ghost would promise something that cannot happen.
   */
  themeId?: string;
  /** The note's own size, so the ghost is the same object, not a generic chip. */
  width: number;
  height: number;
}

interface Options {
  /** Called once on release, with wherever the note ended up (null = nowhere). */
  onDrop: (source: DragState, target: DropTarget | null) => void;
  /** Which drop kinds the caller will honour; others are never reported. */
  allow: { reorder: boolean; stack: boolean; move: boolean };
}

/** Movement in px before a mouse press becomes a drag rather than a click. */
const MOUSE_THRESHOLD = 4;
/**
 * Touch must HOLD before dragging, or the board could not be scrolled on a
 * tablet: the first finger movement would always pick a note up instead. A
 * press-and-hold is also the gesture people already use to move things on a
 * touchscreen, so nothing has to be taught.
 */
const TOUCH_HOLD_MS = 220;

/** The share of a note's height at each end that means "insert here". */
const EDGE_BAND = 0.3;

export function useBoardDrag({ onDrop, allow }: Options) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);

  const ghostRef = useRef<HTMLDivElement | null>(null);
  // Everything the move handler needs that must NOT cause a re-render.
  const live = useRef<{
    source: DragState | null;
    target: DropTarget | null;
    offsetX: number;
    offsetY: number;
    frame: number | null;
    pending: { x: number; y: number } | null;
    holdTimer: number | null;
    started: boolean;
    startX: number;
    startY: number;
    pointerType: string;
  }>({
    source: null,
    target: null,
    offsetX: 0,
    offsetY: 0,
    frame: null,
    pending: null,
    holdTimer: null,
    started: false,
    startX: 0,
    startY: 0,
    pointerType: "mouse",
  });

  const paint = useCallback(() => {
    live.current.frame = null;
    const p = live.current.pending;
    const node = ghostRef.current;
    if (!p || !node) return;
    // translate3d keeps this on the compositor, so the note tracks the finger
    // even while React is busy rendering a target change elsewhere.
    node.style.transform = `translate3d(${p.x - live.current.offsetX}px, ${
      p.y - live.current.offsetY
    }px, 0) rotate(-1.6deg) scale(1.04)`;
  }, []);

  /** Reads the drop zone under a point straight out of the DOM. */
  const resolveTarget = useCallback(
    (x: number, y: number): DropTarget | null => {
      const source = live.current.source;
      if (!source) return null;
      // The ghost sits under the pointer, so it must not be hit-tested. It
      // carries pointer-events:none, which elementsFromPoint already honours.
      const stack = document.elementsFromPoint(x, y);

      for (const el of stack) {
        if (!(el instanceof HTMLElement)) continue;

        // An existing theme stack: add the note to that theme — or, for a note
        // already in one, MOVE it there.
        const themeId = el.dataset["themeId"];
        if (themeId && allow.stack) {
          // Its own stack is a no-op, reported as "nowhere" so the ghost says
          // "release to leave it where it is" rather than offering to add a
          // note to the theme it is already a member of.
          if (themeId === source.themeId) return null;
          const categoryKey = el.dataset["themeCategory"] ?? "";
          return { kind: "theme", categoryKey, themeId };
        }

        const noteId = el.dataset["noteId"];
        if (noteId) {
          if (noteId === source.factorId) return null; // itself: no-op
          const categoryKey = el.dataset["noteCategory"] ?? "";
          const rect = el.getBoundingClientRect();
          // THE HORIZONTAL AXIS, because the notes are a grid of tiles that
          // flows left to right. This read the vertical axis while the panel
          // was a single column of full-width notes, and both were right at
          // the time — but with tiles in rows, "before" means to the LEFT of
          // this note, so a band on the top edge would offer an insertion
          // point nowhere near where the note would land.
          const where = (x - rect.left) / Math.max(1, rect.width);

          // A NOTE INSIDE A THEME IS NOT A TARGET AT ALL. Every answer would
          // be ambiguous: stacking onto it means "a theme of a note that is
          // already in a theme", and inserting beside it means landing inside
          // a group without joining it. Skipping the note lets the drop fall
          // through to its theme wrapper, which sits next in the hit stack and
          // means the one unambiguous thing — add this note to that theme.
          if (el.dataset["noteThemed"] === "true") continue;

          // A THEMED NOTE IS BEING REGROUPED, SO THE WHOLE TARGET MEANS
          // "GROUP WITH THIS". The edge bands offer a reorder, and a reorder
          // is meaningless for a note whose place on the wall is its theme's —
          // it would leave the note in its group and renumber the category
          // around it. Skipping the bands also makes the gesture easier to
          // land: on a 120px tile the middle 40% is a small target to hit
          // while deliberately pulling a note out of a pile.
          if (source.themeId) {
            if (allow.stack && categoryKey === source.categoryKey) {
              return { kind: "stack", categoryKey, factorId: noteId };
            }
            // Another category: fall through to that panel, which pulls it out
            // of the theme and recategorises it.
            continue;
          }

          if (where < EDGE_BAND) {
            if (allow.reorder && categoryKey === source.categoryKey) {
              return { kind: "before", categoryKey, factorId: noteId };
            }
          } else if (where > 1 - EDGE_BAND) {
            if (allow.reorder && categoryKey === source.categoryKey) {
              return { kind: "after", categoryKey, factorId: noteId };
            }
          } else if (allow.stack && categoryKey === source.categoryKey) {
            // SAME CATEGORY ONLY, as a client-side affordance. The server
            // does not refuse a cross-category theme and should not: whether
            // a theme may span categories is a methodology question, and
            // baking one methodology's answer into the engine is exactly what
            // this codebase does not do. The board simply does not offer it.
            return { kind: "stack", categoryKey, factorId: noteId };
          }
          // Fall through to the panel below rather than reporting nothing:
          // a drop on a note in another category is still a category move.
        }

        const panel = el.dataset["panelCategory"];
        if (panel) {
          if (panel === source.categoryKey) {
            // Dropped on empty space in its own panel. For a themed note that
            // is nothing: "send it to the end" would reorder a note whose
            // position the theme owns, and the note would still be in the
            // theme, so the gesture would look like it had failed.
            if (source.themeId) return null;
            return allow.reorder ? { kind: "panel", categoryKey: panel } : null;
          }
          return allow.move ? { kind: "panel", categoryKey: panel } : null;
        }
      }
      return null;
    },
    [allow.move, allow.reorder, allow.stack],
  );

  const finish = useCallback(
    (commit: boolean) => {
      const { source, target: t } = live.current;
      if (live.current.holdTimer !== null) {
        window.clearTimeout(live.current.holdTimer);
        live.current.holdTimer = null;
      }
      if (live.current.frame !== null) {
        cancelAnimationFrame(live.current.frame);
        live.current.frame = null;
      }
      live.current.source = null;
      live.current.target = null;
      live.current.started = false;
      live.current.pending = null;
      setDrag(null);
      setTarget(null);
      if (commit && source) onDrop(source, t);
    },
    [onDrop],
  );

  /**
   * Attach to a note's pointerdown. `element` is the note itself, which is
   * measured so the ghost is the same size as the thing being lifted.
   */
  const beginDrag = useCallback(
    (e: React.PointerEvent, source: Omit<DragState, "width" | "height">, element: HTMLElement) => {
      // Only the primary button, and never a secondary pointer mid-drag.
      if (e.button !== 0 || live.current.source) return;
      const rect = element.getBoundingClientRect();
      const state: DragState = {
        ...source,
        width: rect.width,
        height: rect.height,
      };
      live.current.source = state;
      live.current.offsetX = e.clientX - rect.left;
      live.current.offsetY = e.clientY - rect.top;
      live.current.pending = { x: e.clientX, y: e.clientY };
      live.current.startX = e.clientX;
      live.current.startY = e.clientY;
      live.current.started = false;
      live.current.pointerType = e.pointerType;

      const lift = () => {
        if (!live.current.source) return;
        live.current.started = true;
        setDrag(live.current.source);
        if (live.current.frame === null) live.current.frame = requestAnimationFrame(paint);
      };

      if (e.pointerType === "touch") {
        live.current.holdTimer = window.setTimeout(lift, TOUCH_HOLD_MS);
      }
      // Mouse and pen lift on the movement threshold instead, in the move
      // handler, so a plain click still opens the note for editing.
    },
    [paint],
  );

  useEffect(() => {
    if (!live.current.source && !drag) {
      // Listeners are only worth attaching while a press is live. `drag`
      // alone is not enough: a mouse press before the threshold has no drag
      // state yet but must still be tracked.
    }

    function onMove(e: PointerEvent) {
      const s = live.current;
      if (!s.source) return;

      if (!s.started) {
        if (s.pointerType === "touch") {
          // Moving before the hold completes is a scroll, not a drag.
          const moved =
            Math.abs(e.clientX - s.startX) + Math.abs(e.clientY - s.startY) > MOUSE_THRESHOLD;
          if (moved) {
            if (s.holdTimer !== null) window.clearTimeout(s.holdTimer);
            s.holdTimer = null;
            s.source = null;
          }
          return;
        }
        if (
          Math.abs(e.clientX - s.startX) + Math.abs(e.clientY - s.startY) <
          MOUSE_THRESHOLD
        ) {
          return;
        }
        s.started = true;
        setDrag(s.source);
      }

      // Stops the browser selecting text across the board mid-drag, which
      // otherwise paints half the wall blue.
      e.preventDefault();

      s.pending = { x: e.clientX, y: e.clientY };
      if (s.frame === null) s.frame = requestAnimationFrame(paint);

      const next = resolveTarget(e.clientX, e.clientY);
      if (!sameTarget(next, s.target)) {
        s.target = next;
        setTarget(next);
      }
    }

    function onUp() {
      if (!live.current.source) return;
      finish(live.current.started);
    }

    function onCancel() {
      if (!live.current.source) return;
      finish(false);
    }

    function onKey(e: KeyboardEvent) {
      // Escape puts the note back, the same as letting go outside the board.
      if (e.key === "Escape" && live.current.source) finish(false);
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
  }, [drag, finish, paint, resolveTarget]);

  // While a note is in hand the cursor is a grabbing hand everywhere, and no
  // text can be selected — both of which make the gesture feel like holding an
  // object rather than operating a widget.
  useEffect(() => {
    if (!drag) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [drag]);

  return { drag, target, beginDrag, ghostRef, cancel: () => finish(false) };
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.categoryKey !== b.categoryKey) return false;
  if (a.kind === "theme" && b.kind === "theme") return a.themeId === b.themeId;
  if ("factorId" in a && "factorId" in b) return a.factorId === b.factorId;
  return true;
}
