import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { FactorCard } from "./FactorCard";
import { canReview, workshopsApi, type FactorState, type Methodology, type WorkshopRole } from "@/lib/api";

// The Review Board (wireframe: "SWOT Review Board"). Despite that name it is
// not SWOT-specific: it reviews whatever factor categories the workshop's
// methodology defines, so PESTLE gets a six-column review board from the same
// component with no changes.

type ReviewFilter = Extract<FactorState, "submitted" | "approved" | "rejected"> | "all";

const FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: "submitted", label: "Awaiting review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export function ReviewBoard({
  workshopId,
  methodology,
  myRole,
}: {
  workshopId: string;
  methodology: Methodology;
  myRole: WorkshopRole;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ReviewFilter>("submitted");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const reviewer = canReview(myRole);

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
  });

  const review = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; note?: string }) =>
      workshopsApi.reviewFactor(workshopId, v.id, {
        action: v.action,
        ...(v.note ? { note: v.note } : {}),
      }),
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
      setRejecting(null);
      setNote("");
      toast.success(v.action === "approve" ? "Factor approved" : "Factor rejected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const visible = useMemo(() => {
    const all = factorsQuery.data ?? [];
    return filter === "all" ? all : all.filter((f) => f.state === filter);
  }, [factorsQuery.data, filter]);

  const counts = useMemo(() => {
    const all = factorsQuery.data ?? [];
    return {
      submitted: all.filter((f) => f.state === "submitted").length,
      approved: all.filter((f) => f.state === "approved").length,
      rejected: all.filter((f) => f.state === "rejected").length,
      all: all.length,
    };
  }, [factorsQuery.data]);

  const categoryByKey = useMemo(
    () => new Map(methodology.factor_categories.map((c) => [c.key, c])),
    [methodology.factor_categories],
  );

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="Review board"
        hint={`${counts.submitted} awaiting review of ${counts.all}`}
      />

      <div className="flex flex-wrap gap-1.5 border-b border-border bg-elevated/40 p-3">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              filter === f.key
                ? "border-foreground/30 bg-foreground/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {!reviewer && (
        <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          Only a facilitator or analyst can approve or reject factors. You are viewing this board read-only.
        </p>
      )}

      <div className="divide-y divide-border">
        {factorsQuery.isLoading && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {factorsQuery.isError && <p className="p-4 text-xs text-destructive">Could not load factors.</p>}
        {!factorsQuery.isLoading && visible.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">
            {filter === "submitted"
              ? "Nothing is waiting for review. Every captured factor has been decided on."
              : "No factors in this state."}
          </p>
        )}

        {visible.map((f) => (
          <div key={f.id}>
            <FactorCard
              factor={f}
              category={categoryByKey.get(f.category_key)}
              showCategory
              actions={
                reviewer && f.state === "submitted" ? (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-emerald-600"
                      onClick={() => review.mutate({ id: f.id, action: "approve" })}
                      disabled={review.isPending}
                      aria-label={`Approve ${f.title}`}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setRejecting(rejecting === f.id ? null : f.id);
                        setNote("");
                      }}
                      disabled={review.isPending}
                      aria-label={`Reject ${f.title}`}
                    >
                      <X className="size-4" />
                    </Button>
                  </>
                ) : null
              }
            />

            {rejecting === f.id && (
              <div className="space-y-2 border-t border-border bg-elevated/40 px-4 py-3">
                <label className="label-caps" htmlFor={`reject-note-${f.id}`}>
                  Reason for rejection
                </label>
                <Textarea
                  id={`reject-note-${f.id}`}
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="A rejection has to say why — the note is kept with the factor."
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!note.trim() || review.isPending}
                    onClick={() => review.mutate({ id: f.id, action: "reject", note: note.trim() })}
                  >
                    {review.isPending && <Loader2 className="size-3.5 animate-spin" />}
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
