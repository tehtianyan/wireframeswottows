import { useState } from "react";
import { Check, Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Factor, FactorCategory, FactorState } from "@/lib/api";

// One card shape for every stage that displays a factor — capture, review and
// prioritization all render this. Which controls appear is decided by the
// caller's props, not by the factor's methodology.

const STATE_STYLES: Record<FactorState, { label: string; className: string }> = {
  draft: { label: "Draft", className: "border-border text-muted-foreground" },
  submitted: { label: "In review", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  approved: { label: "Approved", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  rejected: { label: "Rejected", className: "border-destructive/40 text-destructive" },
};

export function FactorStatePill({ state, className }: { state: FactorState; className?: string }) {
  const s = STATE_STYLES[state];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        s.className,
        className,
      )}
    >
      {s.label}
    </span>
  );
}

export function FactorCard({
  factor,
  category,
  showCategory = false,
  canEdit = false,
  onSave,
  onDelete,
  isSaving = false,
  isDeleting = false,
  footer,
  actions,
}: {
  factor: Factor;
  category?: FactorCategory | undefined;
  showCategory?: boolean;
  canEdit?: boolean;
  onSave?: (input: { title: string; description: string }) => void;
  onDelete?: () => void;
  isSaving?: boolean;
  isDeleting?: boolean;
  /** Extra content under the body — e.g. a vote stepper. */
  footer?: React.ReactNode;
  /** Extra controls in the top-right — e.g. approve/reject. */
  actions?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(factor.title);
  const [description, setDescription] = useState(factor.description ?? "");

  // A decided factor is frozen: an approval has to refer to text somebody
  // actually approved. The API enforces this too.
  const editable = canEdit && factor.state !== "approved" && factor.state !== "rejected";

  function save() {
    if (!title.trim() || !onSave) return;
    onSave({ title: title.trim(), description: description.trim() });
    setEditing(false);
  }

  function cancel() {
    setTitle(factor.title);
    setDescription(factor.description ?? "");
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="space-y-2 bg-elevated/40 px-4 py-3">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus />
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={!title.trim() || isSaving}>
            {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("px-4 py-3", isDeleting && "opacity-50")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {showCategory && category && (
              <span
                className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                style={{
                  borderColor: `var(--${category.color_token})`,
                  color: `var(--${category.color_token})`,
                }}
              >
                {category.name}
              </span>
            )}
            <FactorStatePill state={factor.state} />
          </div>
          <p className="text-sm font-medium">{factor.title}</p>
          {factor.description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{factor.description}</p>
          )}
          {factor.review_note && (
            <p className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              Reviewer note: {factor.review_note}
            </p>
          )}
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            {new Date(factor.created_at).toLocaleDateString()} · {factor.votes} vote
            {factor.votes === 1 ? "" : "s"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {editable && onSave && (
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(true)} aria-label="Edit factor">
              <Pencil className="size-3.5" />
            </Button>
          )}
          {editable && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={isDeleting}
              aria-label="Delete factor"
            >
              {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </Button>
          )}
        </div>
      </div>
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
}
