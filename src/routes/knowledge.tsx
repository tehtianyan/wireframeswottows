import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, ChevronRight, Loader2, Search, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { knowledgeApi, type KnowledgeHit, type TraceResult } from "@/lib/api";

// The Knowledge Workspace (App Spec §2.12, §6.15) — "organizational memory",
// and per the spec the thing that "differentiates the application from
// traditional workshop tools".
//
// Search spans every workshop the caller belongs to and nothing else; the
// scoping is done in the query, not filtered afterwards. The kinds listed
// here come from the object registry via the API, so a new object kind
// becomes searchable without this file changing.

export const Route = createFileRoute("/knowledge")({
  component: KnowledgePage,
});

const KIND_LABELS: Record<string, string> = {
  factor: "Factors",
  synthesis: "Themes",
  factor_relationship: "Relationships",
  insight: "Insights",
  recommendation: "Recommendations",
  report: "Reports",
};

function KnowledgePage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [kind, setKind] = useState("");
  const [promotedOnly, setPromotedOnly] = useState(false);
  const [selected, setSelected] = useState<KnowledgeHit | null>(null);

  const searchQuery = useQuery({
    queryKey: ["knowledge-search", submitted, kind, promotedOnly],
    queryFn: () =>
      knowledgeApi.search({
        ...(submitted ? { q: submitted } : {}),
        ...(kind ? { object_type: kind } : {}),
        ...(promotedOnly ? { promoted: true } : {}),
      }),
  });

  const assetsQuery = useQuery({
    queryKey: ["knowledge-assets"],
    queryFn: () => knowledgeApi.assets(),
  });

  const promote = useMutation({
    mutationFn: (hit: KnowledgeHit) =>
      knowledgeApi.promote({ object_kind: hit.object_kind, object_id: hit.object_id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-search"] });
      queryClient.invalidateQueries({ queryKey: ["knowledge-assets"] });
      toast.success("Added to the knowledge library as a candidate");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publish = useMutation({
    mutationFn: (id: string) => knowledgeApi.publish(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge-assets"] });
      toast.success("Published as organizational knowledge");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hits = searchQuery.data ?? [];
  const candidates = (assetsQuery.data ?? []).filter((a) => a.state === "candidate");
  const published = (assetsQuery.data ?? []).filter((a) => a.state === "published");

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1400px] space-y-4 p-3 md:p-5">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Knowledge</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Everything from every workshop you belong to. Promote what is worth remembering —
            not everything should be.
          </p>
        </div>

        <section className="console-panel" data-build="live">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3.5">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setSubmitted(query.trim())}
                placeholder="Search everything…"
                className="pl-8"
              />
            </div>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-2 text-xs"
              aria-label="Filter by type"
            >
              <option value="">All types</option>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant={promotedOnly ? "default" : "outline"}
              onClick={() => setPromotedOnly((p) => !p)}
            >
              <Star className="size-3.5" />
              Promoted only
            </Button>
            <Button size="sm" onClick={() => setSubmitted(query.trim())}>
              Search
            </Button>
          </div>

          <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="bg-background">
              <PanelHeading
                build="live"
                title={submitted ? `Results for "${submitted}"` : "Everything"}
                hint={`${hits.length} item${hits.length === 1 ? "" : "s"}`}
              />
              {searchQuery.isLoading ? (
                <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Searching…
                </div>
              ) : hits.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">
                  {submitted ? "Nothing matched." : "Nothing captured yet in your workshops."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {hits.map((h) => (
                    <li key={`${h.object_kind}:${h.object_id}`}>
                      <button
                        onClick={() => setSelected(h)}
                        className={cn(
                          "w-full px-4 py-3 text-left transition-colors hover:bg-elevated/50",
                          selected?.object_id === h.object_id && "bg-elevated/60",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5">
                              <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                                {h.object_kind.replace("_", " ")}
                              </span>
                              {h.promoted && (
                                <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
                                  <Star className="size-2.5" />
                                  knowledge
                                </span>
                              )}
                            </div>
                            <p className="text-sm font-medium">{h.title}</p>
                            {h.snippet && (
                              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {h.snippet}
                              </p>
                            )}
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                              {h.workshop_name} · {h.state} ·{" "}
                              {new Date(h.created_at).toLocaleDateString()}
                            </p>
                          </div>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-background">
              {selected ? (
                <DetailPanel
                  hit={selected}
                  onPromote={() => promote.mutate(selected)}
                  isPromoting={promote.isPending}
                />
              ) : (
                <>
                  <PanelHeading build="live" title="Knowledge library" hint={`${published.length} published`} />
                  <div className="p-4">
                    {candidates.length > 0 && (
                      <div className="mb-4">
                        <p className="label-caps">Candidates</p>
                        <ul className="mt-1.5 space-y-2">
                          {candidates.map((a) => (
                            <li key={a.id} className="rounded-md border border-border p-2.5">
                              <p className="text-xs font-medium">{a.title}</p>
                              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                                {a.object_kind} · {a.workshop_name}
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-1.5 w-full"
                                onClick={() => publish.mutate(a.id)}
                                disabled={publish.isPending}
                              >
                                Publish
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <p className="label-caps">Published</p>
                    {published.length === 0 ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Nothing has been promoted yet. Promotion is deliberate — it is what keeps
                        this library worth reading.
                      </p>
                    ) : (
                      <ul className="mt-1.5 space-y-2">
                        {published.map((a) => (
                          <li key={a.id} className="rounded-md border border-border p-2.5">
                            <div className="flex items-start gap-1.5">
                              <BookMarked className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
                              <div className="min-w-0">
                                <p className="text-xs font-medium">{a.title}</p>
                                {a.summary && (
                                  <p className="mt-0.5 text-[11px] text-muted-foreground">{a.summary}</p>
                                )}
                                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                                  {a.object_kind} · {a.workshop_name}
                                </p>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function DetailPanel({
  hit,
  onPromote,
  isPromoting,
}: {
  hit: KnowledgeHit;
  onPromote: () => void;
  isPromoting: boolean;
}) {
  const traceQuery = useQuery({
    queryKey: ["knowledge-trace", hit.object_kind, hit.object_id],
    queryFn: () => knowledgeApi.trace(hit.object_kind, hit.object_id),
  });
  const relatedQuery = useQuery({
    queryKey: ["knowledge-related", hit.object_kind, hit.object_id],
    queryFn: () => knowledgeApi.related(hit.object_kind, hit.object_id),
  });

  const trace: TraceResult | undefined = traceQuery.data;
  const levels = Object.entries(trace?.levels ?? {});

  return (
    <>
      <PanelHeading build="live" title="Related intelligence" hint={hit.object_kind.replace("_", " ")} />
      <div className="space-y-4 p-4">
        <div>
          <p className="text-sm font-medium">{hit.title}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {hit.workshop_name} · {hit.state}
          </p>
        </div>

        {/* §11.26's traceability chain, walked through the registry's own
            evidence links rather than a fixed recommendation→…→factor list. */}
        <div>
          <p className="label-caps">Evidence chain</p>
          {traceQuery.isLoading ? (
            <p className="mt-1.5 text-xs text-muted-foreground">Loading…</p>
          ) : levels.length === 0 ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              This rests on nothing else — it is a captured factor, not a derived conclusion.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-2">
              {levels.map(([kind, nodes]) => (
                <li key={kind}>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {kind.replace("_", " ")}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {nodes.map((n) => (
                      <li key={n.object_id} className="text-xs">
                        · {n.title}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(relatedQuery.data ?? []).length > 0 && (
          <div>
            <p className="label-caps">Shares evidence with</p>
            <ul className="mt-1.5 space-y-0.5">
              {(relatedQuery.data ?? []).map((n) => (
                <li key={n.object_id} className="text-xs">
                  · {n.title}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-border pt-3">
          {hit.promoted ? (
            <p className="text-xs text-muted-foreground">
              Already in the knowledge library.
            </p>
          ) : (
            <>
              <Button size="sm" className="w-full" onClick={onPromote} disabled={isPromoting}>
                {isPromoting ? <Loader2 className="size-3.5 animate-spin" /> : <Star className="size-3.5" />}
                Promote to knowledge
              </Button>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                Only approved output can be promoted, and only an analyst may do it — curation is a
                separate job from running the workshop.
              </p>
            </>
          )}
        </div>

        <Link
          to="/w/$workshopId"
          params={{ workshopId: hit.workshop_id }}
          className="block text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Open {hit.workshop_name} →
        </Link>
      </div>
    </>
  );
}
