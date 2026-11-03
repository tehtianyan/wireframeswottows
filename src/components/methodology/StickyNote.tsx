import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripVertical, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_FACTOR_TITLE, MIN_NOTE_LINES } from "@/lib/limits";
import { FactorStatePill } from "./FactorCard";
import type { Factor, FactorCategory } from "@/lib/api";

// One sticky note on the capture board.
//
// The colour is the CATEGORY's own token, so the wall reads by colour without
// anything here knowing what a strength is — a PESTLE board colours itself the
// same way from six different tokens.
//
// THE SQUARE IS A CEILING, NOT A FLOOR (CORRECTED 2026-11-03). The first
// version made every note `aspect-square`, reasoning that a post-it is square
// and that the shape should be the shape of the object it stands for. Shipping
// it showed the flaw immediately: a three-letter note became a large box of
// empty colour, so a wall of short notes needed as much scrolling as a wall of
// long ones and the size of a note said nothing about it. The square was doing
// the opposite of its own justification.
//
// So a note is now the size of what it holds, and the square is where it stops
// growing. The text clamps at the line count that keeps the note roughly as
// tall as it is wide, with the browser's own ellipsis, and a control expands it
// in place. That line count is MEASURED, not a constant: the panels are wider
// in grid view than in column view, so a fixed clamp would be square in one and
// not the other.
//
// The honest trade is that a long note no longer shows all of itself at rest.
// Hiding the tail behind a visible "more" is better than either of the
// alternatives — clipping with no affordance hides text and says nothing, and
// letting the note grow unbounded is what made the wall unscannable.

/** The group's figure for one note, when the methodology has a factor weight. */
export interface NoteScore {
  /** The weight's configured name — "Votes", "Likelihood", whatever it is. */
  name: string;
  value: number;
  /** How many people are behind that value. */
  voters: number;
  /** How many people have allocated anything at all — the denominator. */
  contributors: number;
  /** An ordinal name for the value, where the scale supplies them. */
  label?: string;
  /** False for a single agreed rating, where "1 voter" would mislead. */
  perParticipant: boolean;
}

/**
 * How many lines of text keep this note inside a square.
 *
 * MEASURED RATHER THAN ASSUMED, for two reasons. The panels are wider in grid
 * view than in column view, so one hardcoded clamp would be square in one view
 * and wrong in the other. And the note's chrome — its padding, the footer row
 * carrying the state pill and the author — is a fixed number of pixels, not a
 * fraction of the width, so a "60% of the width for text" rule would drift as
 * the column got narrower. Both are read off the rendered box instead.
 *
 * Recomputed on WIDTH changes only. Applying the clamp changes the note's
 * HEIGHT, and a ResizeObserver reacting to that would set a clamp, observe the
 * height it caused, and set it again.
 */
function useSquareClamp(
  rootRef: React.RefObject<HTMLDivElement | null>,
  textRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [lines, setLines] = useState<number | null>(null);
  const lastWidth = useRef(0);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const text = textRef.current;
    if (!root || !text) return;

    const width = root.getBoundingClientRect().width;
    if (width <= 0) return;

    // The real line height, so a theme or a font change cannot leave this
    // computing against a figure from a previous design.
    const styles = getComputedStyle(text);
    const lineHeight = parseFloat(styles.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

    // Everything the note spends on something other than the text. Taken from
    // the rendered boxes, so it stays correct when the footer gains a pill.
    const chrome = root.getBoundingClientRect().height - text.getBoundingClientRect().height;
    const forText = width - Math.max(0, chrome);

    lastWidth.current = width;
    setLines(Math.max(MIN_NOTE_LINES, Math.floor(forText / lineHeight)));
  }, [rootRef, textRef]);

  useLayoutEffect(() => {
    if (!enabled) {
      setLines(null);
      return;
    }
    measure();
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Width only. See the note above about the feedback loop.
      if (Math.abs(width - lastWidth.current) < 1) return;
      measure();
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [enabled, measure, rootRef]);

  return lines;
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function StickyNote({
  factor,
  category,
  canEdit,
  canMove,
  score,
  themed,
  isDragging,
  insertBefore,
  insertAfter,
  isStackTarget,
  onSave,
  onDelete,
  onDragHandle,
  isSaving,
  isDeleting,
}: {
  factor: Factor;
  category: FactorCategory | undefined;
  canEdit: boolean;
  canMove: boolean;
  /** The group's prioritization figure, when there is one to show. */
  score?: NoteScore | null;
  /** True when this note already belongs to a theme. */
  themed?: boolean;
  /** This note is the one in hand — shown as the gap it left behind. */
  isDragging?: boolean;
  /** A drop would insert above / below this note. */
  insertBefore?: boolean;
  insertAfter?: boolean;
  /** A drop would stack onto this note, making a theme of the two. */
  isStackTarget?: boolean;
  onSave: (input: { title: string; description: string }) => void;
  onDelete: () => void;
  /** Starts a drag. Absent when this note cannot be moved. */
  onDragHandle?: ((e: React.PointerEvent, element: HTMLElement) => void) | undefined;
  isSaving?: boolean;
  isDeleting?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [title, setTitle] = useState(factor.title);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  // A decided note is frozen — an approval has to refer to text somebody
  // actually approved. The API enforces this too.
  const decided = factor.state === "approved" || factor.state === "rejected";
  const editable = canEdit && !decided;
  const draggable = canMove && !decided && !editing && Boolean(onDragHandle);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing) setTitle(factor.title);
  }, [factor.title, editing]);

  const clampLines = useSquareClamp(rootRef, textRef, !editing && !expanded);

  // Is there anything hidden? Asked of the rendered box rather than of the
  // character count: whether 180 characters overflow depends on the column
  // width, the font and the theme's line height, so a threshold in characters
  // would show "more" on notes that are complete and hide it on notes that
  // are cut off. The ellipsis and the control must agree, and the box is the
  // only thing that knows.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || editing) return;
    if (expanded) {
      setTruncated(true);
      return;
    }
    setTruncated(el.scrollHeight - el.clientHeight > 1);
  }, [clampLines, expanded, editing, factor.title, factor.description]);

  function commit() {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(factor.title);
      setEditing(false);
      return;
    }
    if (trimmed !== factor.title) {
      onSave({ title: trimmed, description: factor.description ?? "" });
    }
    setEditing(false);
  }

  const tint = category ? `var(--${category.color_token})` : "var(--border)";

  return (
    <div className="relative flex flex-col">
      {/* The insertion line, drawn OUTSIDE the note so it reads as a gap
          opening up between two stickies rather than a border on one of
          them — which is what the gesture actually does. */}
      {insertBefore && <InsertLine tint={tint} where="before" />}

      <div
        ref={rootRef}
        data-note-id={factor.id}
        data-note-category={factor.category_key}
        data-note-themed={themed ? "true" : "false"}
        onPointerDown={(e) => {
          if (!draggable || !rootRef.current) return;
          // An interactive child owns its own press: the delete button and the
          // edit surface must not start a drag.
          if ((e.target as HTMLElement).closest("button,textarea,select,a")) return;
          onDragHandle?.(e, rootRef.current);
        }}
        className={cn(
          // NO ASPECT RATIO AND NO FIXED HEIGHT: the note is as tall as what
          // it holds. The square is enforced on the TEXT, by the clamp, so a
          // short note is a short note. `min-h` keeps a three-word note
          // reading as a sticky rather than as a chip, and is the only
          // dimension the note states for itself.
          "group relative flex min-h-[4.25rem] flex-col rounded-sm border p-2.5",
          "shadow-sm transition-[box-shadow,transform,opacity] duration-150",
          "hover:shadow-md",
          draggable && "cursor-grab",
          isDeleting && "opacity-40",
          // The note in hand leaves a hole where it was, so the wall shows
          // what will close up if it is dropped elsewhere.
          isDragging && "scale-[0.97] opacity-25",
          isStackTarget && "scale-[1.03]",
        )}
        style={{
          // The note is the category's colour, heavily lightened so text stays
          // legible in both themes; the border carries the full hue.
          background: `color-mix(in srgb, ${tint} 14%, var(--card))`,
          borderColor: isStackTarget
            ? tint
            : `color-mix(in srgb, ${tint} 45%, transparent)`,
          ...(isStackTarget
            ? {
                // A real stack: the target shows a second note behind it, so
                // "these two become one theme" is visible before release.
                boxShadow: `6px 6px 0 -2px color-mix(in srgb, ${tint} 30%, var(--card)), 6px 6px 0 -1px ${tint}`,
              }
            : {}),
        }}
      >
        {editing ? (
          <>
            <textarea
              ref={inputRef}
              value={title}
              maxLength={MAX_FACTOR_TITLE}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commit();
                }
                if (e.key === "Escape") {
                  setTitle(factor.title);
                  setEditing(false);
                }
              }}
              // A floor while TYPING only. The note shrinks to its content at
              // rest, but a one-line box to compose 500 characters in is a
              // worse form than a slightly oversized note is a sticky.
              className="min-h-[5rem] flex-1 resize-none bg-transparent text-sm leading-snug outline-none"
              aria-label="Edit note"
            />
            {/* Shown only while typing, and only once it matters, so a short
                note is never nagged about a limit it will not reach. */}
            {title.length > MAX_FACTOR_TITLE - 100 && (
              <span className="shrink-0 pt-1 font-mono text-[9px] tabular-nums text-muted-foreground">
                {MAX_FACTOR_TITLE - title.length} left
              </span>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!editable}
              onClick={() => editable && setEditing(true)}
              className={cn(
                "min-w-0 flex-1 break-words text-left text-sm leading-snug",
                editable ? "cursor-text" : "cursor-default",
              )}
            >
              {/* ONE TEXT FLOW, deliberately. The description was a block
                  child, and `-webkit-line-clamp` counts lines in an
                  inline formatting context — a block inside it clamps
                  unreliably across engines, which would show the ellipsis in
                  the wrong place or not at all. Inline and muted, the
                  qualifier still reads as secondary. */}
              <span
                ref={textRef}
                className="break-words"
                style={
                  expanded || clampLines === null
                    ? undefined
                    : {
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: clampLines,
                        overflow: "hidden",
                      }
                }
              >
                {factor.title}
                {factor.description && (
                  <span className="text-muted-foreground"> — {factor.description}</span>
                )}
              </span>
            </button>

            {/* Only when something is actually hidden. A "more" on a note
                that is already complete is a lie about the note. */}
            {truncated && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-1 shrink-0 self-start text-[10px] font-semibold uppercase tracking-wider text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}

        <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {factor.state !== "approved" && <FactorStatePill state={factor.state} />}
            {score && <ScorePill score={score} tint={tint} />}
            {isSaving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editable && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={`Delete ${factor.title}`}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
              </button>
            )}
            <span
              title={factor.created_by_name ?? "Unknown author"}
              className="grid size-5 place-items-center rounded-full border border-border/60 bg-background/60 font-mono text-[9px] font-semibold text-muted-foreground"
            >
              {initials(factor.created_by_name)}
            </span>
          </div>
        </div>

        {draggable && (
          <GripVertical className="pointer-events-none absolute left-0.5 top-2 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-50" />
        )}
      </div>

      {insertAfter && <InsertLine tint={tint} where="after" />}
    </div>
  );
}

/** The gap a reorder would open. Absolute, so it never shifts the layout. */
function InsertLine({ tint, where }: { tint: string; where: "before" | "after" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex items-center",
        where === "before" ? "-top-1.5 h-3" : "-bottom-1.5 h-3",
      )}
    >
      <span className="size-1.5 rounded-full" style={{ background: tint }} />
      <span className="h-0.5 flex-1 rounded-full" style={{ background: tint }} />
      <span className="size-1.5 rounded-full" style={{ background: tint }} />
    </div>
  );
}

/**
 * The group's figure for this note.
 *
 * TWO NUMBERS, NEVER ONE — the rule the leaderboard and the report already
 * follow. A total alone reads as consensus even when one enthusiast produced
 * it, and on a wall the whole room is looking at, that misreading is the one
 * that matters. The voter count sits beside the total, and the title spells
 * out the denominator rather than spending wall space on it.
 *
 * `perParticipant` is false for a single agreed rating, where "1 voter" would
 * mislead in the other direction — so the count is simply omitted there.
 */
function ScorePill({ score, tint }: { score: NoteScore; tint: string }) {
  const showVoters = score.perParticipant && score.voters > 0;
  const denominator = score.contributors || score.voters;
  const title = showVoters
    ? `${score.name}: ${score.value} from ${score.voters} of ${denominator} ${
        denominator === 1 ? "person who has" : "people who have"
      } allocated`
    : `${score.name}: ${score.value}${score.label ? ` (${score.label})` : ""}`;

  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 py-px font-mono text-[10px] tabular-nums"
      style={{
        borderColor: `color-mix(in srgb, ${tint} 55%, transparent)`,
        background: `color-mix(in srgb, ${tint} 20%, var(--card))`,
      }}
    >
      <span className="font-semibold">{score.value}</span>
      {showVoters && (
        <span className="text-muted-foreground">
          ·{score.voters}
          <span className="sr-only"> contributors</span>
        </span>
      )}
      {!score.perParticipant && score.label && (
        <span className="text-muted-foreground">{score.label}</span>
      )}
    </span>
  );
}
