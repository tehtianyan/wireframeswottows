import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { ObjectCard } from "./ObjectCard";
import { useStageObjects } from "./useStageObjects";
import {
  canReview as roleCanReview,
  objectsApi,
  workshopsApi,
  type Factor,
  type MethodologyStage,
  type RelationshipType,
  type WorkshopDetail,
} from "@/lib/api";

// The relate stage. For SWOT-TOWS this renders the familiar SO / ST / WO / WT
// matrix — but nothing here knows those names. Each cell is a row from
// methodology_relationship_types, and the factors offered in a cell are
// filtered by that row's declared source and target categories.
//
// A methodology with no relate stage never reaches this component, and one
// with three relationship types gets three cells.

export function RelationshipMatrix({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const [openCell, setOpenCell] = useState<string | null>(null);

  const { kind, allCitable, objects, isLoading } = useStageObjects(workshop, stage);

  const factorsQuery = useQuery({
    queryKey: ["factors", workshop.id, "all"],
    queryFn: () => workshopsApi.factors(workshop.id),
  });

  const reviewer = roleCanReview(workshop.my_role);
  const contributor = workshop.my_role === "facilitator" || workshop.my_role === "analyst";

  const categoryById = useMemo(
    () => new Map(workshop.methodology.factor_categories.map((c) => [c.id, c])),
    [workshop.methodology.factor_categories],
  );

  const factorsByCategoryId = useMemo(() => {
    const m = new Map<string, Factor[]>();
    for (const c of workshop.methodology.factor_categories) m.set(c.id, []);
    for (const f of factorsQuery.data ?? []) {
      if (f.state === "rejected") continue;
      const cat = workshop.methodology.factor_categories.find((c) => c.key === f.category_key);
      if (cat) m.get(cat.id)!.push(f);
    }
    return m;
  }, [factorsQuery.data, workshop.methodology.factor_categories]);

  const review = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; note?: string }) =>
      objectsApi.review(workshop.id, kind!.route, v.id, {
        action: v.action,
        ...(v.note ? { note: v.note } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => objectsApi.remove(workshop.id, kind!.route, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
      toast.success("Removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || factorsQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading matrix…
        </div>
      </section>
    );
  }
  if (!kind) {
    return (
      <section className="console-panel p-4">
        <p className="text-sm text-destructive">Could not load this stage.</p>
      </section>
    );
  }

  const types = workshop.methodology.relationship_types;
  if (types.length === 0) {
    return (
      <section className="console-panel p-4">
        <p className="text-sm text-muted-foreground">
          {workshop.methodology.name} defines no relationship types, so there is no matrix to build.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="console-panel" data-build="live">
        <PanelHeading build="live" title="Relationship matrix" hint={`${objects.length} created`} />
        <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          Each cell pairs factors from two categories. The pairing rules come from the methodology, so only
          valid combinations are offered.
        </p>

        <div
          className="grid gap-px bg-border"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}
        >
          {types.map((type) => {
            const cellObjects = objects.filter((o) => o.relationship_type_id === type.id);
            const sourceCat = categoryById.get(type.source_category_id);
            const targetCat = categoryById.get(type.target_category_id);
            return (
              <div key={type.id} className="bg-background">
                <div className="border-b border-border px-3.5 py-2.5">
                  <p className="text-sm font-medium">{type.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {sourceCat?.name ?? "?"} × {targetCat?.name ?? "?"} · {cellObjects.length}
                  </p>
                  {type.guidance_text && (
                    <p className="mt-1 text-xs text-muted-foreground">{type.guidance_text}</p>
                  )}
                </div>

                <div className="divide-y divide-border">
                  {cellObjects.map((o) => (
                    <ObjectCard
                      key={o.id}
                      object={o}
                      kind={kind}
                      citable={allCitable}
                      canEdit={contributor}
                      canReview={reviewer}
                      onDelete={() => remove.mutate(o.id)}
                      onReview={(action) =>
                        action === "approve"
                          ? review.mutate({ id: o.id, action })
                          : review.mutate({ id: o.id, action, note: "Rejected from the matrix view" })
                      }
                      isBusy={remove.isPending || review.isPending}
                      extraHeader={
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {labelFor(o.source_id, factorsQuery.data)} → {labelFor(o.target_id, factorsQuery.data)}
                        </span>
                      }
                    />
                  ))}
                  {cellObjects.length === 0 && (
                    <p className="px-3.5 py-3 text-xs text-muted-foreground">Nothing paired yet.</p>
                  )}
                </div>

                {contributor && (
                  <div className="border-t border-border p-2.5">
                    {openCell === type.id ? (
                      <PairForm
                        workshopId={workshop.id}
                        route={kind.route}
                        type={type}
                        sources={factorsByCategoryId.get(type.source_category_id) ?? []}
                        targets={factorsByCategoryId.get(type.target_category_id) ?? []}
                        onDone={() => {
                          setOpenCell(null);
                          queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
                        }}
                        onCancel={() => setOpenCell(null)}
                      />
                    ) : (
                      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpenCell(type.id)}>
                        <Plus className="size-3.5" />
                        Pair factors
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function labelFor(id: string | undefined, factors: Factor[] | undefined) {
  if (!id) return "?";
  const f = factors?.find((x) => x.id === id);
  return f ? (f.title.length > 24 ? f.title.slice(0, 24) + "…" : f.title) : "?";
}

function PairForm({
  workshopId,
  route,
  type,
  sources,
  targets,
  onDone,
  onCancel,
}: {
  workshopId: string;
  route: string;
  type: RelationshipType;
  sources: Factor[];
  targets: Factor[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [title, setTitle] = useState("");
  const [narrative, setNarrative] = useState("");
  const [strategicOption, setStrategicOption] = useState("");

  const create = useMutation({
    mutationFn: () =>
      objectsApi.create(workshopId, route, {
        source_id: sourceId,
        target_id: targetId,
        relationship_type_key: type.key,
        ...(title.trim() ? { title: title.trim() } : {}),
        fields: {
          narrative: narrative.trim() || null,
          strategic_option: strategicOption.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("Relationship created");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ready = sourceId && targetId;
  const empty = sources.length === 0 || targets.length === 0;

  if (empty) {
    return (
      <p className="text-xs text-muted-foreground">
        Both categories need captured factors before you can pair them here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <select
        value={sourceId}
        onChange={(e) => setSourceId(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Source factor…</option>
        {sources.map((f) => (
          <option key={f.id} value={f.id}>
            {f.title}
          </option>
        ))}
      </select>
      <select
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Target factor…</option>
        {targets.map((f) => (
          <option key={f.id} value={f.id}>
            {f.title}
          </option>
        ))}
      </select>
      <Input
        placeholder="Title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="text-xs"
      />
      <Textarea
        placeholder="Strategic narrative — why this pairing matters"
        rows={2}
        value={narrative}
        onChange={(e) => setNarrative(e.target.value)}
      />
      <Textarea
        placeholder="Strategic option — the move this suggests"
        rows={2}
        value={strategicOption}
        onChange={(e) => setStrategicOption(e.target.value)}
      />
      <div className={cn("flex justify-end gap-2")}>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready || create.isPending} onClick={() => create.mutate()}>
          {create.isPending && <Loader2 className="size-3.5 animate-spin" />}
          Create
        </Button>
      </div>
    </div>
  );
}
