import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2, ShieldAlert, Sparkles, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  aiApi,
  type CleanupChange,
  type CleanupChangeType,
  type CleanupRun,
  type MethodologyStage,
} from "@/lib/api";

// "Deduplicate and Fix" — the facilitator's one-click tidy-up of the capture
// board, and the record of what it did.
//
// IT WAS "MERGE AND FIX", AND THE VERB WAS THE PROBLEM. On this board "merge"
// already means something else and something visible: dropping one note onto
// another merges them into a THEME. So a button offering to merge read as "do
// that across the whole wall", which is the opposite of what it does —
// grouping notes preserves every one of them, while this folds a duplicate
// away. Facilitators acted on the wrong reading. "Deduplicate" names the
// actual job and collides with nothing.
//
// The panel exists because the changes are APPLIED, not proposed: a wall of
// notes that quietly rewrote itself would be worse than a messy one. So every
// edit is listed with its before-state, the model's reason, and an undo.
//
// Nothing here is methodology-aware. The button appears only when the
// workshop's methodology has a `changeset` prompt configured for this stage
// type, which the server reports as `board_cleanup`.

const LABEL: Record<CleanupChangeType, string> = {
  reword: "Reworded",
  move: "Moved",
  merge: "Merged",
};

export function CleanupPanel({
  workshopId,
  stage,
  isFacilitator,
}: {
  workshopId: string;
  stage: MethodologyStage;
  isFacilitator: boolean;
}) {
  const queryClient = useQueryClient();
  // CLOSED UNTIL THERE IS A REASON. It opened the previous run's full change
  // list on arrival, so a board whose last tidy-up had been undone weeks ago
  // still put ~340px of history between the header and the wall. `run` opens
  // it on success, which is the moment the list is the thing you came for.
  const [open, setOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["ai-status", workshopId, stage.key],
    queryFn: () => aiApi.status(workshopId, stage.key),
  });

  const runsQuery = useQuery({
    queryKey: ["cleanup-runs", workshopId],
    queryFn: () => aiApi.cleanupRuns(workshopId),
    enabled: isFacilitator,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
    queryClient.invalidateQueries({ queryKey: ["cleanup-runs", workshopId] });
  };

  const run = useMutation({
    mutationFn: () => aiApi.cleanup(workshopId, stage.key),
    onSuccess: (r) => {
      refresh();
      setOpen(true);
      toast.success(
        r.changes.length === 0
          ? "Nothing needed changing — the board already reads cleanly."
          : `${r.changes.length} ${r.changes.length === 1 ? "note" : "notes"} tidied. Every change can be undone.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoChange = useMutation({
    mutationFn: (changeId: string) => aiApi.undoCleanupChange(workshopId, changeId),
    onSuccess: () => {
      refresh();
      toast.success("Change undone — the note is back as it was.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const undoRun = useMutation({
    mutationFn: (runId: string) => aiApi.undoCleanupRun(workshopId, runId),
    onSuccess: (r) => {
      refresh();
      if (r.refused.length > 0) {
        // Says plainly that it was partial rather than claiming a reversal
        // that did not fully happen.
        toast.warning(
          `${r.undone} undone; ${r.refused.length} could not be — ${r.refused[0]}`,
        );
      } else {
        toast.success(`${r.undone} ${r.undone === 1 ? "change" : "changes"} undone.`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The latest run is the one worth showing; older ones stay in the API for
  // the audit trail rather than crowding the panel.
  const latest: CleanupRun | undefined = runsQuery.data?.[0];

  if (!isFacilitator || !statusQuery.data?.board_cleanup) return null;

  const busy = run.isPending;
  const configured = statusQuery.data.configured;

  return (
    <section className="console-panel" data-build="live">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-muted-foreground" />
          <span className="label-caps">Tidy the board</span>
        </div>
        <Button size="sm" onClick={() => run.mutate()} disabled={busy || !configured}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          {busy ? "Tidying…" : "Deduplicate and Fix"}
        </Button>
      </div>

      {/* THE EXPLANATION IS BEHIND A DISCLOSURE, not above the board.
          It is four sentences of first-run guidance sitting permanently
          between the facilitator and the wall; once you have run it once you
          know what it does. The refusal, by contrast, always shows — a
          disabled button with its reason hidden is the thing nobody can
          diagnose. */}
      {!configured ? (
        <p className="px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
          The AI assistant is not configured on this server, so the board cannot be tidied
          automatically.
        </p>
      ) : (
        <details className="group">
          <summary className="cursor-pointer list-none px-3.5 py-2 text-[11px] text-muted-foreground hover:text-foreground">
            What does this change?
          </summary>
          <p className="px-3.5 pb-2.5 text-xs leading-relaxed text-muted-foreground">
            Fixes typos, clarifies vague notes, moves misplaced ones and folds near-duplicates
            away — across every panel at once. Changes are applied straight away, listed below,
            and any of them can be undone. Nothing is approved and nothing is deleted.{" "}
            <strong className="font-medium text-foreground">
              This is not the same as grouping notes into a theme:
            </strong>{" "}
            a duplicate is archived, and a note that a theme already cites is never folded away
            at all.
          </p>
        </details>
      )}

      {latest && (latest.changes.length > 0 || latest.skipped.length > 0) && (
        <div className="border-t border-border">
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
          >
            <span className="text-xs text-muted-foreground">
              <Summary run={latest} />
            </span>
            <ChevronDown
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
            />
          </button>

          {open && (
            <div className="space-y-3 border-t border-border/60 px-3.5 py-3">
              {latest.changes.length > 0 && (
                <>
                  <ul className="space-y-2">
                    {latest.changes.map((c) => (
                      <ChangeRow
                        key={c.id}
                        change={c}
                        onUndo={() => undoChange.mutate(c.id)}
                        undoing={undoChange.isPending && undoChange.variables === c.id}
                      />
                    ))}
                  </ul>

                  {latest.changes.some((c) => !c.undone_at) && (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => undoRun.mutate(latest.id)}
                        disabled={undoRun.isPending}
                      >
                        {undoRun.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Undo2 className="size-3.5" />
                        )}
                        Undo all
                      </Button>
                    </div>
                  )}
                </>
              )}

              {latest.skipped.length > 0 && <SkippedList skipped={latest.skipped} />}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Summary({ run }: { run: CleanupRun }) {
  const counts = useMemo(() => {
    const live = run.changes.filter((c) => !c.undone_at);
    return (["reword", "move", "merge"] as CleanupChangeType[])
      .map((t) => ({ t, n: live.filter((c) => c.change_type === t).length }))
      .filter((x) => x.n > 0);
  }, [run.changes]);

  if (counts.length === 0) {
    return <>Last run: everything has been undone.</>;
  }
  return (
    <>
      Last run: {counts.map((c) => `${LABEL[c.t].toLowerCase()} ${c.n}`).join(" · ")}
      {run.skipped.length > 0 && ` · ${run.skipped.length} left alone`}
    </>
  );
}

function ChangeRow({
  change,
  onUndo,
  undoing,
}: {
  change: CleanupChange;
  onUndo: () => void;
  undoing: boolean;
}) {
  const undone = Boolean(change.undone_at);

  return (
    <li
      className={cn(
        "rounded-sm border border-border p-2.5 text-xs",
        undone && "opacity-55",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {LABEL[change.change_type]}
          {undone && " · undone"}
        </span>
        {!undone && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[10px]"
            onClick={onUndo}
            disabled={undoing}
            aria-label={`Undo the change to ${change.factor_title}`}
          >
            {undoing ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />}
            Undo
          </Button>
        )}
      </div>

      <ChangeDetail change={change} />

      {change.reason && (
        <p className="mt-1.5 leading-snug text-muted-foreground">{change.reason}</p>
      )}
    </li>
  );
}

/** before → after, showing only the fields the change actually touched. */
function ChangeDetail({ change }: { change: CleanupChange }) {
  if (change.change_type === "reword") {
    return (
      <div className="mt-1 space-y-0.5 leading-snug">
        <p className="text-muted-foreground line-through">{change.before["title"]}</p>
        <p className="text-foreground">{change.after["title"]}</p>
      </div>
    );
  }
  if (change.change_type === "move") {
    return (
      <p className="mt-1 leading-snug">
        <span className="text-foreground">{change.factor_title}</span>
        <span className="text-muted-foreground">
          {" "}
          — {change.before["category_key"]} → {change.after["category_key"]}
        </span>
      </p>
    );
  }
  return (
    <p className="mt-1 leading-snug">
      <span className="text-foreground">{change.factor_title}</span>
      <span className="text-muted-foreground"> — folded into a note that says the same thing</span>
    </p>
  );
}

/**
 * What the server refused. Shown rather than swallowed: "those two look like
 * duplicates, but one is already cited by a theme" is the facilitator's call
 * to make by hand, and they cannot make it if nobody tells them.
 */
function SkippedList({ skipped }: { skipped: CleanupRun["skipped"] }) {
  return (
    <div className="rounded-sm border border-warning/40 bg-warning/5 p-2.5">
      <div className="flex items-center gap-1.5">
        <ShieldAlert className="size-3.5 text-warning" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Left alone — {skipped.length}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1 text-xs leading-snug text-muted-foreground">
        {skipped.map((s, i) => (
          <li key={`${s.factor_id}-${i}`}>
            {s.title ? <span className="text-foreground">{s.title}</span> : "A proposed change"} —{" "}
            {s.refused}.
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        These are yours to decide on in the Review Board.
      </p>
    </div>
  );
}
