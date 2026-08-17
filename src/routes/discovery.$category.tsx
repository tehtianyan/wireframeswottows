import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
  ChevronDown,
  GitMerge,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AIAssistantPanel, CategoryTag, PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { useCan, useWorkshop } from "@/lib/workshop-store";
import {
  categoryMeta,
  participants,
  slugToCategory,
  workshop,
  type Artifact,
  type SwotCategory,
} from "@/lib/workshop-data";

export const Route = createFileRoute("/discovery/$category")({
  loader: ({ params }) => {
    const category = slugToCategory[params.category];
    if (!category) throw notFound();
    return { category };
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [{ title: "Activity unavailable — SWOT·TOWS Console" }, { name: "robots", content: "noindex" }],
      };
    }
    const meta = categoryMeta[loaderData.category];
    const title = `${meta.activity} — SWOT·TOWS Strategy Console`;
    return {
      meta: [
        { title },
        { name: "description", content: meta.guidance },
        { property: "og:title", content: title },
        { property: "og:description", content: meta.guidance },
      ],
    };
  },
  component: DiscoveryWorkspace,
});

function DiscoveryWorkspace() {
  const { category } = Route.useLoaderData();
  const meta = categoryMeta[category];
  const {
    artifacts,
    addArtifact,
    updateArtifact,
    deleteArtifact,
    mergeArtifacts,
    addVote,
    addComment,
  } = useWorkshop();
  const canCreate = useCan("create-artifact");
  const canMerge = useCan("merge");
  const canFacilitate = useCan("close-activity");

  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [locked, setLocked] = useState(false);

  const scoped = artifacts.filter((a) => a.category === category);
  const allTags = useMemo(
    () => Array.from(new Set(scoped.flatMap((a) => a.tags))).sort(),
    [scoped],
  );

  const filtered = scoped.filter((a) => {
    const q = query.toLowerCase();
    const matchesQuery =
      !q ||
      a.title.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some((t) => t.toLowerCase().includes(q));
    const matchesTag = tagFilter === "all" || a.tags.includes(tagFilter);
    return matchesQuery && matchesTag;
  });

  const duplicateCandidate = useMemo(() => {
    const a = scoped[0];
    const b = scoped[1];
    if (!a || !b) return null;
    return { a, b, similarity: 87 };
  }, [scoped]);


  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    addArtifact({
      category,
      title: title.trim().slice(0, 120),
      description: description.trim(),
      tags: tagInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setTitle("");
    setDescription("");
    setTagInput("");
    toast.success("Artifact created");
  }

  const selectedLive = selected ? artifacts.find((a) => a.id === selected.id) ?? null : null;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-[1500px] space-y-4 p-3 md:p-5">
        {/* 2.8 Activity header */}
        <section className="console-panel p-4 md:p-5" data-build="live">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <CategoryTag category={category} />
                <span className="label-caps">Activity</span>
              </div>
              <h1 className="mt-1.5 text-xl font-semibold md:text-2xl">{meta.activity}</h1>
              <Link to="/" className="mt-1 inline-block text-xs text-primary hover:underline">
                {workshop.name}
              </Link>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{meta.guidance}</p>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 md:items-end">
              <p className="font-mono text-xs text-muted-foreground">
                Artifacts created: <span className="text-foreground">{scoped.length}</span>
              </p>
              {canFacilitate && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setLocked((l) => !l);
                      toast.info(locked ? "Editing unlocked" : "Editing locked for participants");
                    }}
                  >
                    <Lock className="size-3.5" /> {locked ? "Unlock editing" : "Lock editing"}
                  </Button>
                  <Button size="sm" onClick={() => toast.success("Activity closed. Ready for prioritisation.")}>
                    Close activity
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* 2.9 Guidance panel */}
          <div className="mt-4 rounded-md border border-border bg-elevated">
            <button
              onClick={() => setGuidanceOpen((o) => !o)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
            >
              <span className="label-caps">Methodology guidance</span>
              <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", guidanceOpen && "rotate-180")} />
            </button>
            {guidanceOpen && (
              <ul className="space-y-1.5 px-3.5 pb-3.5 text-xs leading-relaxed text-muted-foreground">
                <li>• Capture one distinct idea per artifact; avoid compound statements.</li>
                <li>• Add evidence in the description — a number, a date, or a source.</li>
                <li>• Tag artifacts so downstream theme clustering stays accurate.</li>
                <li>• Merge near-duplicates rather than deleting participant contributions.</li>
              </ul>
            )}
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_340px]">
          {/* Left: artifact list + filters */}
          <div className="space-y-4">
            <section className="console-panel" data-build="live">
              <PanelHeading title="Search & Filter" build="live" />
              <div className="space-y-3 p-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Title, description, tags"
                    className="h-9 bg-elevated pl-8 text-xs"
                  />
                </div>
                <Select value={tagFilter} onValueChange={setTagFilter}>
                  <SelectTrigger className="h-9 bg-elevated text-xs">
                    <SelectValue placeholder="All tags" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tags</SelectItem>
                    {allTags.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-1.5">
                  {(["canvas", "list"] as const).map((v) => (
                    <Button
                      key={v}
                      variant={view === v ? "default" : "secondary"}
                      size="sm"
                      className="flex-1 capitalize"
                      onClick={() => setView(v)}
                    >
                      {v}
                    </Button>
                  ))}
                </div>
              </div>
            </section>

            <section className="console-panel" data-build="live">
              <PanelHeading title="Artifact List" hint={`${filtered.length} shown`} build="live" />
              <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
                {filtered.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelected(a)}
                    className="block w-full px-4 py-2.5 text-left hover:bg-elevated"
                  >
                    <p className="truncate text-xs font-medium">{a.title}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {a.votes} votes · {a.author}
                    </p>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">No artifacts match.</p>
                )}
              </div>
            </section>

            {/* 2.27 Live participants */}
            <section className="console-panel" data-build="mock">
              <PanelHeading title="In this activity" hint="Simulated presence" build="mock" />
              <div className="space-y-1.5 p-4">
                {participants
                  .filter((p) => p.presence !== "offline")
                  .map((p) => (
                    <div key={p.id} className="flex items-center gap-2 text-xs">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          p.presence === "online" ? "bg-success" : "bg-warning",
                        )}
                      />
                      <span className="truncate">{p.name}</span>
                      <span className="ml-auto capitalize text-muted-foreground">{p.presence}</span>
                    </div>
                  ))}
              </div>
            </section>
          </div>

          {/* Center: creation + canvas */}
          <div className="space-y-4">
            {/* 2.10 Creation toolbar */}
            <section className="console-panel" data-build="live">
              <PanelHeading
                build="live"
                title="Create Artifact"
                hint={locked && !canFacilitate ? "Editing is locked by the facilitator" : "Title required, max 120 characters"}
              />
              <form onSubmit={submit} className="space-y-3 p-4">
                <Input
                  value={title}
                  maxLength={120}
                  disabled={!canCreate || (locked && !canFacilitate)}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={`e.g. ${category === "strength" ? "Strong customer loyalty" : "Describe the " + category}`}
                  className="bg-elevated"
                />
                <Textarea
                  value={description}
                  disabled={!canCreate || (locked && !canFacilitate)}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description — add evidence, scale, or source (recommended)"
                  className="min-h-20 resize-none bg-elevated text-sm"
                />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={tagInput}
                    disabled={!canCreate || (locked && !canFacilitate)}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="Tags, comma separated"
                    className="bg-elevated"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={!canCreate || (locked && !canFacilitate)}>
                      <Plus className="size-4" /> Add artifact
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setTitle("");
                        setDescription("");
                        setTagInput("");
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">{title.length}/120 characters</p>
              </form>
            </section>

            {/* 2.12 Artifact canvas */}
            <section className="console-panel" data-build="live">
              <PanelHeading
                build="live"
                title="Artifact Canvas"
                hint={`${meta.label} artifacts · ${filtered.length} visible`}
                action={
                  canMerge && duplicateCandidate ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        mergeArtifacts(duplicateCandidate.a.id, duplicateCandidate.b.id);
                        toast.success("Artifacts merged successfully");
                      }}
                    >
                      <GitMerge className="size-3.5" /> Merge duplicates
                    </Button>
                  ) : undefined
                }
              />
              <div className="p-4">
                {filtered.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border py-14 text-center">
                    <p className="text-sm font-medium">No artifacts yet</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Start by capturing one clear {category} above.
                    </p>
                  </div>
                ) : (
                  <div
                    className={cn(
                      view === "canvas" ? "grid gap-3 sm:grid-cols-2" : "space-y-2",
                    )}
                  >
                    {filtered.map((a) => (
                      <article
                        key={a.id}
                        className={cn(
                          "group rounded-md border border-border bg-elevated p-3.5 transition-colors hover:border-primary/50",
                          view === "list" && "flex items-start gap-4",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <button
                              onClick={() => setSelected(a)}
                              className="text-left text-sm font-medium hover:text-primary"
                            >
                              {a.title}
                            </button>
                            {a.aiGenerated && <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />}
                          </div>
                          <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
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
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{a.author}</span>
                            <span>{a.createdAt}</span>
                            <button
                              onClick={() => {
                                if (!addVote(a.id)) toast.error("Maximum available votes reached");
                              }}
                              className="ml-auto rounded px-1.5 py-0.5 font-mono hover:bg-primary/15 hover:text-primary"
                            >
                              +1 · {a.votes}
                            </button>
                            <button
                              onClick={() => setSelected(a)}
                              className="flex items-center gap-1 hover:text-foreground"
                            >
                              <MessageSquare className="size-3" />
                              {a.comments.length}
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Right: AI assistant */}
          <div className="space-y-4">
            <AIAssistantPanel
              context={`${meta.activity} with ${scoped.length} artifacts`}
              quickActions={["Suggest artifacts", "Find duplicates", "Check quality", "Identify gaps"]}
              suggestions={[
                {
                  title: "Suggested artifact",
                  detail:
                    category === "strength"
                      ? "Accredited compliance posture shortens enterprise procurement — consider capturing it explicitly."
                      : `Consider an artifact covering the operational dimension of this ${category}.`,
                },
                duplicateCandidate
                  ? {
                      title: `Possible duplicate · ${duplicateCandidate.similarity}% similar`,
                      detail: `“${duplicateCandidate.a.title}” and “${duplicateCandidate.b.title}” overlap. Merge or ignore.`,
                    }
                  : { title: "No duplicates detected", detail: "Artifact set looks distinct." },
              ]}
            />
          </div>
        </div>
      </div>

      {/* 2.15 Artifact detail drawer */}
      <Sheet open={!!selectedLive} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {selectedLive && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-6 text-base">{selectedLive.title}</SheetTitle>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-8">
                <div className="flex items-center gap-2">
                  <CategoryTag category={selectedLive.category} />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {selectedLive.votes} votes · {selectedLive.author} · {selectedLive.createdAt}
                  </span>
                </div>

                <div className="space-y-2">
                  <p className="label-caps">Description</p>
                  <Textarea
                    value={selectedLive.description}
                    onChange={(e) => updateArtifact(selectedLive.id, { description: e.target.value })}
                    className="min-h-24 bg-elevated text-sm"
                  />
                </div>

                {canMerge && (
                  <div className="space-y-2">
                    <p className="label-caps">Reclassify</p>
                    <Select
                      value={selectedLive.category}
                      onValueChange={(v) => {
                        updateArtifact(selectedLive.id, { category: v as SwotCategory });
                        toast.success("Artifact reclassified");
                      }}
                    >
                      <SelectTrigger className="bg-elevated">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(categoryMeta) as SwotCategory[]).map((c) => (
                          <SelectItem key={c} value={c}>
                            {categoryMeta[c].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="space-y-2">
                  <p className="label-caps">Comments ({selectedLive.comments.length})</p>
                  {selectedLive.comments.map((c) => (
                    <div key={c.id} className="rounded-md border border-border bg-elevated p-2.5">
                      <p className="text-[11px] font-medium">
                        {c.author} <span className="font-normal text-muted-foreground">· {c.createdAt}</span>
                      </p>
                      <p className="mt-1 text-xs leading-relaxed">{c.body}</p>
                    </div>
                  ))}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!commentDraft.trim()) return;
                      addComment(selectedLive.id, commentDraft.trim());
                      setCommentDraft("");
                    }}
                    className="flex gap-2"
                  >
                    <Input
                      value={commentDraft}
                      onChange={(e) => setCommentDraft(e.target.value)}
                      placeholder="Add a comment"
                      className="bg-elevated text-xs"
                    />
                    <Button type="submit" size="sm">
                      Post
                    </Button>
                  </form>
                </div>

                <div className="flex gap-2 border-t border-border pt-4">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      if (!addVote(selectedLive.id)) toast.error("Maximum available votes reached");
                    }}
                  >
                    +1 Vote
                  </Button>
                  {canMerge && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => {
                        deleteArtifact(selectedLive.id);
                        setSelected(null);
                        toast.success("Artifact deleted");
                      }}
                    >
                      <Trash2 className="size-3.5" /> Delete
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
