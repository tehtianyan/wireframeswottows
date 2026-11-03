import { useEffect, useRef, useState } from "react";
import { GripVertical, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_FACTOR_TITLE } from "@/lib/limits";
import { FactorStatePill } from "./FactorCard";
import type { Factor, FactorCategory } from "@/lib/api";

// One sticky note on the capture board.
//
// The colour is the CATEGORY's own token, so the wall reads by colour without
// anything here knowing what a strength is — a PESTLE board colours itself the
// same way from six different tokens.
//
// IT IS SQUARE, AND THE SQUARE IS A MINIMUM. `aspect-square` makes a short
// note the shape of the physical object it stands for, which is what lets a
// facilitator count and scan a wall at a glance. A long note grows taller
// instead of clipping: `min-height: auto` applies to a box with a preferred
// aspect ratio, so content that does not fit pushes the box down. The shape
// then carries information — a tall note IS a long note — which is the honest
// alternative to hiding text or shrinking it until nobody can read it from
// across the room.

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
  const [title, setTitle] = useState(factor.title);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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
    // `flex flex-col` IS THE SQUARE FLOOR, and the reason is worth stating
    // because it is invisible and easy to delete. `aspect-square` alone makes
    // the note exactly as tall as it is wide and lets longer content overflow
    // — which, with the note's own clipping, would HIDE the end of a 500
    // character note. The content-based minimum that stops that
    // (`min-height: auto`) applies only to a flex or grid ITEM, not to a
    // plain block. Making this wrapper a flex column makes the note an item,
    // so the square becomes a minimum and a long note pushes the box taller.
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
          // No `overflow-hidden`: if the floor above ever failed, clipping
          // would hide the end of a note silently. Overflowing text is ugly
          // and obvious, which is the better failure of the two.
          "group relative flex aspect-square flex-col rounded-sm border p-2.5",
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
              className="min-h-0 flex-1 resize-none bg-transparent text-sm leading-snug outline-none"
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
          <button
            type="button"
            disabled={!editable}
            onClick={() => editable && setEditing(true)}
            className={cn(
              // `break-words` and no clipping: a long note is shown in full
              // and grows the sticky, which is what the square floor is for.
              "flex-1 break-words text-left text-sm leading-snug",
              editable ? "cursor-text" : "cursor-default",
            )}
          >
            {factor.title}
            {factor.description && (
              <span className="mt-1 block text-xs leading-snug text-muted-foreground">
                {factor.description}
              </span>
            )}
          </button>
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
