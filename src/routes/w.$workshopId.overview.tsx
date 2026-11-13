import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, History, Loader2, Users } from "lucide-react";
import { PanelHeading } from "@/components/workshop-ui";
import { ActivityList, DrawerLink } from "@/components/DrawerLink";
import { AiInlineActions } from "@/components/methodology/AiInlineActions";
import { ArchiveWorkshopControl } from "@/components/ArchiveWorkshopControl";
import { ParticipantsPanel } from "@/components/ParticipantsPanel";
import { StageList } from "@/components/methodology/StageList";
import { visibleStages } from "@/lib/stages";
import {
  dashboardApi,
  workshopsApi,
  type Activity,
  type MethodologyStage,
  type WorkshopStanding,
  type WorkshopSummary,
} from "@/lib/api";

// Workshop overview: the methodology's stages in order, with the workshop's
// own progress against them. The list is entirely config-driven — a PESTLE
// workshop shows PESTLE's stages here without this file knowing they exist.
//
// IT IS NO LONGER WHERE CLICKING A WORKSHOP LANDS (2026-11-06). UAT: a
// facilitator opening a workshop wants to be in it, and this page sat two
// clicks above the work. `/w/{id}` now redirects to the first stage the caller
// can see; this page moved to `/w/{id}/overview` and is reached from the
// workshop name in the stage header. Nothing was deleted — it carries the
// status, the objective, the archive control, the roster, the trail, the
// metrics and the health score, all of which are about the workshop rather
// than about a step of it.

export const Route = createFileRoute("/w/$workshopId/overview")({
  component: WorkshopOverview,
});

// The stage tiles, their status colours and the "later phase" rule all moved
// into StageList and src/lib/stages.ts — one statement each, read by the stage
// header too, rather than a second copy here that can drift.

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
  // The same rule the stage header's navigation uses, from the same module —
  // two surfaces listing stages by different rules is how one of them ends up
  // offering a stage the other hides.
  const myStages = workshop ? visibleStages(workshop.methodology.stages, workshop.my_role) : [];

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
          <div className="mt-1.5 flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-xl font-semibold md:text-2xl">{workshop.name}</h1>
            {/* Archiving ends a workshop's working life, so it sits with the
                workshop rather than buried in admin — a facilitator finishing
                a workshop should not need an administrator. */}
            {workshop.my_role === "facilitator" && (
              <ArchiveWorkshopControl workshopId={workshop.id} status={workshop.status} />
            )}
          </div>
          {workshop.objective && (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workshop.objective}</p>
          )}
          <p className="mt-3 font-mono text-xs text-muted-foreground">
            {factors.length} factors captured
            {awaitingReview > 0 && ` · ${awaitingReview} awaiting review`}
            {workshop.votes_per_participant > 0 && ` · ${workshop.votes_per_participant} votes per participant`}
          </p>

          {/* THE ROSTER AND THE TRAIL ARE REFERENCE, NOT THE WORK.
              Both were full-width panels on the way to the stages, which is
              the wrong order of attention: you come to this screen to get into
              the workshop, and read who else is in it occasionally. They are
              the same components, in drawers, one line from here. */}
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
            <DrawerLink
              icon={<Users className="size-3.5" />}
              label="Participants"
              count={summaryQuery.data?.participants}
              title="Participants"
              description="Who is in this workshop, and what they may do in it. Roles are enforced by the server, not by this screen."
            >
              <ParticipantsPanel
                workshopId={workshop.id}
                canManage={workshop.my_role === "facilitator"}
                readOnly={workshop.status === "archived"}
              />
            </DrawerLink>

            <DrawerLink
              icon={<History className="size-3.5" />}
              label="Recent activity"
              count={summaryQuery.data?.recent_activity.length}
              title="Recent activity"
              description="The real audit trail for this workshop, newest first."
            >
              <ActivityList events={summaryQuery.data?.recent_activity ?? []} />
            </DrawerLink>
          </div>
        </section>

        {workshop.status === "archived" && (
          <section className="console-panel border-warning/40 bg-warning/5 px-4 py-3" data-build="live">
            <p className="text-sm text-foreground">This workshop is archived and read-only.</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Its reports, themes and knowledge stay fully readable — archiving ends the work, it
              does not hide it. Nothing can be captured, voted on or reviewed until a facilitator
              un-archives it, and that is enforced by the database rather than by this screen.
            </p>
          </section>
        )}

        {/* STAGES FIRST. This is the way in to the work — the capture board,
            the matrix, the report all hang off it — and it used to sit below
            the metrics, the health score, the roster and the activity feed. */}
        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Stages"
            // The count is what THIS role can reach, not what the methodology
            // declares: "10 configured" above a list of seven reads as a
            // rendering fault rather than as a deliberately shorter flow.
            hint={`${myStages.length} configured`}
          />
          <StageList
            workshopId={workshop.id}
            stages={myStages}
            activityByStage={activityByStage}
            myRole={workshop.my_role}
            readOnly={workshop.status === "archived"}
          />
        </section>

        {summaryQuery.data && <SummaryPanels summary={summaryQuery.data} />}

        {/* "Summarize Workshop" — App Spec §13.10 puts its trigger here, on the
            Workshop Overview, and not on a stage panel. It was previously
            offered on every stage, where it produced output the panel could not
            render and nobody could read. */}
        <AiInlineActions workshopId={workshop.id} scope="workshop" label="Where this workshop stands" />
      </div>
    </div>
  );
}

// The workshop dashboard panels from wireframe §1: metrics (§1.13) and health
// (§1.19). Every number is a real count from the API — the earlier mock
// dashboard showed a health score of 84 with nothing behind it.
//
// §1.15's activity feed is still here, in the drawer behind the "Recent
// activity" link at the top: it is reference, and it was occupying a column of
// the page on the way to the stages.
/**
 * What the room has produced, and what is still waiting on somebody.
 *
 * UAT 2026-11-14 asked the Metrics panel to track outstanding participant
 * actions, to show the themes once the capture stages are done and to show the
 * initiatives and actions once the matrix is, "and identify emerging
 * properties"/"identify strategic projects" from each.
 *
 * THE COUNTS ARE HERE; THE READING IS THE ASSISTANT'S. Everything below is
 * arithmetic a facilitator can check against the board — how the themes are
 * spread, how many actions are in each column, how many have nobody's name on
 * them. Naming the emerging properties or the strategic projects is a
 * judgement, and this product puts judgements through the assistant under
 * review rather than printing them as status. "Where this workshop stands",
 * already on this page, is the button that asks for one.
 *
 * EACH ROW APPEARS WHEN ITS WORK DOES. A themes row on a workshop with no
 * themes is a blank the facilitator has to interpret.
 */
function StandingRows({ standing }: { standing: WorkshopStanding }) {
  const themeSpread = Object.entries(standing.themes_by_category);
  const actionStates = Object.entries(standing.actions_by_state);
  const queues = Object.entries(standing.awaiting_review);
  const ownedActions = standing.actions.length - standing.actions_unowned;
  const plannedActions = standing.actions.filter((a) => a.planned).length;

  if (
    themeSpread.length === 0 &&
    standing.actions.length === 0 &&
    queues.length === 0 &&
    standing.themes === 0
  ) {
    return null;
  }

  return (
    <>
      {queues.length > 0 && (
        <div className="border-t border-border p-3.5">
          <p className="label-caps">Waiting on a decision</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {queues.map(([label, n]) => (
              <span key={label} className="inline-flex items-center gap-1.5 text-xs">
                {label}
                <span className="font-mono text-amber-600 dark:text-amber-400">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {standing.themes > 0 && (
        <div className="border-t border-border p-3.5">
          <p className="label-caps">
            Themes <span className="font-mono text-muted-foreground">{standing.themes}</span>
          </p>
          {themeSpread.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {themeSpread.map(([name, n]) => (
                <span key={name} className="inline-flex items-center gap-1.5 text-xs">
                  {name}
                  <span className="font-mono text-muted-foreground">{n}</span>
                </span>
              ))}
            </div>
          ) : null}
          {/* A theme citing notes from more than one category has no single
              home — the matrix reports those separately rather than dropping
              them, and so does this. */}
          {standing.themes > themeSpread.reduce((a, [, n]) => a + n, 0) && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {standing.themes - themeSpread.reduce((a, [, n]) => a + n, 0)} span more than one
              category.
            </p>
          )}
        </div>
      )}

      {standing.actions.length > 0 && (
        <div className="border-t border-border p-3.5">
          <p className="label-caps">
            Actions <span className="font-mono text-muted-foreground">{standing.actions.length}</span>
            {standing.initiatives > 0 && (
              <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                under {standing.initiatives}{" "}
                {standing.initiatives === 1 ? "initiative" : "initiatives"}
              </span>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {actionStates.map(([state, n]) => (
              <span key={state} className="inline-flex items-center gap-1.5 text-xs">
                {state}
                <span className="font-mono text-muted-foreground">{n}</span>
              </span>
            ))}
          </div>
          {/* TWO NUMBERS, NOT ONE. "12 actions" reads as twelve pieces of work
              somebody is doing; twelve with three owners is a different
              finding, and it is the one the facilitator has to act on before
              everybody leaves the room. */}
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {ownedActions} of {standing.actions.length} have an owner · {plannedActions} have
            dates, effort or value
          </p>
        </div>
      )}

      {standing.participants > 0 && standing.contributed < standing.participants && (
        <div className="border-t border-border p-3.5">
          <p className="text-[11px] text-muted-foreground">
            {standing.contributed} of {standing.participants} on the roster have added
            something.
          </p>
        </div>
      )}
    </>
  );
}

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

          {/* WHAT THE ROOM HAS PRODUCED, AND WHAT IS WAITING ON SOMEBODY.
              Appears as the work appears: themes once there are themes, the
              actions once there are actions. A panel of empty rows on a
              workshop that has not started reads as a form somebody failed to
              fill in. (UAT 2026-11-14) */}
          {summary.standing && <StandingRows standing={summary.standing} />}
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
