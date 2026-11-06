import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDot, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { stageAsideFromFlow, RENDERABLE_STAGE_TYPES } from "@/lib/stages";
import { workshopsApi, type Activity, type MethodologyStage, type WorkshopRole } from "@/lib/api";

// THE STAGES, COMPACT (2026-11-06).
//
// UAT: "make the Stages panel more compact instead of a long panel to scroll
// through." SWOT-TOWS has ten stages and a facilitator sees all of them, so the
// old list — one full-width row each, 56px tall, with a type badge, a count, a
// status pill and a chevron — was a 560px scroll to find a word.
//
// It is a WRAPPING GRID OF TILES now, and the reasoning is the capture board's:
// a tile sized to its content, laid out in rows, so the panel grows sideways
// before it grows downwards and the whole flow is visible at once. The number
// leads, because since 20261106100000 the sequence numbers ARE what the room
// says out loud.
//
// What each tile had to keep:
//  * the NUMBER and the NAME. Everything else was secondary.
//  * the STATUS, as a colour and a dot rather than the words "NOT STARTED" —
//    the same move the capture board's note made when an "IN REVIEW" pill ate a
//    third of a 120px tile. The words stay in the tooltip and, for a
//    facilitator, in the control.
//  * the dashed border for a stage outside the participant flow, which is how a
//    facilitator reading "8." in a list that ends at 7 for everyone else is told
//    why rather than left to infer it.
// What it dropped: the stage_type badge (a facilitator reads "Theme Analysis",
// not "synthesize") and the per-stage factor count, which the content count now
// carries for every stage type rather than only for capture.

const STATUS_RING: Record<string, string> = {
  not_started: "border-border text-muted-foreground",
  in_progress: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  completed: "border-emerald-500/50 text-emerald-700 dark:text-emerald-300",
};

const STATUS_WORDS: Record<string, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Complete",
};

export function StageList({
  workshopId,
  stages,
  activityByStage,
  myRole,
  readOnly = false,
}: {
  workshopId: string;
  /** Already filtered to what this role may see, by the caller. */
  stages: MethodologyStage[];
  activityByStage: Map<string, Activity>;
  myRole: WorkshopRole;
  /** True when the workshop is archived: the stages are shown, not changed. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();

  const setComplete = useMutation({
    mutationFn: ({ stageKey, complete }: { stageKey: string; complete: boolean }) =>
      workshopsApi.setStageComplete(workshopId, stageKey, complete),
    onSuccess: (_res, vars) => {
      // The stage list, the dashboard's health score and the workshop summary
      // all read this. Invalidating only `activities` would leave the health
      // score showing the stage progress from before the click, which looks
      // exactly like the save having failed.
      queryClient.invalidateQueries({ queryKey: ["activities", workshopId] });
      queryClient.invalidateQueries({ queryKey: ["workshop-summary", workshopId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(vars.complete ? "Stage closed" : "Stage reopened");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const facilitator = myRole === "facilitator" && !readOnly;

  return (
    <div className="flex flex-wrap gap-2 p-3">
      {stages.map((stage) => {
        const activity = activityByStage.get(stage.key);
        const status = activity?.status ?? "not_started";
        const count = activity?.content_count ?? 0;
        const aside = stageAsideFromFlow(stage);
        const renderable = RENDERABLE_STAGE_TYPES.has(stage.stage_type);
        const pending =
          setComplete.isPending && setComplete.variables?.stageKey === stage.key;

        return (
          <div
            key={stage.key}
            className={cn(
              "group flex min-w-[9.5rem] max-w-[15rem] flex-1 items-start gap-2 rounded border px-2.5 py-2 transition-colors",
              STATUS_RING[status] ?? STATUS_RING["not_started"],
              aside && "border-dashed",
            )}
          >
            <Link
              to="/w/$workshopId/stage/$stageKey"
              params={{ workshopId, stageKey: stage.key }}
              search={{}}
              // The words are here rather than on the tile: a status pill that
              // says NOT STARTED is three times the width of the dot that says
              // the same thing, on a tile whose job is to show the name.
              title={`${stage.name} — ${STATUS_WORDS[status] ?? status}${
                aside ? ", not part of the participant flow" : ""
              }${renderable ? "" : ", no renderer yet"}`}
              className="min-w-0 flex-1"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="font-mono text-[11px] tabular-nums opacity-70">
                  {stage.sequence_number}
                </span>
                <span className="min-w-0 text-xs font-medium leading-snug text-foreground">
                  {stage.name}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                <StatusDot status={status} />
                {/* TWO THINGS, NOT ONE: the state AND what it was derived
                    from. "In progress" beside nothing would be unexplainable,
                    and a count alone would not say whether the room had
                    finished with the stage. */}
                {count > 0 ? `${count} item${count === 1 ? "" : "s"}` : STATUS_WORDS[status]}
              </span>
            </Link>

            {/* CLOSING A STAGE IS A FACILITATOR'S JUDGEMENT, and the only part
                of the status that is stored. No count can mean "the room has
                finished talking about strengths", so it is a decision rather
                than a derivation — and it is reopenable, because a theme often
                sends a facilitator back to capture. */}
            {facilitator && renderable && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  setComplete.mutate({
                    stageKey: stage.key,
                    complete: !(activity?.marked_complete ?? false),
                  })
                }
                title={
                  activity?.marked_complete
                    ? "Reopen this stage"
                    : "Mark this stage complete"
                }
                aria-label={
                  activity?.marked_complete
                    ? `Reopen ${stage.name}`
                    : `Mark ${stage.name} complete`
                }
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-elevated hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : activity?.marked_complete ? (
                  <RotateCcw className="size-3.5" />
                ) : (
                  <Check className="size-3.5" />
                )}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "completed") return <Check className="size-3" aria-hidden="true" />;
  if (status === "in_progress") return <CircleDot className="size-3" aria-hidden="true" />;
  return (
    <span
      className="inline-block size-1.5 rounded-full border border-current"
      aria-hidden="true"
    />
  );
}
