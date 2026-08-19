import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Gauge,
  Pencil,
  Settings2,
  UserPlus,
  Archive,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AIAssistantPanel, BuildBadge, PanelHeading, StatusPill } from "@/components/workshop-ui";
import { ApprovalQueuePanel } from "@/components/ApprovalQueue";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import {
  activityFeed,
  categoryMeta,
  emergingRisks,
  insights,
  lifecycleStates,
  participants,
  recommendations,
  stageLabels,
  themes,
  workshop,
  type WorkshopStage,
} from "@/lib/workshop-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Workshop Dashboard — SWOT·TOWS Strategy Console" },
      {
        name: "description",
        content:
          "Mission control for a SWOT-TOWS strategy workshop: methodology progress, activity status, intelligence summary, and an AI strategy assistant.",
      },
      { property: "og:title", content: "Workshop Dashboard — SWOT·TOWS Strategy Console" },
      {
        property: "og:description",
        content:
          "Track methodology progress, activity ownership, workshop metrics, and AI-generated themes, insights and recommendations in one command center.",
      },
    ],
  }),
  component: WorkshopDashboard,
});

const stageRoutes: Partial<Record<WorkshopStage, string>> = {
  strengths: "/discovery/strengths",
  weaknesses: "/discovery/weaknesses",
  opportunities: "/discovery/opportunities",
  threats: "/discovery/threats",
  prioritization: "/prioritization",
};

function WorkshopDashboard() {
  const { artifacts, activities, setActivityStatus } = useWorkshop();
  const canEdit = useCan("edit-workshop");
  const canApprove = useCan("approve");

  const completed = activities.filter((a) => a.status === "complete").length;
  const progress = Math.round((completed / activities.length) * 100);
  const votesCast = artifacts.reduce((s, a) => s + a.votes, 0);

  const metrics = [
    { label: "Participants", value: participants.length },
    { label: "Artifacts", value: artifacts.length },
    { label: "Votes Cast", value: votesCast },
    { label: "Themes", value: themes.length },
    { label: "Insights", value: insights.length },
    { label: "Recommendations", value: recommendations.length },
    { label: "Reports", value: 2 },
  ];

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        {/* 1.9 Workshop header */}
        <section className="console-panel overflow-hidden" data-build="mock">
          <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between md:p-5">
            <div className="min-w-0">
              <p className="label-caps">Workshop WS-003</p>
              <h1 className="mt-1 text-xl font-semibold md:text-2xl">{workshop.name}</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{workshop.objective}</p>
              <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Facilitator</dt>
                  <dd className="font-medium">{workshop.facilitator}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="font-medium">{workshop.createdAt}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-muted-foreground">Participants</dt>
                  <dd className="font-medium">{participants.length}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {workshop.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-border bg-elevated px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              {canEdit && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => toast.info("Workshop editor opens here")}>
                    <Pencil className="size-3.5" /> Edit Workshop
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => toast.info("Workshop settings")}>
                    <Settings2 className="size-3.5" /> Settings
                  </Button>
                  <Button size="sm" onClick={() => toast.success("Invitation sent")}>
                    <UserPlus className="size-3.5" /> Invite Participant
                  </Button>
                </>
              )}
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => toast.warning("Archiving requires administrator confirmation")}
                >
                  <Archive className="size-3.5" /> Archive
                </Button>
              )}
            </div>
          </div>

          {/* 1.10 Lifecycle indicator */}
          <div className="flex items-center gap-1 overflow-x-auto border-t border-border bg-sidebar/60 px-4 py-2.5">
            {lifecycleStates.map((state) => {
              const idx = lifecycleStates.indexOf(state);
              const currentIdx = lifecycleStates.indexOf(workshop.status);
              return (
                <span
                  key={state}
                  className={cn(
                    "whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider",
                    idx < currentIdx && "text-success",
                    idx === currentIdx && "bg-primary text-primary-foreground",
                    idx > currentIdx && "text-muted-foreground/60",
                  )}
                >
                  {state}
                </span>
              );
            })}
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            {/* 1.11 Methodology progress */}
            <section className="console-panel" data-build="live">
              <PanelHeading
                build="live"
                title="Methodology Progress"
                hint={`${completed} of ${activities.length} stages complete`}
                action={<span className="font-mono text-sm text-primary">{progress}%</span>}
              />
              <div className="p-4">
                <Progress value={progress} className="h-1.5" />
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {activities.map((a) => {
                    const to = stageRoutes[a.stage];
                    const content = (
                      <div
                        className={cn(
                          "h-full rounded-md border p-2.5 text-left transition-colors",
                          a.status === "complete" && "border-success/40 bg-success/10",
                          a.status === "in-progress" && "border-info/40 bg-info/10",
                          a.status === "blocked" && "border-destructive/40 bg-destructive/10",
                          a.status === "not-started" && "border-border bg-elevated",
                          to && "hover:border-primary/60",
                        )}
                      >
                        <p className="text-xs font-medium">{stageLabels[a.stage]}</p>
                        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {a.status.replace("-", " ")}
                        </p>
                      </div>
                    );
                    return to ? (
                      <Link key={a.id} to={to}>
                        {content}
                      </Link>
                    ) : (
                      <button key={a.id} onClick={() => toast.info(`${stageLabels[a.stage]} workspace is not open yet`)}>
                        {content}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* 1.12 Activity status panel */}
            <section className="console-panel overflow-hidden" data-build="live">
              <PanelHeading title="Activity Status" hint="Ownership and due dates" build="live" />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      {["Activity", "Status", "Owner", "Due Date", ""].map((h) => (
                        <th key={h} className="label-caps px-4 py-2 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activities.map((a) => (
                      <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-elevated/60">
                        <td className="px-4 py-2.5 font-medium">{a.name}</td>
                        <td className="px-4 py-2.5">
                          <StatusPill status={a.status} />
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{a.owner}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{a.dueDate}</td>
                        <td className="px-4 py-2.5 text-right">
                          {stageRoutes[a.stage] ? (
                            <Button asChild variant="ghost" size="sm" className="text-primary">
                              <Link to={stageRoutes[a.stage]!}>
                                {a.status === "complete" ? "Review" : a.status === "in-progress" ? "Resume" : "Open"}
                                <ArrowRight className="size-3.5" />
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={() => setActivityStatus(a.id, "in-progress")}
                            >
                              Start
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 1.13 Metrics */}
            <section className="console-panel" data-build="live">
              <PanelHeading title="Workshop Metrics" hint="Live counts across the methodology" build="live" />
              <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 lg:grid-cols-7">
                {metrics.map((m) => (
                  <div key={m.label} className="bg-card p-3.5">
                    <p className="font-display text-xl font-semibold">{m.value}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{m.label}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* 1.14 Intelligence summary */}
            <section className="console-panel" data-build="mock">
              <PanelHeading title="Intelligence Summary" hint="Static sample data — no generation engine" build="mock" />
              <div className="grid gap-4 p-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <p className="label-caps">Top Themes</p>
                  {themes.slice(0, 3).map((t) => (
                    <div key={t.id} className="rounded-md border border-border bg-elevated p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{t.name}</p>
                        <span className="font-mono text-[11px] text-primary">{t.confidence}%</span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">{t.artifactCount} supporting artifacts</p>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="label-caps">Top Insights</p>
                  {insights.map((i) => (
                    <div key={i.id} className="rounded-md border border-border bg-elevated p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{i.title}</p>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-accent">
                          {i.significance}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Themes: {i.supportingThemes.join(", ")}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="label-caps">Top Recommendations</p>
                  {recommendations.slice(0, 3).map((r) => (
                    <div key={r.id} className="rounded-md border border-border bg-elevated p-3">
                      <p className="text-sm font-medium">{r.text}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {r.priority} priority · {r.insightCount} supporting insights
                      </p>
                    </div>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="label-caps">Emerging Risks</p>
                  {emergingRisks.map((r) => (
                    <div key={r} className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                      <p className="text-xs leading-relaxed">{r}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* Right rail */}
          <div className="space-y-4">
            {/* 1.20 Workshop health */}
            <section className="console-panel" data-build="mock">
              <PanelHeading title="Workshop Health" build="mock" action={<Gauge className="size-4 text-primary" />} />
              <div className="p-4">
                <div className="flex items-end gap-2">
                  <span className="font-display text-4xl font-semibold text-primary">{workshop.healthScore}</span>
                  <span className="pb-1.5 text-sm text-muted-foreground">/ 100</span>
                </div>
                <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-success">Healthy</p>
                <Progress value={workshop.healthScore} className="mt-3 h-1.5" />
                <div className="mt-4 space-y-2">
                  {[
                    { label: "Continue current activity", to: "/discovery/threats" },
                    { label: "Open prioritisation", to: "/prioritization" },
                  ].map((a) => (
                    <Button key={a.label} asChild variant="secondary" size="sm" className="w-full justify-between">
                      <Link to={a.to}>
                        {a.label}
                        <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-between text-muted-foreground"
                    onClick={() => toast.success("Workshop summary queued for generation")}
                  >
                    Generate workshop summary
                    <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            </section>

            <AIAssistantPanel
              context="this workshop's 10 activities and current artifacts"
              quickActions={[
                "What should this team focus on next?",
                "Explain progress",
                "Generate status report",
                "Review workshop quality",
              ]}
            />

            {/* 1.17 Approval queue */}
            <ApprovalQueuePanel />


            {/* 1.16 Participants */}
            <section className="console-panel" data-build="mock">
              <PanelHeading title="Participants" hint={`${participants.length} invited`} build="mock" />
              <div className="max-h-64 divide-y divide-border overflow-y-auto">
                {participants.map((p) => (
                  <div key={p.id} className="flex items-center gap-2.5 px-4 py-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-elevated text-[10px] font-semibold">
                      {p.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{p.name}</p>
                      <p className="text-[11px] capitalize text-muted-foreground">{p.role}</p>
                    </div>
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        p.presence === "online" && "bg-success",
                        p.presence === "idle" && "bg-warning",
                        p.presence === "offline" && "bg-muted-foreground/40",
                      )}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* 1.15 Activity feed */}
            <section className="console-panel" data-build="mock">
              <PanelHeading title="Recent Activity" build="mock" />
              <div className="divide-y divide-border">
                {activityFeed.map((f) => (
                  <div key={f.id} className="px-4 py-2.5">
                    <p className="text-xs leading-relaxed">
                      <span className="font-medium text-primary">{f.actor}</span> {f.text}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{f.time}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="console-panel p-4" data-build="live">
              <div className="flex items-center gap-2">
                <p className="label-caps">Discovery Shortcuts</p>
                <BuildBadge state="live" />
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                {(Object.keys(categoryMeta) as (keyof typeof categoryMeta)[]).map((c) => (
                  <Button key={c} asChild variant="secondary" size="sm" className="justify-start">
                    <Link to="/discovery/$category" params={{ category: categoryMeta[c].slug }}>
                      <span className={categoryMeta[c].color}>●</span>
                      {categoryMeta[c].label}
                    </Link>
                  </Button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
