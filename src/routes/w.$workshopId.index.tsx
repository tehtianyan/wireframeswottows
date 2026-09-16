import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { workshopsApi, type Activity, type MethodologyStage } from "@/lib/api";

// Workshop overview: the methodology's stages in order, with the workshop's
// own progress against them. The list is entirely config-driven — a PESTLE
// workshop shows PESTLE's stages here without this file knowing they exist.

export const Route = createFileRoute("/w/$workshopId/")({
  component: WorkshopOverview,
});

const STATUS_STYLES: Record<string, string> = {
  not_started: "border-border text-muted-foreground",
  in_progress: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  completed: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
};

// Stage types the generic renderer can currently display. The rest are
// reachable but show a "coming in a later phase" panel.
const RENDERABLE = new Set(["capture", "prioritize"]);

function WorkshopOverview() {
  const { workshopId } = Route.useParams();

  const workshopQuery = useQuery({
    queryKey: ["workshop", workshopId],
    queryFn: () => workshopsApi.get(workshopId),
  });
  const activitiesQuery = useQuery({
    queryKey: ["activities", workshopId],
    queryFn: () => workshopsApi.activities(workshopId),
  });
  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
  });

  if (workshopQuery.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (workshopQuery.isError || !workshopQuery.data) {
    return <p className="p-6 text-sm text-destructive">Could not load this workshop.</p>;
  }

  const workshop = workshopQuery.data;
  const activityByStage = new Map<string, Activity>(
    (activitiesQuery.data ?? []).map((a) => [a.stage_key, a]),
  );
  const factors = factorsQuery.data ?? [];
  const awaitingReview = factors.filter((f) => f.state === "submitted").length;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1100px] space-y-4 p-3 md:p-5">
        <section className="console-panel p-4 md:p-5" data-build="live">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps">{workshop.methodology.name}</span>
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {workshop.status}
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              you: {workshop.my_role}
            </span>
          </div>
          <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">{workshop.name}</h1>
          {workshop.objective && (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workshop.objective}</p>
          )}
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            {factors.length} factors captured
            {awaitingReview > 0 && ` · ${awaitingReview} awaiting review`}
            {workshop.votes_per_participant > 0 && ` · ${workshop.votes_per_participant} votes per participant`}
          </p>
        </section>

        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Stages"
            hint={`${workshop.methodology.stages.length} configured`}
          />
          <div className="divide-y divide-border">
            {workshop.methodology.stages.map((stage) => (
              <StageRow
                key={stage.key}
                workshopId={workshop.id}
                stage={stage}
                activity={activityByStage.get(stage.key)}
                factorCount={
                  typeof stage.config["factor_category_key"] === "string"
                    ? factors.filter((f) => f.category_key === stage.config["factor_category_key"]).length
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function StageRow({
  workshopId,
  stage,
  activity,
  factorCount,
}: {
  workshopId: string;
  stage: MethodologyStage;
  activity: Activity | undefined;
  factorCount: number | undefined;
}) {
  const status = activity?.status ?? "not_started";
  const renderable = RENDERABLE.has(stage.stage_type);

  return (
    <Link
      to="/w/$workshopId/stage/$stageKey"
      params={{ workshopId, stageKey: stage.key }}
      search={{}}
      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated/50"
    >
      <span className="w-6 shrink-0 font-mono text-xs text-muted-foreground">{stage.sequence_number}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-sm font-medium">{stage.name}</p>
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {stage.stage_type}
          </span>
          {!renderable && (
            <span className="font-mono text-[10px] text-muted-foreground">later phase</span>
          )}
        </div>
        {factorCount !== undefined && (
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{factorCount} captured</p>
        )}
      </div>
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
          STATUS_STYLES[status] ?? "border-border text-muted-foreground",
        )}
      >
        {status.replace("_", " ")}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}
