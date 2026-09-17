import { Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FactorStatePill } from "./FactorCard";
import type { CitableItem } from "./useStageObjects";
import type { ObjectKind, WorkObject } from "@/lib/api";

// Display for any reviewable analysis object. Which fields it shows comes
// from the kind's registry entry, so a recommendation renders its priority
// and an insight its significance without this file naming either.

export function ObjectCard({
  object,
  kind,
  citable,
  canEdit,
  canReview,
  onEdit,
  onDelete,
  onReview,
  isBusy,
  extraHeader,
}: {
  object: WorkObject;
  kind: ObjectKind;
  /** Lookup for resolving cited ids to labels. */
  citable: Map<string, CitableItem>;
  canEdit: boolean;
  canReview: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onReview?: (action: "approve" | "reject") => void;
  isBusy?: boolean;
  extraHeader?: React.ReactNode;
}) {
  const decided = object.state === "approved" || object.state === "rejected";
  const citedEntries = Object.entries(object.evidence).filter(([, ids]) => (ids ?? []).length > 0);

  return (
    <div className={cn("px-4 py-3", isBusy && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <FactorStatePill state={object.state} />
            {object.generated_by !== "human" && (
              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {object.generated_by}
              </span>
            )}
            {extraHeader}
          </div>

          {object.title && <p className="text-sm font-medium">{object.title}</p>}
          {object.description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{object.description}</p>
          )}

          {kind.fields.map((f) => {
            const v = object.fields[f.name];
            if (v === null || v === undefined || v === "") return null;
            return (
              <p key={f.name} className="mt-1.5 text-xs">
                <span className="label-caps">{f.label}</span>{" "}
                <span className="text-muted-foreground">{String(v)}</span>
              </p>
            );
          })}

          {citedEntries.length > 0 && (
            <div className="mt-2 border-l-2 border-border pl-2.5">
              <p className="label-caps">Evidence</p>
              <ul className="mt-1 space-y-0.5">
                {citedEntries.flatMap(([, ids]) =>
                  (ids ?? []).map((id) => (
                    <li key={id} className="text-xs text-muted-foreground">
                      · {citable.get(id)?.label ?? <span className="italic">(no longer available)</span>}
                    </li>
                  )),
                )}
              </ul>
            </div>
          )}

          {object.review_note && (
            <p className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
              Reviewer note: {object.review_note}
            </p>
          )}

          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            {new Date(object.created_at).toLocaleDateString()}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {canReview && object.state === "submitted" && onReview && (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-emerald-600"
                onClick={() => onReview("approve")}
                disabled={isBusy}
                aria-label={`Approve ${object.title ?? kind.label}`}
              >
                <Check className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => onReview("reject")}
                disabled={isBusy}
                aria-label={`Reject ${object.title ?? kind.label}`}
              >
                <X className="size-4" />
              </Button>
            </>
          )}
          {canEdit && !decided && onEdit && (
            <Button size="icon" variant="ghost" className="size-7" onClick={onEdit} aria-label="Edit">
              <Pencil className="size-3.5" />
            </Button>
          )}
          {canEdit && object.state !== "approved" && onDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={isBusy}
              aria-label="Delete"
            >
              {isBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
