import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ClipboardCheck, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
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
  children,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
  category?: FactorCategory;
  guidance?: string;
  aiPanel?: ReactNode;
  reviewMode?: boolean;
  children: ReactNode;
}) {
  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const accentStyle = category ? ({ "--stage-accent": `var(--${category.color_token})` } as React.CSSProperties) : undefined;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        <section className="console-panel p-4 md:p-5" data-build="live" style={accentStyle}>
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
              <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">{stage.name}</h1>
              <p className="mt-1 text-xs text-muted-foreground">{workshop.name}</p>
              {workshop.objective && (
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workshop.objective}</p>
              )}
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
              the names are whatever the methodology declares. */}
          <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Methodology stages">
            {workshop.methodology.stages.map((s) => (
              <Link
                key={s.key}
                to="/w/$workshopId/stage/$stageKey"
                params={{ workshopId: workshop.id, stageKey: s.key }}
                search={{}}
                className={cn(
                  "rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                  s.key === stage.key
                    ? "border-foreground/30 bg-foreground/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {s.sequence_number}. {s.name}
              </Link>
            ))}
          </nav>

          {guidance && (
            <div className="mt-4 rounded-md border border-border bg-elevated">
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

        <div className={cn("grid gap-4", aiPanel && "xl:grid-cols-[minmax(0,1fr)_340px]")}>
          <div className="space-y-4">{children}</div>
          {aiPanel && <div className="space-y-4">{aiPanel}</div>}
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
