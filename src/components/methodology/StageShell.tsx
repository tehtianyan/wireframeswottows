import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ClipboardCheck, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { stageAsideFromFlow, visibleStages } from "@/lib/stages";
import { BuildBadge } from "@/components/workshop-ui";
import type { Activity, FactorCategory, MethodologyStage, WorkshopDetail } from "@/lib/api";

// The wrapper every wireframe workspace (§1-10) repeats identically: Activity
// Header -> Guidance Panel -> primary content, with the AI assistant offered
// from the header. Driven entirely by the stage/category config passed in —
// nothing here names a methodology.
//
// THERE IS NO AI COLUMN ANY MORE (2026-11-07). It was a 340px track beside the
// content on every stage type but the capture board, which gave it up on
// 2026-11-05 — so the move was half-made, and the half that remained spent a
// quarter of a 1192px screen on a panel of one or two buttons. `assistant` is
// the same panel behind a header button; see StageAssistant for why the trigger
// has to know whether there is anything behind it.
export function StageShell({
  workshop,
  stage,
  category,
  guidance,
  assistant,
  reviewMode = false,
  dense = false,
  children,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
  category?: FactorCategory;
  guidance?: string;
  /** The stage's AI actions, as a header control. Renders itself or nothing. */
  assistant?: ReactNode;
  reviewMode?: boolean;
  /**
   * The content IS the screen — used by the capture board.
   *
   * The header is the same information, taking about a third of the height:
   * the objective moves behind a disclosure and the whole block tightens. On a
   * stage whose whole point is seeing four panels of notes at once, a header
   * that pushes the bottom two below the fold defeats the stage.
   */
  dense?: boolean;
  children: ReactNode;
}) {
  // Open by default, EXCEPT on a dense stage. Guidance is worth reading once
  // and then in the way.
  const [guidanceOpen, setGuidanceOpen] = useState(!dense);
  const accentStyle = category ? ({ "--stage-accent": `var(--${category.color_token})` } as React.CSSProperties) : undefined;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className={cn("mx-auto max-w-[1500px] p-3 md:p-5", dense ? "space-y-3" : "space-y-4")}>
        <section
          className={cn("console-panel", dense ? "p-3 md:p-4" : "p-4 md:p-5")}
          data-build="live"
          style={accentStyle}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {category && (
                  <span
                    className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                    style={{ borderColor: "var(--stage-accent)", color: "var(--stage-accent)" }}
                  >
                    {category.name}
                  </span>
                )}
                <span className="label-caps">Stage {stage.sequence_number}</span>
                <BuildBadge state="live" />
              </div>
              {/* THE WORKSHOP'S NAME IS THE WAY BACK TO THE OVERVIEW.
                  Since `/w/{id}` redirects into stage 1, this is the only route
                  to the status, the objective, the roster, the trail, the
                  metrics and the archive control. It has to be a real link or
                  that page becomes unreachable — the same shape as a control
                  rendered and wired to nothing. */}
              {dense ? (
                // The workshop's name on the same line as the stage's, because
                // the two together are the one thing the header has to say.
                <h1 className="mt-1 text-lg font-semibold">
                  {stage.name}
                  <Link
                    to="/w/$workshopId/overview"
                    params={{ workshopId: workshop.id }}
                    title="Workshop overview"
                    className="ml-2 align-middle text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {workshop.name}
                  </Link>
                </h1>
              ) : (
                <>
                  <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">{stage.name}</h1>
                  <Link
                    to="/w/$workshopId/overview"
                    params={{ workshopId: workshop.id }}
                    title="Workshop overview"
                    className="mt-1 inline-block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {workshop.name}
                  </Link>
                </>
              )}
              {workshop.objective &&
                (dense ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer list-none text-[11px] text-muted-foreground hover:text-foreground">
                      Objective
                    </summary>
                    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                      {workshop.objective}
                    </p>
                  </details>
                ) : (
                  <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workshop.objective}</p>
                ))}
            </div>

            {/* The stage's own controls. Review Mode is available on every
                workspace per the wireframe spec, and the assistant is now
                offered the same way, so both belong to the shell rather than to
                any one stage. */}
            <div className="flex shrink-0 items-center gap-2 self-start">
              {assistant}
              <Link
                to="/w/$workshopId/stage/$stageKey"
                params={{ workshopId: workshop.id, stageKey: stage.key }}
                search={reviewMode ? {} : { mode: "review" as const }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {reviewMode ? <PenLine className="size-3.5" /> : <ClipboardCheck className="size-3.5" />}
                {reviewMode ? "Back to stage" : "Review mode"}
              </Link>
            </div>
          </div>

          {/* Stage navigation, built from methodology config — the order and
              the names are whatever the methodology declares, filtered to the
              stages this role sees (src/lib/stages.ts owns that rule).

              ONE INLINE LIST, in the methodology's real sequence. A
              facilitator sees the three stages outside the participant flow
              in place, marked, rather than in a group of their own — so the
              numbers on screen are the numbers the room says out loud, and a
              facilitator reading "9." in a list that ends at 7 for everybody
              else is told why. */}
          <nav
            className={cn("flex flex-wrap gap-1.5", dense ? "mt-2.5" : "mt-4")}
            aria-label="Methodology stages"
          >
            {visibleStages(workshop.methodology.stages, workshop.my_role).map((s) => {
              const aside = stageAsideFromFlow(s);
              return (
                <Link
                  key={s.key}
                  to="/w/$workshopId/stage/$stageKey"
                  params={{ workshopId: workshop.id, stageKey: s.key }}
                  search={{}}
                  title={aside ? `${s.name} — not part of the participant flow` : s.name}
                  className={cn(
                    "rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                    s.key === stage.key
                      ? "border-foreground/30 bg-foreground/10 text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                    // Dashed, because the stage is reachable but off the path.
                    aside && s.key !== stage.key && "border-dashed",
                  )}
                >
                  {aside && <span aria-hidden="true">· </span>}
                  {s.sequence_number}. {s.name}
                </Link>
              );
            })}
          </nav>

          {guidance && (
            <div className={cn("rounded-md border border-border bg-elevated", dense ? "mt-2.5" : "mt-4")}>
              <button
                onClick={() => setGuidanceOpen((o) => !o)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
              >
                <span className="label-caps">Methodology guidance</span>
                <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", guidanceOpen && "rotate-180")} />
              </button>
              {guidanceOpen && (
                <p className="px-3.5 pb-3.5 text-xs leading-relaxed text-muted-foreground">{guidance}</p>
              )}
            </div>
          )}
        </section>

        {/* `min-w-0` IS LOAD-BEARING, and it was being supplied by accident.
            A grid item's default `min-width` is `auto`, so this column refuses
            to shrink below the min-content width of whatever is in it. The
            capture board's column view is a strip of panels with a minimum
            width each, whose min-content is their total — so the column grew to
            ~1252px inside a 1192px track and pushed the whole document
            sideways, which is the one layout failure that makes the board
            unusable rather than merely ugly.
            It never showed before because `aiPanel` was always passed on this
            stage, and the two-column class brought a `minmax(0,1fr)` track
            whose 0 minimum did this job. Taking the panel out of the board
            stage took the 0 with it. Stated here instead, so it holds at every
            width and for every stage type rather than only where that class
            happens to apply — including now that the AI column is gone from all
            of them and no `minmax(0,1fr)` is left anywhere to supply it.
            Found by visual-board.js measuring the real document; no source-level
            check would have seen it, and neither did tsc or the build. */}
        <div className="grid gap-4">
          <div className="min-w-0 space-y-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

// Small shared progress readout used in the header of most stages.
export function StageProgress({ activities, currentStageKey }: { activities: Activity[]; currentStageKey: string }) {
  const completed = activities.filter((a) => a.status === "completed").length;
  return (
    <p className="font-mono text-xs text-muted-foreground">
      {completed} of {activities.length} stages complete
      {activities.find((a) => a.stage_key === currentStageKey) &&
        ` · this stage: ${activities.find((a) => a.stage_key === currentStageKey)!.status.replace("_", " ")}`}
    </p>
  );
}
