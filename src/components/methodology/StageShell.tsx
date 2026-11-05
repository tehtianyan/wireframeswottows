import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ClipboardCheck, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { stageAsideFromFlow, visibleStages } from "@/lib/stages";
import { BuildBadge } from "@/components/workshop-ui";
import type { Activity, FactorCategory, MethodologyStage, WorkshopDetail } from "@/lib/api";

// The wrapper every wireframe workspace (§1-10) repeats identically: Activity
// Header -> Guidance Panel -> primary content -> AI Assistant slot. Driven
// entirely by the stage/category config passed in — nothing here names a
// methodology.
export function StageShell({
  workshop,
  stage,
  category,
  guidance,
  aiPanel,
  reviewMode = false,
  dense = false,
  children,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
  category?: FactorCategory;
  guidance?: string;
  aiPanel?: ReactNode;
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
              {dense ? (
                // The workshop's name on the same line as the stage's, because
                // the two together are the one thing the header has to say.
                <h1 className="mt-1 text-lg font-semibold">
                  {stage.name}
                  <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">
                    {workshop.name}
                  </span>
                </h1>
              ) : (
                <>
                  <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">{stage.name}</h1>
                  <p className="mt-1 text-xs text-muted-foreground">{workshop.name}</p>
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

            {/* Review Mode is available on every workspace per the wireframe
                spec, so it belongs to the shell rather than to any one stage. */}
            <Link
              to="/w/$workshopId/stage/$stageKey"
              params={{ workshopId: workshop.id, stageKey: stage.key }}
              search={reviewMode ? {} : { mode: "review" as const }}
              className="inline-flex shrink-0 items-center gap-1.5 self-start rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {reviewMode ? <PenLine className="size-3.5" /> : <ClipboardCheck className="size-3.5" />}
              {reviewMode ? "Back to stage" : "Review mode"}
            </Link>
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
            capture board's column view is a strip of FIXED-WIDTH panels, whose
            min-content is their total — so the column grew to ~1252px inside a
            1192px track and pushed the whole document sideways, which is the
            one layout failure that makes the board unusable rather than merely
            ugly.
            It never showed before because `aiPanel` was always passed on this
            stage, and the two-column class brought a `minmax(0,1fr)` track
            whose 0 minimum did this job. Taking the panel out of the board
            stage took the 0 with it. Stated here instead, so it holds at every
            width and for every stage type rather than only where that class
            happens to apply.
            Found by visual-board.js measuring the real document; no source-level
            check would have seen it, and neither did tsc or the build. */}
        <div className={cn("grid gap-4", aiPanel && "xl:grid-cols-[minmax(0,1fr)_340px]")}>
          <div className="min-w-0 space-y-4">{children}</div>
          {aiPanel && <div className="min-w-0 space-y-4">{aiPanel}</div>}
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
