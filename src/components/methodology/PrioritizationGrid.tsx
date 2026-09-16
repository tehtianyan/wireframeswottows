import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { FactorStatePill } from "./FactorCard";
import {
  canVote,
  workshopsApi,
  type Factor,
  type FactorCategory,
  type Methodology,
  type MethodologyStage,
  type VoteSummary,
  type WorkshopRole,
} from "@/lib/api";

// The prioritize stage (wireframe §3, App Spec §6.7). It renders one column
// per factor category the methodology defines — four for SWOT-TOWS, six for
// PESTLE — and takes its vote budget from the stage config, never a constant.

export function PrioritizationGrid({
  workshopId,
  methodology,
  stage,
  myRole,
}: {
  workshopId: string;
  methodology: Methodology;
  stage: MethodologyStage;
  myRole: WorkshopRole;
}) {
  const queryClient = useQueryClient();
  const voter = canVote(myRole);

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
  });
  const votesQuery = useQuery({
    queryKey: ["votes", workshopId],
    queryFn: () => workshopsApi.votes(workshopId),
  });

  const setVote = useMutation({
    mutationFn: (v: { factorId: string; value: number }) =>
      workshopsApi.setVote(workshopId, v.factorId, v.value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["votes", workshopId] });
      queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const myVotes = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of votesQuery.data?.allocations ?? []) m.set(a.factor_id, a.vote_value);
    return m;
  }, [votesQuery.data]);

  // Only factors that survived review are worth spending votes on. A
  // methodology whose capture stage auto-approves simply never produces
  // anything in 'submitted', and this filter is a no-op.
  const eligible = useMemo(
    () => (factorsQuery.data ?? []).filter((f) => f.state !== "rejected"),
    [factorsQuery.data],
  );

  const summary: VoteSummary | undefined = votesQuery.data;
  const remaining = summary ? summary.remaining : 0;

  // The stage's own declared budget, shown when it differs from nothing —
  // this is what makes the number config rather than code.
  const configuredBudget =
    typeof stage.config["votes_per_participant"] === "number"
      ? (stage.config["votes_per_participant"] as number)
      : undefined;

  if (factorsQuery.isLoading || votesQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading prioritization…
        </div>
      </section>
    );
  }

  if (summary && summary.budget === 0) {
    return (
      <section className="console-panel p-4">
        <p className="text-sm text-muted-foreground">
          This methodology's prioritization stage does not allocate votes.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="console-panel" data-build="live">
        <PanelHeading
          build="live"
          title="Your vote budget"
          {...(summary ? { hint: `${summary.used} of ${summary.budget} allocated` } : {})}
        />
        <div className="p-4">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "font-mono text-3xl font-semibold tabular-nums",
                remaining === 0 && "text-muted-foreground",
              )}
            >
              {remaining}
            </span>
            <span className="text-xs text-muted-foreground">votes remaining</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full bg-foreground/60 transition-all"
              style={{ width: summary && summary.budget > 0 ? `${(summary.used / summary.budget) * 100}%` : "0%" }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {configuredBudget !== undefined
              ? `${methodology.name} allocates ${configuredBudget} votes per participant.`
              : "Spread your votes across the factors you believe matter most."}
            {!voter && " Your role is view-only, so you cannot allocate votes."}
          </p>
        </div>
      </section>

      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 260px), 1fr))`,
        }}
      >
        {methodology.factor_categories.map((category) => (
          <CategoryColumn
            key={category.key}
            category={category}
            factors={eligible.filter((f) => f.category_key === category.key)}
            myVotes={myVotes}
            canVote={voter && remaining >= 0}
            remaining={remaining}
            onChange={(factorId, value) => setVote.mutate({ factorId, value })}
            isPending={setVote.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryColumn({
  category,
  factors,
  myVotes,
  canVote: votingAllowed,
  remaining,
  onChange,
  isPending,
}: {
  category: FactorCategory;
  factors: Factor[];
  myVotes: Map<string, number>;
  canVote: boolean;
  remaining: number;
  onChange: (factorId: string, value: number) => void;
  isPending: boolean;
}) {
  return (
    <section
      className="console-panel"
      data-build="live"
      style={{ "--stage-accent": `var(--${category.color_token})` } as React.CSSProperties}
    >
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span
          className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          style={{ borderColor: "var(--stage-accent)", color: "var(--stage-accent)" }}
        >
          {category.name}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{factors.length}</span>
      </div>

      <div className="divide-y divide-border">
        {factors.length === 0 && (
          <p className="p-3.5 text-xs text-muted-foreground">No factors captured in this category.</p>
        )}
        {factors.map((f) => {
          const mine = myVotes.get(f.id) ?? 0;
          return (
            <div key={f.id} className="px-3.5 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 flex-1 text-sm font-medium">{f.title}</p>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{f.votes}</span>
              </div>
              {f.state !== "approved" && <FactorStatePill state={f.state} className="mt-1.5" />}

              <div className="mt-2 flex items-center gap-1.5">
                <Button
                  size="icon"
                  variant="outline"
                  className="size-6"
                  disabled={!votingAllowed || mine === 0 || isPending}
                  onClick={() => onChange(f.id, mine - 1)}
                  aria-label={`Remove a vote from ${f.title}`}
                >
                  <Minus className="size-3" />
                </Button>
                <span className="w-6 text-center font-mono text-xs tabular-nums">{mine}</span>
                <Button
                  size="icon"
                  variant="outline"
                  className="size-6"
                  disabled={!votingAllowed || remaining <= 0 || isPending}
                  onClick={() => onChange(f.id, mine + 1)}
                  aria-label={`Add a vote to ${f.title}`}
                >
                  <Plus className="size-3" />
                </Button>
                <span className="ml-1 text-[10px] text-muted-foreground">your votes</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
