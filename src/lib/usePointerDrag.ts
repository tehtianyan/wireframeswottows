import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The pointer mechanics of a drag, with the payload left to the caller.
 *
 * WHY THIS EXISTS. `useBoardDrag` already does all of this for the capture
 * board, and the TOWS matrix needs it twice more — dragging a theme from an
 * edge into a quadrant, and dragging an action into priority order inside a
 * cell. Three near-copies of press/hold/slop/rAF-ghost/hit-test/Escape would
 * be three places for the two rules below to drift, and those rules are the
 * whole reason the capture board's drag feels like a drag at all:
 *
 *   1. THE GHOST'S TRANSFORM IS WRITTEN TO THE NODE INSIDE A rAF CALLBACK,
 *      never held in React state. Pointer coordinates in state re-render the
 *      whole surface on every mouse move, which is exactly the stutter that
 *      replacing HTML5 drag-and-drop was meant to fix.
 *   2. TARGET STATE CHANGES ONLY WHEN THE TARGET CHANGES, not when the
 *      pointer does.
 *
 * `useBoardDrag` is deliberately NOT refactored onto this. That screen took
 * three versions to get right and has a browser suite measuring the result;
 * rewriting its internals to serve a new screen would put it at risk for no
 * benefit to it. This is the shared mechanism going forward, and that one can
 * move onto it later under its own tests.
 *
 * Hit-testing reads `data-` attributes out of `elementsFromPoint` rather than
 * caching rectangles, so a container scrolling under the pointer is handled
 * for free. Touch requires a short hold, or the first finger movement would
 * always pick something up and the page could never be scrolled.
 */

interface Options<S, T> {
  /**
   * What is under the pointer, given the thing being carried. Return null for
   * "nowhere" — the drop is then reported as nothing rather than guessed at.
   */
  hitTest: (x: number, y: number, source: S) => T | null;
  /** True when the two targets mean the same place, so state is left alone. */
  sameTarget: (a: T | null, b: T | null) => boolean;
  onDrop: (source: S, target: T) => void;
}

/** Size of the thing picked up, so the ghost is that object and not a chip. */
export interface DragBox {
  width: number;
  height: number;
}

const HOLD_MS = 180;
const SLOP = 4;

export function usePointerDrag<S, T>({ hitTest, sameTarget, onDrop }: Options<S, T>) {
  const [drag, setDrag] = useState<(S & DragBox) | null>(null);
  const [target, setTarget] = useState<T | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // Everything the move handler needs that must NOT cause a re-render.
  const live = useRef<{
    source: (S & DragBox) | null;
    target: T | null;
    offsetX: number;
    offsetY: number;
    frame: number | null;
    pending: { x: number; y: number } | null;
    holdTimer: number | null;
    started: boolean;
    startX: number;
    startY: number;
    pointerType: string;
    moved: boolean;
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
    moved: false,
  });

  const paint = useCallback(() => {
    live.current.frame = null;
    const p = live.current.pending;
    const node = ghostRef.current;
    if (!p || !node) return;
    // translate3d keeps this on the compositor, so the card tracks the
    // pointer even while React renders a target change elsewhere.
    node.style.transform = `translate3d(${p.x - live.current.offsetX}px, ${
      p.y - live.current.offsetY
    }px, 0) rotate(-1.4deg) scale(1.03)`;
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const src = live.current.source;
      const tgt = live.current.target;
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
      if (commit && src && tgt !== null && tgt !== undefined) onDrop(src, tgt);
    },
    [onDrop],
  );

  useEffect(() => {
    if (!drag) return;

    const move = (e: PointerEvent) => {
      if (!live.current.started) {
        const far =
          Math.abs(e.clientX - live.current.startX) > SLOP ||
          Math.abs(e.clientY - live.current.startY) > SLOP;
        // Touch waits for the hold; a mouse starts once the pointer has
        // travelled far enough to mean it, which is also what lets a click
        // on the same element still be a click.
        if (live.current.pointerType === "touch" || !far) return;
        live.current.started = true;
      }
      live.current.moved = true;
      e.preventDefault();
      live.current.pending = { x: e.clientX, y: e.clientY };
      if (live.current.frame === null) live.current.frame = requestAnimationFrame(paint);

      const src = live.current.source;
      if (!src) return;
      const next = hitTest(e.clientX, e.clientY, src);
      if (!sameTarget(next, live.current.target)) {
        live.current.target = next;
        setTarget(next); // RULE 2 — only on a real change.
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [drag, paint, hitTest, sameTarget, finish]);

  /**
   * Put this on whatever the person actually presses — the WHOLE card, not a
   * handle on its rim. The capture board shipped with only a ~10px border
   * draggable because its text is a button, which on a 120px tile is
   * indistinguishable from "this cannot be dragged".
   */
  const dragHandlers = useCallback(
    (payload: S) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const box = e.currentTarget.getBoundingClientRect();
        const full = { ...payload, width: box.width, height: box.height } as S & DragBox;
        live.current.offsetX = e.clientX - box.left;
        live.current.offsetY = e.clientY - box.top;
        live.current.startX = e.clientX;
        live.current.startY = e.clientY;
        live.current.pointerType = e.pointerType;
        live.current.source = full;
        live.current.pending = { x: e.clientX, y: e.clientY };
        live.current.started = e.pointerType !== "touch";
        live.current.moved = false;

        if (e.pointerType === "touch") {
          live.current.holdTimer = window.setTimeout(() => {
            live.current.started = true;
          }, HOLD_MS);
        }
        setDrag(full);
      },
    }),
    [],
  );

  /** True once the pointer has travelled far enough for this to be a drag. */
  const didMove = () => live.current.moved;

  return { drag, target, ghostRef, dragHandlers, didMove, cancel: () => finish(false) };
}
