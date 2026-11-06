import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { PanelHeading } from "@/components/workshop-ui";
import { ObjectCard } from "./ObjectCard";
import { useStageObjects } from "./useStageObjects";
import { boardColumns } from "@/lib/grid";
import {
  canReview as roleCanReview,
  objectsApi,
  workshopsApi,
  type CitableKind,
  type MethodologyStage,
  type RelationshipType,
  type WorkObject,
  type WorkshopDetail,
} from "@/lib/api";

// The relate stage. For SWOT-TOWS this renders the familiar SO / ST / WO / WT
// matrix — but nothing here knows those names. Each cell is a row from
// methodology_relationship_types, and what a cell offers is filtered by that
// row's declared source and target categories.
//
// WHAT IT PAIRS IS METHODOLOGY CONFIG (2026-11-06). The relate stage declares
// `"pairs": "factor" | "synthesis"`. SWOT-TOWS pairs THEMES, because the
// participant flow has the room group notes into themes and rate them before
// it ever reaches this screen — so pairing one sticky note against another
// throws away the grouping the previous stage existed to produce. Business
// Model Canvas and Transformation Planning still pair factors, unchanged, and
// this file cannot tell which it is rendering.
//
// A THEME'S CATEGORY IS DERIVED FROM THE NOTES IT CITES, because `syntheses`
// has no category column — whether a theme may span categories is a
// methodology question the engine refuses to answer. A theme whose notes are
// all strengths is a strength theme. One holding both strengths and weaknesses
// has no single category, so it cannot sit in an SO cell: it is LISTED as
// unplaceable with the reason, never silently dropped. Go refuses the same
// pairing with the same reasoning, so the screen and the server agree.

export function RelationshipMatrix({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const [openCell, setOpenCell] = useState<string | null>(null);

  const { kind, allCitable, objects, isLoading, kindsQuery } = useStageObjects(workshop, stage);

  // Config first, the registry's default second. Never a literal: a `"factor"`
  // written in here would be exactly the hardcoding the engine forbids.
  const pairsKind: CitableKind =
    (typeof stage.config["pairs"] === "string"
      ? (stage.config["pairs"] as CitableKind)
      : undefined) ??
    kind?.pairing?.default_target ??
    "factor";

  const pairNoun = typeof stage.config["pair_noun"] === "string" ? stage.config["pair_noun"] : pairsKind === "synthesis" ? "theme" : "factor";
  const pairNounPlural =
    typeof stage.config["pair_noun_plural"] === "string"
      ? stage.config["pair_noun_plural"]
      : `${pairNoun}s`;

  const factorsQuery = useQuery({
    queryKey: ["factors", workshop.id, "all"],
    queryFn: () => workshopsApi.factors(workshop.id),
  });

  // The themes, when that is what this stage pairs. The route comes from the
  // object registry rather than the string "syntheses".
  const synthesisRoute = kindsQuery.data?.find((k) => k.key === "synthesis")?.route;
  const themesQuery = useQuery({
    queryKey: ["objects", workshop.id, synthesisRoute],
    queryFn: () => objectsApi.list(workshop.id, synthesisRoute!),
    enabled: Boolean(synthesisRoute),
  });

  const reviewer = roleCanReview(workshop.my_role);
  const contributor = workshop.my_role === "facilitator" || workshop.my_role === "analyst";

  const categoryById = useMemo(
    () => new Map(workshop.methodology.factor_categories.map((c) => [c.id, c])),
    [workshop.methodology.factor_categories],
  );
  const categoryIdByKey = useMemo(
    () => new Map(workshop.methodology.factor_categories.map((c) => [c.key, c.id])),
    [workshop.methodology.factor_categories],
  );

  /** Every endpoint this stage could pair, with the category it belongs to. */
  const endpoints = useMemo((): Endpoint[] => {
    if (pairsKind === "synthesis") {
      const categoryKeyOf = new Map((factorsQuery.data ?? []).map((f) => [f.id, f.category_key]));
      return (themesQuery.data ?? [])
        .filter((t) => t.state !== "rejected" && t.state !== "archived")
        .map((t) => {
          // DISTINCT categories of the cited notes. `synthesis_factors` is
          // many-to-many, so a theme can hold notes from several categories
          // even though the capture board only offers same-category stacking —
          // that is a client affordance, deliberately not enforced in Go.
          const keys = [
            ...new Set(
              (t.evidence.factor ?? [])
                .map((id) => categoryKeyOf.get(id))
                .filter((k): k is string => Boolean(k)),
            ),
          ];
          const ids = keys.map((k) => categoryIdByKey.get(k)).filter((k): k is string => Boolean(k));
          return {
            id: t.id,
            label: t.title ?? "(untitled theme)",
            categoryIds: ids,
            noteCount: (t.evidence.factor ?? []).length,
          };
        });
    }
    return (factorsQuery.data ?? [])
      .filter((f) => f.state !== "rejected" && f.state !== "archived")
      .map((f) => {
        const id = categoryIdByKey.get(f.category_key);
        return {
          id: f.id,
          label: f.title,
          categoryIds: id ? [id] : [],
          noteCount: 1,
        };
      });
  }, [pairsKind, themesQuery.data, factorsQuery.data, categoryIdByKey]);

  /** Endpoints that can sit in a cell: exactly one category. */
  const placeable = useMemo(
    () => endpoints.filter((e) => e.categoryIds.length === 1),
    [endpoints],
  );
  /** The rest, kept visible with the reason — see the header comment. */
  const unplaceable = useMemo(
    () => endpoints.filter((e) => e.categoryIds.length !== 1),
    [endpoints],
  );

  const byCategoryId = useMemo(() => {
    const m = new Map<string, Endpoint[]>();
    for (const c of workshop.methodology.factor_categories) m.set(c.id, []);
    for (const e of placeable) m.get(e.categoryIds[0]!)?.push(e);
    return m;
  }, [placeable, workshop.methodology.factor_categories]);

  /** Labels for an EXISTING relationship, whichever kind it joined. */
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of factorsQuery.data ?? []) m.set(f.id, f.title);
    for (const t of themesQuery.data ?? []) m.set(t.id, t.title ?? "(untitled theme)");
    return m;
  }, [factorsQuery.data, themesQuery.data]);

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

  if (isLoading || factorsQuery.isLoading || (pairsKind === "synthesis" && themesQuery.isLoading)) {
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
          Each cell pairs {pairNounPlural} from two categories. The pairing rules come from the
          methodology, so only valid combinations are offered.
          {pairsKind === "synthesis" && (
            <>
              {" "}
              A theme takes its category from the notes it groups, so a theme holding notes from
              more than one category cannot be paired here.
            </>
          )}
        </p>

        {/* FOUR RELATIONSHIP TYPES MAKE A 2x2, NOT A 3 AND A 1 (2026-11-07).
            This was `minmax(min(100%, 300px), 1fr)` alone, which packs in as
            many 300px cells as fit: correct at the 852px the content column
            used to be (two across, so SWOT-TOWS drew its square), and wrong the
            moment the AI column came out and the same rule started drawing
            three across with the fourth stranded on its own row.
            So the count comes from the same rule the capture board's panels
            use — `boardColumns`, which is where "4 gives a 2x2" is already
            stated once for any methodology: 4 types give 2 columns, 6 give 3,
            and a methodology with one relationship type gets one. Nothing here
            knows what TOWS is; it knows how many cells it was given.
            The 300px floor stays inside the `max()`, so a narrow screen still
            collapses to a single column instead of squeezing the square. */}
        <div
          className="grid gap-px bg-border"
          style={{
            gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, max(300px, ${(
              100 / boardColumns(types.length)
            ).toFixed(4)}% - 1rem)), 1fr))`,
          }}
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
                      extraHeader={<EndpointTrail object={o} labelById={labelById} />}
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
                        noun={pairNoun}
                        nounPlural={pairNounPlural}
                        sources={byCategoryId.get(type.source_category_id) ?? []}
                        targets={byCategoryId.get(type.target_category_id) ?? []}
                        onDone={() => {
                          setOpenCell(null);
                          queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
                        }}
                        onCancel={() => setOpenCell(null)}
                      />
                    ) : (
                      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpenCell(type.id)}>
                        <Plus className="size-3.5" />
                        Pair {pairNounPlural}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* LISTED, NOT DROPPED. A theme that cannot be paired is work somebody
          did, and silently omitting it from this screen would read as the
          theme having been lost. It says which categories it spans, so the fix
          — split it on the Theme Analysis stage — is obvious from here. */}
      {pairsKind === "synthesis" && unplaceable.length > 0 && (
        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Themes that cannot be paired"
            hint={`${unplaceable.length} of ${endpoints.length}`}
          />
          <ul className="divide-y divide-border">
            {unplaceable.map((e) => (
              <li key={e.id} className="flex items-start gap-2 px-4 py-2.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <div className="min-w-0">
                  <p className="text-xs font-medium">{e.label}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {e.categoryIds.length === 0
                      ? e.noteCount === 0
                        ? "Groups no notes, so it has no category."
                        : "Its notes have no category."
                      : `Spans ${e.categoryIds
                          .map((id) => categoryById.get(id)?.name ?? "?")
                          .join(" and ")}, so it has no single category to pair on.`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One thing a relationship may join, with the categories it belongs to. */
interface Endpoint {
  id: string;
  label: string;
  /** One for a factor; zero, one or many for a theme. */
  categoryIds: string[];
  noteCount: number;
}

/**
 * `source → target` for an existing relationship.
 *
 * Reads `pairs_kind` off the ROW rather than the stage, so relationships
 * created when SWOT-TOWS paired factors still render their endpoints instead of
 * two question marks. That matters: they are approved analysis, and a screen
 * that blanks them looks exactly like data loss.
 */
function EndpointTrail({
  object,
  labelById,
}: {
  object: WorkObject;
  labelById: Map<string, string>;
}) {
  const short = (id: string | undefined) => {
    if (!id) return "?";
    const l = labelById.get(id);
    if (!l) return "?";
    return l.length > 24 ? l.slice(0, 24) + "…" : l;
  };
  return (
    <span className="font-mono text-[10px] text-muted-foreground">
      {object.pairs_kind === "factor" && (
        <span className="mr-1 rounded border border-border px-1 py-px uppercase tracking-wider">
          factors
        </span>
      )}
      {short(object.source_id)} → {short(object.target_id)}
    </span>
  );
}

function PairForm({
  workshopId,
  route,
  type,
  noun,
  nounPlural,
  sources,
  targets,
  onDone,
  onCancel,
}: {
  workshopId: string;
  route: string;
  type: RelationshipType;
  noun: string;
  nounPlural: string;
  sources: Endpoint[];
  targets: Endpoint[];
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

  if (sources.length === 0 || targets.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Both categories need {nounPlural} before you can pair them here.
        {noun === "theme" && " Group notes into themes on the capture board first."}
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
        <option value="">Source {noun}…</option>
        {sources.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
            {noun === "theme" ? ` (${e.noteCount} note${e.noteCount === 1 ? "" : "s"})` : ""}
          </option>
        ))}
      </select>
      <select
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
      >
        <option value="">Target {noun}…</option>
        {targets.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
            {noun === "theme" ? ` (${e.noteCount} note${e.noteCount === 1 ? "" : "s"})` : ""}
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
      <div className="flex justify-end gap-2">
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
