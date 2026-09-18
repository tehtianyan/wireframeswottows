import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BookMarked, Eye, FileText, Loader2, Star } from "lucide-react";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { executiveApi, type ExecItem } from "@/lib/api";

// The Executive Dashboard (wireframe §10).
//
// §10.1: "Executives are not interested in workshop mechanics." So this shows
// only APPROVED output, aggregated across every workshop, and links out to
// detail rather than offering editing. It is a consumption surface.
//
// Section §10.15 asks for a trend direction. With one workshop there is no
// trend, so the page says so rather than drawing an arrow — an invented
// "Increasing" on a single data point is exactly the sort of thing an
// executive would act on and should not.

export const Route = createFileRoute("/executive")({
  component: ExecutivePage,
});

function ExecutivePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["executive"],
    queryFn: () => executiveApi.brief(),
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError || !data) {
    return <p className="p-6 text-sm text-destructive">Could not load the executive brief.</p>;
  }

  const empty =
    data.themes.length === 0 && data.insights.length === 0 && data.recommendations.length === 0;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        <header>
          <h1 className="text-xl font-semibold md:text-2xl">Executive brief</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Approved intelligence across {data.workshops} workshop{data.workshops === 1 ? "" : "s"} ·{" "}
            {data.published_reports} published report{data.published_reports === 1 ? "" : "s"} ·{" "}
            {data.knowledge_assets} knowledge asset{data.knowledge_assets === 1 ? "" : "s"}
          </p>
        </header>

        {empty ? (
          <section className="console-panel p-6 text-center" data-build="live">
            <p className="text-sm text-muted-foreground">
              Nothing has been approved yet. This page shows only reviewed conclusions, so it fills
              in as workshops reach their analysis stages.
            </p>
          </section>
        ) : (
          <>
            {data.alerts.length > 0 && (
              <section className="console-panel" data-build="live">
                <PanelHeading build="live" title="What should concern me" hint={`${data.alerts.length}`} />
                <ul className="divide-y divide-border">
                  {data.alerts.map((a, i) => (
                    <li key={i} className="flex items-start gap-2.5 px-4 py-3">
                      <AlertTriangle
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          a.severity === "attention"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{a.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{a.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* §10.7's three-panel strategic briefing row. */}
            <div className="grid gap-4 xl:grid-cols-3">
              <ItemPanel
                title="Strategic themes"
                subtitle="ranked by supporting evidence"
                items={data.themes}
                metric={(i) => `${i.evidence_count} supporting`}
              />
              <ItemPanel
                title="Recommendations"
                subtitle="by priority"
                items={data.recommendations}
                metric={(i) => i.extra || "—"}
              />
              <ItemPanel
                title="Risks"
                subtitle="recorded against recommendations"
                items={data.risks}
                emptyNote="No risks have been recorded against approved recommendations."
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
              <ItemPanel
                title="Key insights"
                subtitle="ranked by supporting evidence"
                items={data.insights}
                metric={(i) => `${i.evidence_count} supporting`}
                wide
              />

              <div className="space-y-4">
                <section className="console-panel" data-build="live">
                  <PanelHeading build="live" title="Trend" hint="approved insights over time" />
                  <div className="p-4">
                    {data.trend_note ? (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {data.trend_note}
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {data.trend.map((t) => (
                          <li key={t.period} className="flex items-center gap-2">
                            <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground">
                              {t.period}
                            </span>
                            <span
                              className="h-2 rounded-sm bg-foreground/40"
                              style={{
                                width: `${Math.max(
                                  4,
                                  (t.count / Math.max(...data.trend.map((x) => x.count))) * 100,
                                )}%`,
                              }}
                            />
                            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                              {t.count}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </section>

                <section className="console-panel" data-build="live">
                  <PanelHeading build="live" title="Portfolio" hint={`${data.portfolio.length}`} />
                  <ul className="divide-y divide-border">
                    {data.portfolio.map((p) => (
                      <li key={p.id}>
                        <Link
                          to="/w/$workshopId"
                          params={{ workshopId: p.id }}
                          className="block px-4 py-2.5 transition-colors hover:bg-elevated/50"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0 text-xs font-medium">{p.name}</span>
                            <span className="shrink-0 rounded border border-border px-1 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                              {p.status}
                            </span>
                          </div>
                          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                            {p.stages_complete}/{p.stages_total} stages · {p.recommendations} approved
                            recommendation{p.recommendations === 1 ? "" : "s"}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ItemPanel({
  title,
  subtitle,
  items,
  metric,
  emptyNote,
  wide,
}: {
  title: string;
  subtitle: string;
  items: ExecItem[];
  metric?: (item: ExecItem) => string;
  emptyNote?: string;
  wide?: boolean;
}) {
  return (
    <section className="console-panel" data-build="live">
      <PanelHeading build="live" title={title} hint={subtitle} />
      {items.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">
          {emptyNote ?? "Nothing approved yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((i) => (
            <li key={i.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-sm font-medium">{i.title}</p>
                {i.promoted && (
                  <Star
                    className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400"
                    aria-label="In the knowledge library"
                  />
                )}
              </div>
              {i.body && (
                <p className={cn("mt-1 text-xs text-muted-foreground", !wide && "line-clamp-2")}>
                  {i.body}
                </p>
              )}
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {metric ? `${metric(i)} · ` : ""}
                {i.workshop_name}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
