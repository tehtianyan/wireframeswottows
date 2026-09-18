import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { PanelHeading } from "@/components/workshop-ui";
import { ParticipantsPanel } from "@/components/ParticipantsPanel";
import { cn } from "@/lib/utils";
import {
  dashboardApi,
  describeActivity,
  workshopsApi,
  type Activity,
  type MethodologyStage,
  type WorkshopSummary,
} from "@/lib/api";

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

// Every stage type now has a renderer. `knowledge` is the one exception —
// the Knowledge Workspace is explicitly deferred (CLAUDE.md, Phase 5).
const RENDERABLE = new Set([
  "capture", "prioritize", "synthesize", "relate", "interpret", "recommend", "report",
]);

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
  const summaryQuery = useQuery({
    queryKey: ["workshop-summary", workshopId],
    queryFn: () => dashboardApi.workshopSummary(workshopId),
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

        {summaryQuery.data && <SummaryPanels summary={summaryQuery.data} />}

        {/* Real Supabase-backed roster. Invite rights come from the caller's
            actual workshop role, not a UI toggle. */}
        <ParticipantsPanel
          voteAllocation={workshop.votes_per_participant}
          canManage={workshop.my_role === "facilitator"}
        />

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

// The workshop dashboard panels from wireframe §1: metrics (§1.13), health
// (§1.19) and the activity feed (§1.15). Every number is a real count from
// the API — the earlier mock dashboard showed a health score of 84 with
// nothing behind it.
function SummaryPanels({ summary }: { summary: WorkshopSummary }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <section className="console-panel" data-build="live">
          <PanelHeading build="live" title="Metrics" hint="live counts" />
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3">
            {summary.counts.map((c) => (
              <div key={c.kind} className="bg-background p-3.5">
                <p className="font-mono text-2xl font-semibold tabular-nums">{c.total}</p>
                <p className="label-caps mt-0.5">{c.label}</p>
                {c.awaiting_review > 0 && (
                  <p className="mt-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                    {c.awaiting_review} in review
                  </p>
                )}
              </div>
            ))}
            <div className="bg-background p-3.5">
              <p className="font-mono text-2xl font-semibold tabular-nums">{summary.participants}</p>
              <p className="label-caps mt-0.5">Participants</p>
            </div>
          </div>

          {summary.factors_by_category.length > 0 && (
            <div className="border-t border-border p-3.5">
              <p className="label-caps">By category</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                {summary.factors_by_category.map((c) => (
                  <span key={c.key} className="inline-flex items-center gap-1.5 text-xs">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: `var(--${c.color_token})` }}
                    />
                    {c.name}
                    <span className="font-mono text-muted-foreground">{c.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="console-panel" data-build="live">
          <PanelHeading build="live" title="Recent activity" hint="from the audit trail" />
          {summary.recent_activity.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">Nothing has happened yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {summary.recent_activity.map((e, i) => (
                <li key={i} className="px-4 py-2.5">
                  <p className="text-xs">
                    <span className="font-medium">{e.actor_name}</span>{" "}
                    <span className="text-muted-foreground">{describeActivity(e)}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="console-panel" data-build="live">
        <PanelHeading build="live" title="Workshop health" hint={`${summary.health_score}/100`} />
        <div className="p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums">
              {summary.health_score}
            </span>
            <span className="text-xs text-muted-foreground">/ 100</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full bg-foreground/60 transition-all"
              style={{ width: `${summary.health_score}%` }}
            />
          </div>
          {/* The score is the mean of the signals below, minus a penalty for a
              review backlog. Shown so it can be acted on, not admired. */}
          <ul className="mt-3 space-y-2.5">
            {summary.health_signals.map((sig) => (
              <li key={sig.key}>
                <div className="flex items-center justify-between">
                  <span className="label-caps">{sig.label}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {sig.value}
                    {sig.target > 0 && sig.key !== "review" ? ` / ${sig.target}` : ""}
                    {sig.key === "review" ? "%" : ""}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {sig.message}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
