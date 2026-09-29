import { useEffect, useRef, useState } from "react";
import { GripVertical, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FactorStatePill } from "./FactorCard";
import type { Factor, FactorCategory } from "@/lib/api";

// One sticky note on the capture board.
//
// The colour is the CATEGORY's own token, so the wall reads by colour without
// anything here knowing what a strength is — a PESTLE board colours itself the
// same way from six different tokens.

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
  onSave,
  onDelete,
  onMoveStart,
  isSaving,
  isDeleting,
}: {
  factor: Factor;
  category: FactorCategory | undefined;
  canEdit: boolean;
  canMove: boolean;
  onSave: (input: { title: string; description: string }) => void;
  onDelete: () => void;
  onMoveStart: () => void;
  isSaving?: boolean;
  isDeleting?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(factor.title);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A decided note is frozen — an approval has to refer to text somebody
  // actually approved. The API enforces this too.
  const decided = factor.state === "approved" || factor.state === "rejected";
  const editable = canEdit && !decided;

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
    <div
      draggable={canMove && !decided && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", factor.id);
        e.dataTransfer.effectAllowed = "move";
        onMoveStart();
      }}
      className={cn(
        "group relative rounded-sm border p-2.5 shadow-sm transition-shadow",
        "hover:shadow-md",
        canMove && !decided && !editing && "cursor-grab active:cursor-grabbing",
        isDeleting && "opacity-40",
      )}
      style={{
        // The note is the category's colour, heavily lightened so text stays
        // legible in both themes; the border carries the full hue.
        background: `color-mix(in srgb, ${tint} 14%, var(--card))`,
        borderColor: `color-mix(in srgb, ${tint} 45%, transparent)`,
      }}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          value={title}
          maxLength={120}
          rows={3}
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
          className="w-full resize-none bg-transparent text-sm leading-snug outline-none"
          aria-label="Edit note"
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={() => editable && setEditing(true)}
          className={cn(
            "block w-full text-left text-sm leading-snug",
            editable ? "cursor-text" : "cursor-default",
          )}
        >
          {factor.title}
        </button>
      )}

      {factor.description && !editing && (
        <p className="mt-1 text-xs leading-snug text-muted-foreground">{factor.description}</p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {factor.state !== "approved" && <FactorStatePill state={factor.state} />}
          {isSaving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-1">
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

      {canMove && !decided && (
        <GripVertical className="pointer-events-none absolute -left-1 top-2 size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </div>
  );
}
