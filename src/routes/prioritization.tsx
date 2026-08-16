import { createFileRoute, Link } from "@tanstack/react-router";
import { Flame, Minus, Plus, Search, Trophy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AIAssistantPanel, BuildBadge, CategoryTag, PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import { categoryMeta, participants, workshop, type SwotCategory } from "@/lib/workshop-data";

export const Route = createFileRoute("/prioritization")({
  head: () => ({
    meta: [
      { title: "Prioritization Workspace — SWOT·TOWS Strategy Console" },
      {
        name: "description",
        content:
          "Converge on strategic priorities: allocate votes across SWOT artifacts, filter by category and tag, and watch live rankings and a heat map update in real time.",
      },
      { property: "og:title", content: "Prioritization Workspace — SWOT·TOWS Strategy Console" },
      {
        property: "og:description",
        content:
          "Vote on SWOT artifacts with allocation limits, live rankings by category, participation tracking, and an AI assistant that explains emerging priorities.",
      },
    ],
  }),
  component: PrioritizationWorkspace,
});

type SortKey = "most" | "least" | "newest" | "alpha";

function PrioritizationWorkspace() {
  const { artifacts, addVote, removeVote, votesUsed, votesRemaining, voteAllocation } = useWorkshop();
  const canVote = useCan("vote");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | SwotCategory>("all");
  const [sort, setSort] = useState<SortKey>("most");
  const [view, setView] = useState<"grid" | "heatmap">("grid");

  const votesCast = artifacts.reduce((s, a) => s + a.votes, 0);
  const participantsVoted = 10 + (votesUsed > 0 ? 1 : 0);
  const participationRate = Math.round((participantsVoted / participants.length) * 100);

  const filtered = artifacts
    .filter((a) => (categoryFilter === "all" ? true : a.category === categoryFilter))
    .filter((a) => {
      const q = query.toLowerCase();
      return (
        !q ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => {
      if (sort === "most") return b.votes - a.votes;
      if (sort === "least") return a.votes - b.votes;
      if (sort === "alpha") return a.title.localeCompare(b.title);
      return a.createdAt.localeCompare(b.createdAt) * -1;
    });

  const maxVotes = Math.max(...artifacts.map((a) => a.votes), 1);

  const rankings = (Object.keys(categoryMeta) as SwotCategory[]).map((c) => ({
    category: c,
    top: artifacts
      .filter((a) => a.category === c)
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 3),
  }));

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        <section className="console-panel p-4 md:p-5" data-build="live">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <span className="label-caps">Activity</span>
              <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">Prioritization</h1>
              <Link to="/" className="mt-1 inline-block text-xs text-primary hover:underline">
                {workshop.name}
              </Link>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Converge on what matters most. Spend your vote allocation across the artifacts that should drive
                strategy. Votes apply immediately — there is no save step.
              </p>
            </div>
            <div className="w-full shrink-0 rounded-md border border-primary/40 bg-primary/10 p-3.5 md:w-56">
              <p className="label-caps">Remaining votes</p>
              <p className="mt-1 font-display text-3xl font-semibold text-primary">{votesRemaining}</p>
              <Progress value={(votesUsed / voteAllocation) * 100} className="mt-2 h-1.5" />
              <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">
                {votesUsed} of {voteAllocation} allocated
              </p>
            </div>
          </div>

          {/* 3.10 Prioritization summary bar */}
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
            {[
              { label: "Votes Remaining", value: votesRemaining },
              { label: "Votes Cast", value: votesCast },
              { label: "Participants Voted", value: `${participantsVoted} / ${participants.length}` },
              { label: "Participation Rate", value: `${participationRate}%` },
            ].map((m) => (
              <div key={m.label} className="bg-card p-3.5">
                <p className="font-display text-lg font-semibold">{m.value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{m.label}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <section className="console-panel" data-build="live">
              <PanelHeading
                build="live"
                title="Prioritization Grid"
                hint={`${filtered.length} artifacts`}
                action={
                  <div className="flex gap-1.5">
                    {(["grid", "heatmap"] as const).map((v) => (
                      <Button
                        key={v}
                        variant={view === v ? "default" : "secondary"}
                        size="sm"
                        className="capitalize"
                        onClick={() => setView(v)}
                      >
                        {v === "heatmap" ? "Heat map" : "Cards"}
                      </Button>
                    ))}
                  </div>
                }
              />

              <div className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search title, description, tags"
                    className="h-9 bg-elevated pl-8 text-xs"
                  />
                </div>
                <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as "all" | SwotCategory)}>
                  <SelectTrigger className="h-9 bg-elevated text-xs sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {(Object.keys(categoryMeta) as SwotCategory[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {categoryMeta[c].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                  <SelectTrigger className="h-9 bg-elevated text-xs sm:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="most">Most votes</SelectItem>
                    <SelectItem value="least">Least votes</SelectItem>
                    <SelectItem value="newest">Newest</SelectItem>
                    <SelectItem value="alpha">Alphabetical</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {view === "grid" ? (
                <div className="grid gap-3 p-4 sm:grid-cols-2">
                  {filtered.map((a) => (
                    <article key={a.id} className="rounded-md border border-border bg-elevated p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <CategoryTag category={a.category} />
                        <span className="font-mono text-[11px] text-muted-foreground">{a.createdAt}</span>
                      </div>
                      <h3 className="mt-2 text-sm font-medium">{a.title}</h3>
                      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {a.description}
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-1">
                        {a.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                        <div>
                          <p className="font-display text-lg font-semibold">{a.votes}</p>
                          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            votes {a.myVotes > 0 && `· ${a.myVotes} yours`}
                          </p>
                        </div>
                        <div className="flex gap-1.5">
                          <Button
                            variant="secondary"
                            size="icon"
                            className="size-8"
                            disabled={!canVote || a.myVotes === 0}
                            onClick={() => removeVote(a.id)}
                            aria-label="Remove vote"
                          >
                            <Minus className="size-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            className="size-8"
                            disabled={!canVote}
                            onClick={() => {
                              if (!addVote(a.id)) toast.error("Maximum available votes reached");
                            }}
                            aria-label="Add vote"
                          >
                            <Plus className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                  {filtered.length === 0 && (
                    <p className="col-span-full py-10 text-center text-xs text-muted-foreground">
                      No artifacts match the current filters.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5 p-4">
                  {filtered.map((a) => (
                    <div key={a.id} className="flex items-center gap-3">
                      <span className="w-44 shrink-0 truncate text-xs sm:w-64">{a.title}</span>
                      <div className="h-6 flex-1 overflow-hidden rounded bg-elevated">
                        <div
                          className={cn(
                            "h-full",
                            a.category === "strength" && "bg-strength/70",
                            a.category === "weakness" && "bg-weakness/70",
                            a.category === "opportunity" && "bg-opportunity/70",
                            a.category === "threat" && "bg-threat/70",
                          )}
                          style={{ width: `${Math.max(4, (a.votes / maxVotes) * 100)}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right font-mono text-xs">{a.votes}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="space-y-4">
            {/* 3.16 Live rankings */}
            <section className="console-panel" data-build="live">
              <PanelHeading
                build="live"
                title="Live Rankings"
                hint="Updates as votes are cast"
                action={<Trophy className="size-4 text-accent" />}
              />
              <div className="divide-y divide-border">
                {rankings.map((r) => (
                  <div key={r.category} className="p-4">
                    <p className="label-caps">Top {categoryMeta[r.category].slug}</p>
                    <ol className="mt-2 space-y-1.5">
                      {r.top.map((a, i) => (
                        <li key={a.id} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{a.title}</span>
                          <span className="font-mono text-[11px] text-primary">{a.votes}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            </section>

            <section className="console-panel p-4" data-build="mock">
              <div className="flex items-center gap-2">
                <Flame className="size-4 text-accent" />
                <p className="label-caps">Convergence signal</p>
                <BuildBadge state="mock" />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Voting is concentrating on customer-facing strengths and platform modernisation. Threat votes remain
                spread thin, which suggests the threat set needs another discovery pass before theming.
              </p>
            </section>

            <AIAssistantPanel
              context="the current vote distribution across all SWOT artifacts"
              quickActions={["Explain progress", "What is converging?", "Identify gaps", "Generate status report"]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
