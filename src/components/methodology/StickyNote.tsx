import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, GripVertical, Loader2, Trash2 } from "lucide-react";
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
// IT IS A SQUARE, AND THE SQUARE IS SMALL. Both halves matter, and getting
// one without the other is what produced two wrong versions in a day:
//
//  1. `aspect-square` with one note per row at the full width of its panel.
//     The shape was right and the SIZE was absurd — a three-letter note became
//     a ~300px box of empty colour, so the note said nothing about its
//     content and the wall scrolled as much for short notes as for long ones.
//  2. Dropping the ratio so the box fitted its content. The size was right and
//     the SHAPE was gone: notes became wide rectangles, which is not what a
//     wall of stickies looks like, and they no longer matched the squares
//     inside a theme.
//
// The size was never the ratio's fault — it was the LAYOUT's. The panel now
// lays notes out as a grid of small tiles (`CaptureBoard`), so the square is
// about 120-170px whatever the view, and a square is then the right shape at
// the right size. Nothing here sets a width; the grid does.
//
// So the square is HARD at rest, not a floor: `min-h-0` overrides the
// content-based minimum a flex item would otherwise get, and the note clips.
// Clipping is only acceptable because the clamp below is sized to the box and
// ends in a real ellipsis — the text stops where the reader can see it stops.
// EXPANDING BREAKS THE SQUARE DELIBERATELY: the full note needs somewhere to
// go, and growing the tile is more direct than floating a panel over the wall.

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
 * How many lines of text fit in the space the square leaves for it.
 *
 * MEASURED, NOT A CONSTANT. The tiles are not all the same width — `auto-fill`
 * gives the last column in a row whatever is left over, and a grid-view panel
 * is wider than a column-view one — so a hardcoded `line-clamp-4` would
 * underfill some notes and overflow others.
 *
 * It measures the TEXT'S CONTAINER rather than deriving the space from the
 * note's width minus its chrome. The container is `flex-1 min-h-0` inside a
 * fixed-height box, so its height IS the leftover after the padding and the
 * footer row, whatever those come to — and, crucially, it does not depend on
 * how much text there is. Measuring the text itself and subtracting would be
 * circular: the answer would depend on the clamp that the answer sets.
 *
 * Recomputed on WIDTH changes only, for the same reason.
 */
function useSquareClamp(
  containerRef: React.RefObject<HTMLElement | null>,
  textRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [lines, setLines] = useState<number | null>(null);
  const lastWidth = useRef(0);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const box = container.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;

    // The real line height, so a theme or a font change cannot leave this
    // computing against a figure from a previous design.
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

    lastWidth.current = box.width;
    setLines(Math.max(MIN_NOTE_LINES, Math.floor(box.height / lineHeight)));
  }, [containerRef, textRef]);

  useLayoutEffect(() => {
    if (!enabled) {
      setLines(null);
      return;
    }
    measure();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Width only. See the note above about the feedback loop.
      if (Math.abs(width - lastWidth.current) < 1) return;
      measure();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [enabled, measure, containerRef]);

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
  selected,
  selectable,
  onToggleSelect,
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
  /** Picked out for a bulk action. */
  selected?: boolean;
  /**
   * Selection mode: a plain tap selects rather than opening the editor.
   *
   * THE TOUCH PATH. A modifier-click is the mouse gesture for "and this one
   * too", and a tablet has no modifier key — and a tablet passed round a
   * table is the device this board's drag was rewritten for in the first
   * place. Absent the mode, the checkbox still appears once anything is
   * selected, so the way out is always visible.
   */
  selectable?: boolean;
  onToggleSelect?: (() => void) | undefined;
  /** This note is the one in hand — shown as the gap it left behind. */
  isDragging?: boolean;
  /** A drop would insert above / below this note. */
  insertBefore?: boolean;
  insertAfter?: boolean;
  /** A drop would stack onto this note, making a theme of the two. */
  isStackTarget?: boolean;
  onSave: (input: { title: string; description: string }) => void;
  /**
   * Absent where deletion is not the action. Inside a theme the removal
   * gesture is "take it out of this theme", and a bin icon there used to be
   * rendered and wired to a function that did nothing at all.
   */
  onDelete?: (() => void) | undefined;
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
  const bodyRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  /** Where the press started, so a drag is not also read as a click. */
  const pressRef = useRef<{ x: number; y: number } | null>(null);

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

  const clampLines = useSquareClamp(bodyRef, textRef, !editing && !expanded);

  /** Is the selection checkbox drawn on this note? The text moves if so. */
  const showSelect = Boolean(onToggleSelect) && (Boolean(selectable) || Boolean(selected));

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
          pressRef.current = { x: e.clientX, y: e.clientY };
          if (!draggable || !rootRef.current) return;
          // An interactive child owns its own press: the delete button, the
          // expand chevron and the edit field must not start a drag.
          //
          // THE NOTE'S OWN BODY IS EXEMPT, and that is the whole point. The
          // text button fills the tile, so excluding every button left only
          // the ~10px padding rim draggable — on a 120px note that is a hard
          // target to find, and finding none reads as "this note cannot be
          // moved". It was worst inside a theme, where the note had no drag
          // handle at all, but it was never only a themed-note problem.
          // Click-to-edit still works: a press that does not travel 4px never
          // becomes a drag, and the click below ignores one that did.
          const control = (e.target as HTMLElement).closest("button,textarea,select,a");
          if (control && !control.hasAttribute("data-note-body")) return;
          onDragHandle?.(e, rootRef.current);
        }}
        className={cn(
          "group relative flex flex-col rounded-sm border p-2.5",
          // THE SQUARE, AND WHAT MAKES IT HOLD. `min-h-0` overrides the
          // content-based minimum (`min-height: auto`) that a flex item gets
          // by default — without it, a long note pushes the box past the
          // ratio and the tile stops being square, which is version 1 of this
          // bug. `overflow-hidden` is then safe because the clamp is measured
          // to the box and ends in a visible ellipsis.
          // Expanded, the note drops both and grows to fit: the full text has
          // to go somewhere, and the square is a resting state, not a cage.
          expanded ? "h-auto" : "aspect-square min-h-0 overflow-hidden",
          "shadow-sm transition-[box-shadow,transform,opacity] duration-150",
          "hover:shadow-md",
          draggable && "cursor-grab",
          isDeleting && "opacity-40",
          // The note in hand leaves a hole where it was, so the wall shows
          // what will close up if it is dropped elsewhere.
          isDragging && "scale-[0.97] opacity-25",
          isStackTarget && "scale-[1.03]",
          // A SELECTED NOTE IS RINGED, NOT RECOLOURED. The fill is the
          // category's hue and carries meaning — recolouring it would say
          // the note had changed category. A ring sits outside the tile and
          // leaves the square alone.
          selected && "ring-2 ring-offset-1 ring-offset-background",
        )}
        style={{
          ...(selected ? { ["--tw-ring-color" as string]: "var(--primary)" } : {}),
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
        {/* THE CHECKBOX IS THE VISIBLE WAY IN AND OUT.
            It shows whenever selection mode is on or this note is already
            picked — never permanently, which would put a control on every
            tile of a wall whose whole point is that it reads as paper. It is
            an ordinary button, so the root's pointerdown ignores it and a tap
            here never starts a drag. */}
        {showSelect && (
          <button
            type="button"
            onClick={onToggleSelect}
            aria-pressed={Boolean(selected)}
            aria-label={selected ? `Deselect ${factor.title}` : `Select ${factor.title}`}
            title={selected ? "Deselect this note" : "Select this note"}
            className={cn(
              "absolute left-1 top-1 z-10 grid size-4 place-items-center rounded-[3px] border transition-colors",
              selected
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background/85 text-transparent hover:border-primary",
            )}
          >
            <Check className="size-3" />
          </button>
        )}

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
              ref={bodyRef}
              type="button"
              data-note-body
              // DISABLED ONLY WHEN THERE IS NOTHING IT CAN DO.
              //
              // It was `!editable`, which is most of a real board: on
              // production almost every note is approved and therefore
              // frozen for EDITING. A disabled button fires no click at all,
              // so modifier-clicking one of those to select it did nothing —
              // silently, with the checkbox never appearing to say otherwise.
              // Found by a browser probe; the source checks all passed,
              // because the code said the right thing and the button never
              // got the event.
              //
              // Selecting a frozen note is legitimate: it cannot be edited or
              // recategorised, and it CAN be grouped into a theme, which
              // changes the theme's evidence rather than the note. `moveTo`
              // already skips the frozen ones and says how many it left.
              disabled={!editable && !onToggleSelect}
              onClick={(e) => {
                // A press that travelled was a drag, and a drag must not also
                // open the editor on the way past. Measured against where the
                // press began rather than read off any drag state, so the two
                // cannot disagree about what just happened.
                const from = pressRef.current;
                pressRef.current = null;
                if (from && Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) > 4) {
                  return;
                }
                // SELECTING BEATS EDITING, by modifier or by mode.
                //
                // Ctrl/Cmd and Shift both select, because the two mean the
                // same thing here: there is no "range" on a wall of tiles
                // whose order the reader is not tracking, so offering Shift
                // as a range would promise a selection nobody could predict.
                // Both simply add, which is what people try first.
                if (onToggleSelect && (selectable || e.metaKey || e.ctrlKey || e.shiftKey)) {
                  onToggleSelect();
                  return;
                }
                if (editable) setEditing(true);
              }}
              className={cn(
                // `min-h-0` matters here too: this is what makes the
                // container's height the leftover space rather than the
                // text's own height, which is what useSquareClamp measures.
                "min-h-0 min-w-0 flex-1 break-words text-left text-sm leading-snug",
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
                style={{
                  // THE CHECKBOX SITS ON THE TEXT, SO THE FIRST LINE MOVES
                  // OUT FROM UNDER IT. The box is absolutely positioned in
                  // the tile's top-left corner, which on a 120px note is on
                  // top of the opening words — legible in a screenshot and
                  // not in a code review, which is where it was found.
                  //
                  // `text-indent` and not padding: only the FIRST line is
                  // obstructed, so indenting the whole block would waste a
                  // column of a small tile for the sake of one line. It also
                  // leaves the clamp's measurement alone, which is taken from
                  // the container rather than from this span.
                  ...(showSelect ? { textIndent: "1.15rem" } : {}),
                  ...(expanded || clampLines === null
                    ? {}
                    : {
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: clampLines,
                        overflow: "hidden",
                      }),
                }}
              >
                {factor.title}
                {factor.description && (
                  <span className="text-muted-foreground"> — {factor.description}</span>
                )}
              </span>
            </button>

          </>
        )}

        {/* `overflow-hidden` on the footer, and `shrink-0` on the right-hand
            group: on a 120px tile the two groups otherwise overlap, and the
            delete icon ends up sitting on top of the expand control and
            eating its clicks. Found on production, where every note carries a
            state pill — a board of approved notes never shows it. */}
        <div className="mt-2 flex shrink-0 items-center justify-between gap-1.5 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            {factor.state !== "approved" && (
              <FactorStatePill state={factor.state} compact />
            )}
            {score && <ScorePill score={score} tint={tint} />}
            {isSaving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            {/* THE EXPAND CONTROL LIVES IN THE FOOTER, not under the text,
                and that placement is load-bearing rather than cosmetic. As
                its own row it would take height out of the text container the
                moment it appeared — so the clamp would be measured against a
                box that then shrank, and the ellipsis would land a line
                short. Here, whether it is shown changes nothing about the
                space the text was measured into. A ~140px tile also has no
                vertical room to spare for a text button.
                Only shown when something really is hidden: a "more" on a
                complete note is a lie about the note. */}
            {truncated && !editing && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                aria-label={expanded ? "Show less" : "Show more"}
                title={expanded ? "Show less" : "Show the full note"}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {editable && onDelete && (
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

/**
 * The gap a reorder would open.
 *
 * VERTICAL, matching the axis the drag now reads. The notes are tiles in rows,
 * so an insertion point is a gap between two side-by-side stickies — a
 * horizontal line above the note would point at a place the note is not going.
 * Absolute, so drawing it never shifts the layout it is describing.
 */
function InsertLine({ tint, where }: { tint: string; where: "before" | "after" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 flex w-3 flex-col items-center",
        where === "before" ? "-left-2" : "-right-2",
      )}
    >
      <span className="size-1.5 rounded-full" style={{ background: tint }} />
      <span className="w-0.5 flex-1 rounded-full" style={{ background: tint }} />
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
