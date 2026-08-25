import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Check,
  Gauge,
  Pencil,
  Settings2,
  UserPlus,
  Archive,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AIAssistantPanel, BuildBadge, PanelHeading, StatusPill } from "@/components/workshop-ui";
import { ApprovalQueuePanel } from "@/components/ApprovalQueue";
import { ParticipantsPanel } from "@/components/ParticipantsPanel";
import { participantsQueryOptions } from "@/lib/participants";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import {
  categoryMeta,
  emergingRisks,
  insights,
  lifecycleStates,
  recommendations,
  stageLabels,
  themes,
  type ApprovalType,
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
  const { workshop, updateWorkshop, setWorkshopStatus, artifacts, activities, approvals, activityFeed, setActivityStatus } =
    useWorkshop();
  const canEdit = useCan("edit-workshop");
  const { data: people = [] } = useQuery(participantsQueryOptions);

  const completed = activities.filter((a) => a.status === "complete").length;
  const progress = Math.round((completed / activities.length) * 100);
  const votesCast = artifacts.reduce((s, a) => s + a.votes, 0);

  const metrics = [
    { label: "Participants", value: people.length },
    { label: "Artifacts", value: artifacts.length },
    { label: "Votes Cast", value: votesCast },
    { label: "Themes", value: themes.length },
    { label: "Insights", value: insights.length },
    { label: "Recommendations", value: recommendations.length },
    { label: "Reports", value: 2 },
  ];

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: workshop.name,
    objective: workshop.objective,
    tags: workshop.tags.join(", "),
  });

  function openEdit() {
    setEditForm({ name: workshop.name, objective: workshop.objective, tags: workshop.tags.join(", ") });
    setEditOpen(true);
  }

  function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editForm.name.trim()) {
      toast.error("Workshop name is required");
      return;
    }
    updateWorkshop({
      name: editForm.name.trim(),
      objective: editForm.objective.trim(),
      tags: editForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setEditOpen(false);
    toast.success("Workshop details updated");
  }

  const settableStages = lifecycleStates.filter((s) => s !== "Archived");

  const approvalPct = (type: ApprovalType) => {
    const items = approvals.filter((a) => a.type === type);
    if (items.length === 0) return 100;
    return Math.round((items.filter((a) => a.decision === "approved").length / items.length) * 100);
  };
  const votingCoverage = artifacts.length
    ? Math.round((artifacts.filter((a) => a.votes > 0).length / artifacts.length) * 100)
    : 100;
  const participationRate = people.length
    ? Math.round((people.filter((p) => p.presence !== "offline").length / people.length) * 100)
    : 100;

  const healthFactors = [
    { label: "Completion", value: progress, kind: "completion" as const },
    { label: "Participation", value: participationRate, kind: "participation" as const },
    { label: "Voting coverage", value: votingCoverage, kind: "voting" as const },
    { label: "Theme approval", value: approvalPct("Themes"), kind: "approval" as const, approvalType: "Themes" as const },
    {
      label: "Insight approval",
      value: approvalPct("Insights"),
      kind: "approval" as const,
      approvalType: "Insights" as const,
    },
    {
      label: "Recommendation approval",
      value: approvalPct("Recommendations"),
      kind: "approval" as const,
      approvalType: "Recommendations" as const,
    },
  ];
  const healthScore = Math.round(healthFactors.reduce((s, f) => s + f.value, 0) / healthFactors.length);
  const healthStatus = healthScore >= 75 ? "Healthy" : healthScore >= 50 ? "At risk" : "Critical";
  const healthStatusColor =
    healthScore >= 75 ? "text-success" : healthScore >= 50 ? "text-warning" : "text-destructive";

  function explainHealthScore() {
    const weakest = [...healthFactors].sort((a, b) => a.value - b.value)[0]!;
    toast.info(`Workshop health is ${healthScore}/100 (${healthStatus})`, {
      description: `${healthFactors.map((f) => `${f.label} ${f.value}%`).join(" · ")}. Weakest factor: ${weakest.label}.`,
    });
  }

  function improveHealthScore() {
    const weakest = [...healthFactors].sort((a, b) => a.value - b.value)[0]!;
    let suggestion: string;
    if (weakest.kind === "completion") {
      const next = activities.find((a) => a.status !== "complete");
      suggestion = next ? `Close out "${next.name}" to raise completion.` : "All activities are complete.";
    } else if (weakest.kind === "participation") {
      const offline = people.filter((p) => p.presence === "offline").length;
      suggestion =
        offline > 0
          ? `${offline} participant${offline === 1 ? "" : "s"} offline — consider a nudge to re-engage them.`
          : "Participation is already strong.";
    } else if (weakest.kind === "voting") {
      const unvoted = artifacts.filter((a) => a.votes === 0).length;
      suggestion =
        unvoted > 0
          ? `${unvoted} artifact${unvoted === 1 ? "" : "s"} have zero votes — prompt participants to vote.`
          : "All artifacts already have votes.";
    } else {
      const pending = approvals.filter((a) => a.type === weakest.approvalType && a.decision === "pending").length;
      suggestion =
        pending > 0
          ? `${pending} ${weakest.approvalType} item${pending === 1 ? "" : "s"} awaiting approval — visit Pending Approvals.`
          : `${weakest.approvalType} approvals are already caught up.`;
    }
    toast.success("Suggested next step", { description: suggestion });
  }

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        {/* 1.9 Workshop header */}
        <section className="console-panel overflow-hidden" data-build="live">
          <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between md:p-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="label-caps">Workshop WS-003</p>
                <BuildBadge state="live" />
              </div>
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
                  <dd className="font-medium">{people.length}</dd>
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
                  <Button variant="secondary" size="sm" onClick={openEdit}>
                    <Pencil className="size-3.5" /> Edit Workshop
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="secondary" size="sm">
                        <Settings2 className="size-3.5" /> Settings
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {settableStages.map((stage) => (
                        <DropdownMenuItem key={stage} onClick={() => setWorkshopStatus(stage)}>
                          {stage === workshop.status && <Check className="size-3.5" />}
                          {stage}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button asChild size="sm">
                    <a href="#participants">
                      <UserPlus className="size-3.5" /> Invite Participant
                    </a>
                  </Button>
                </>
              )}
              {canEdit && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="text-muted-foreground">
                      <Archive className="size-3.5" /> Archive
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Archive this workshop?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This moves the workshop to the Archived lifecycle stage. Participants will no longer see it
                        as active. This can be reversed later from Settings, but requires administrator access.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => setWorkshopStatus("Archived")}>
                        Archive workshop
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
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

        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <form onSubmit={saveEdit}>
              <DialogHeader>
                <DialogTitle>Edit workshop</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-4">
                <div className="space-y-1.5">
                  <p className="label-caps">Name</p>
                  <Input
                    value={editForm.name}
                    onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                    maxLength={120}
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="label-caps">Objective</p>
                  <Textarea
                    rows={3}
                    value={editForm.objective}
                    onChange={(e) => setEditForm((f) => ({ ...f, objective: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="label-caps">Tags (comma separated)</p>
                  <Input
                    value={editForm.tags}
                    onChange={(e) => setEditForm((f) => ({ ...f, tags: e.target.value }))}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type="submit">Save changes</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

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
            <section className="console-panel" data-build="live">
              <PanelHeading
                title="Workshop Health"
                hint="Computed from live completion, participation, and approval data"
                build="live"
                action={<Gauge className="size-4 text-primary" />}
              />
              <div className="p-4">
                <div className="flex items-end gap-2">
                  <span className={cn("font-display text-4xl font-semibold", healthStatusColor)}>{healthScore}</span>
                  <span className="pb-1.5 text-sm text-muted-foreground">/ 100</span>
                </div>
                <p className={cn("mt-1 font-mono text-[11px] uppercase tracking-wider", healthStatusColor)}>
                  {healthStatus}
                </p>
                <Progress value={healthScore} className="mt-3 h-1.5" />

                <div className="mt-3 space-y-1.5">
                  {healthFactors.map((f) => (
                    <div key={f.label} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-muted-foreground">{f.label}</span>
                      <span className="font-mono">{f.value}%</span>
                    </div>
                  ))}
                </div>

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
                    onClick={explainHealthScore}
                  >
                    Explain score
                    <ArrowRight className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-between text-muted-foreground"
                    onClick={improveHealthScore}
                  >
                    Improve score
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
            <ParticipantsPanel />

            {/* 1.15 Activity feed */}
            <section className="console-panel" data-build="live">
              <PanelHeading title="Recent Activity" hint="Live workshop events" build="live" />
              <div className="divide-y divide-border">
                {activityFeed.slice(0, 10).map((f) => {
                  const body = (
                    <div className="min-w-0">
                      <p className="text-xs leading-relaxed">
                        <span className="font-medium text-primary">{f.actor}</span> {f.text}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{f.time}</p>
                    </div>
                  );

                  if (!f.link) {
                    return (
                      <div key={f.id} className="px-4 py-2.5">
                        {body}
                      </div>
                    );
                  }

                  const rowClasses =
                    "group flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors hover:bg-elevated";
                  const openIcon = (
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  );

                  if (f.link.kind === "approval") {
                    return (
                      <a key={f.id} href="#pending-reviews" className={rowClasses}>
                        {body}
                        {openIcon}
                      </a>
                    );
                  }

                  const searchParams = f.link.kind === "artifact" ? { artifact: f.link.artifactId } : {};

                  return (
                    <Link
                      key={f.id}
                      to="/discovery/$category"
                      params={{ category: categoryMeta[f.link.category].slug }}
                      search={searchParams}
                      className={rowClasses}
                    >
                      {body}
                      {openIcon}
                    </Link>
                  );
                })}
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
