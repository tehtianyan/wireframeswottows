import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ClipboardCheck, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import {
  dashboardApi,
  describeActivity,
  type DashboardWorkshop,
} from "@/lib/api";

// The dashboard — "what requires my attention today?" (CLAUDE.md).
//
// This replaces the earlier mock screen, which ran entirely on static arrays
// and showed figures like "Reports: 2" that were literals. Everything here is
// the real API: real workshops, real counts, and an activity feed that is the
// actual audit trail rather than a sample.
//
// Workshop-specific detail lives at /w/{id}; this page is deliberately
// cross-workshop.

export const Route = createFileRoute("/")({
  component: DashboardPage,
});

const STATUS_STYLES: Record<string, string> = {
  draft: "border-border text-muted-foreground",
  configured: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  active: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  analysis: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  reporting: "border-violet-500/40 text-violet-600 dark:text-violet-400",
  completed: "border-border text-muted-foreground",
  archived: "border-border text-muted-foreground",
};

function DashboardPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboardApi.get(),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError || !data) {
    return <p className="p-6 text-sm text-destructive">Could not load your dashboard.</p>;
  }

  const needsReview = data.workshops.filter((w) => w.awaiting_review > 0);

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1400px] space-y-4 p-3 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold md:text-2xl">Dashboard</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.workshops.length === 0
                ? "You are not a member of any workshop yet."
                : data.awaiting_my_review > 0
                  ? `${data.awaiting_my_review} item${data.awaiting_my_review === 1 ? "" : "s"} waiting on your review.`
                  : "Nothing is waiting on your review."}
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/w/new">
              <Plus className="size-3.5" />
              New workshop
            </Link>
          </Button>
        </div>

        {data.workshops.length === 0 ? (
          <section className="console-panel p-6 text-center" data-build="live">
            <p className="text-sm text-muted-foreground">
              Create a workshop to get started, or ask a facilitator to invite you to one.
            </p>
            <Button asChild size="sm" className="mt-3">
              <Link to="/w/new">Create your first workshop</Link>
            </Button>
          </section>
        ) : (
          <>
            {needsReview.length > 0 && (
              <section className="console-panel" data-build="live">
                <PanelHeading
                  build="live"
                  title="Waiting on you"
                  hint={`${data.awaiting_my_review} across ${needsReview.length} workshop${needsReview.length === 1 ? "" : "s"}`}
                />
                <div className="divide-y divide-border">
                  {needsReview.map((w) => (
                    <Link
                      key={w.id}
                      to="/w/$workshopId"
                      params={{ workshopId: w.id }}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated/50"
                    >
                      <ClipboardCheck className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{w.name}</span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {w.awaiting_review} awaiting review · you are {w.my_role}
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              </section>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <section className="console-panel" data-build="live">
                <PanelHeading
                  build="live"
                  title="Your workshops"
                  hint={`${data.workshops.length} total`}
                />
                <div className="divide-y divide-border">
                  {data.workshops.map((w) => (
                    <WorkshopRow key={w.id} workshop={w} />
                  ))}
                </div>
              </section>

              <section className="console-panel" data-build="live">
                <PanelHeading
                  build="live"
                  title="Recent activity"
                  hint={`${data.recent_activity.length} events`}
                />
                {data.recent_activity.length === 0 ? (
                  <p className="p-4 text-xs text-muted-foreground">
                    Nothing has happened yet in your workshops.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.recent_activity.map((e, i) => (
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
          </>
        )}
      </div>
    </div>
  );
}

function WorkshopRow({ workshop: w }: { workshop: DashboardWorkshop }) {
  const progress = w.stages_total > 0 ? (w.stages_complete / w.stages_total) * 100 : 0;

  return (
    <Link
      to="/w/$workshopId"
      params={{ workshopId: w.id }}
      className="block px-4 py-3.5 transition-colors hover:bg-elevated/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{w.name}</p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {w.methodology_name} · you are {w.my_role}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            STATUS_STYLES[w.status] ?? "border-border text-muted-foreground",
          )}
        >
          {w.status}
        </span>
      </div>

      <div className="mt-2.5">
        <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>
            {w.stages_complete} of {w.stages_total} stages
          </span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-elevated">
          <div className="h-full bg-foreground/50 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {/* Counts come from the object registry, so a new object kind appears
          here without this component changing. */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {w.counts
          .filter((c) => c.total > 0)
          .map((c) => (
            <span key={c.kind} className="font-mono text-[10px] text-muted-foreground">
              {c.total} {c.label.toLowerCase()}
              {c.awaiting_review > 0 && (
                <span className="text-amber-600 dark:text-amber-400"> · {c.awaiting_review} in review</span>
              )}
            </span>
          ))}
        {w.counts.every((c) => c.total === 0) && (
          <span className="font-mono text-[10px] text-muted-foreground">nothing captured yet</span>
        )}
      </div>
    </Link>
  );
}
