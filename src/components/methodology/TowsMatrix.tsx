import { Fragment, useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { RelationshipMatrix } from "./RelationshipMatrix";
import { CleanupPanel } from "./CleanupPanel";
import { ThemeRating } from "./ThemeRating";
import { usePointerDrag } from "@/lib/usePointerDrag";
import {
  objectKindsApi,
  objectsApi,
  workshopsApi,
  type FactorCategory,
  type MethodologyStage,
  type ObjectKind,
  type RelationshipType,
  type WeightDefinition,
  type WorkObject,
  type WorkshopDetail,
} from "@/lib/api";

/**
 * The relate stage drawn as an AXIS MATRIX: one column per source category,
 * one row per target category, and a cell where they meet.
 *
 * NOTHING HERE KNOWS WHAT TOWS IS. The grid is a pivot of
 * `methodology_relationship_types`, which has carried `source_category_id`
 * and `target_category_id` since Phase 0 — so the distinct sources ARE the
 * columns and the distinct targets ARE the rows. For SWOT-TOWS that produces
 * strengths and weaknesses across the top, opportunities and threats down the
 * side, and SO/ST/WO/WT in the middle, which is the shape of every TOWS grid
 * ever drawn, reached without the word appearing in this file.
 *
 * IT IS OPTED INTO, not inferred — `"layout": "axis"` in the relate stage's
 * config, the same way the capture board's wall is `"layout": "board"`.
 * Business Model Canvas and Transformation Planning have relate stages and
 * declare nothing, so they keep the flat grid. A methodology whose
 * relationship types do NOT form a complete cross-product also falls back
 * rather than rendering a grid with holes in it: a half-drawn matrix reads as
 * data loss, and the flat view is correct for any shape.
 *
 * WHAT THE ROOM DOES HERE (the sequence this screen was built for):
 *   a. drag a theme from each edge into a quadrant to pair them
 *   b. enter the actions that quadrant suggests, under an initiative heading
 *   d. participants rate each action 1-5; the facilitator drags the order
 *   e. then the next quadrant
 *
 * Step (d) deliberately shows TWO FIGURES THAT MAY DISAGREE. The average is
 * the room's view; the order is the facilitator's decision, taken live and in
 * front of everybody. Resolving them into one number would hide the exact
 * moment this screen exists to make visible.
 */

/** What the relate stage declares about actions, when it declares any. */
interface ActionsConfig {
  kind: string;
  label: string;
  groupKind: string;
  groupLabel: string;
  weightKey: string;
}

function readActionsConfig(stage: MethodologyStage): ActionsConfig | null {
  const raw = stage.config["actions"];
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o["kind"] === "string" ? o["kind"] : "";
  const groupKind = typeof o["group_kind"] === "string" ? o["group_kind"] : "";
  if (!kind || !groupKind) return null;
  return {
    kind,
    groupKind,
    label: typeof o["label"] === "string" ? o["label"] : "Action",
    groupLabel: typeof o["group_label"] === "string" ? o["group_label"] : "Group",
    weightKey: typeof o["weight"] === "string" ? o["weight"] : "",
  };
}

/** Hand-set rank first, then oldest first — the capture board's own rule. */
function byRank(a: WorkObject, b: WorkObject): number {
  const ap = a.board_position ?? null;
  const bp = b.board_position ?? null;
  if (ap !== null && bp !== null && ap !== bp) return ap - bp;
  if (ap !== null && bp === null) return -1;
  if (ap === null && bp !== null) return 1;
  const byTime = a.created_at.localeCompare(b.created_at);
  if (byTime !== 0) return byTime;
  // A DETERMINISTIC LAST RESORT. The server now sends sub-second precision,
  // so a genuine tie is vanishingly rare — but Array.sort is stable, so a
  // tie would otherwise inherit the API's `created_at desc` and silently
  // invert the pair. An arbitrary stable order beats an order that flips.
  return a.id.localeCompare(b.id);
}

const LIVE_STATES = new Set(["draft", "submitted", "approved"]);

export function TowsMatrix({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const workshopId = workshop.id;
  const actionsConfig = readActionsConfig(stage);

  const kindsQuery = useQuery({
    queryKey: ["object-kinds"],
    queryFn: () => objectKindsApi.list(),
    staleTime: Infinity,
  });
  const kindByKey = useMemo(() => {
    const m = new Map<string, ObjectKind>();
    for (const k of kindsQuery.data ?? []) m.set(k.key, k);
    return m;
  }, [kindsQuery.data]);

  const relKind = kindByKey.get("factor_relationship");
  const synthesisRoute = kindByKey.get("synthesis")?.route;
  const groupKind = actionsConfig ? kindByKey.get(actionsConfig.groupKind) : undefined;
  const actionKind = actionsConfig ? kindByKey.get(actionsConfig.kind) : undefined;

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
  });
  const themesQuery = useQuery({
    queryKey: ["objects", workshopId, synthesisRoute],
    queryFn: () => objectsApi.list(workshopId, synthesisRoute!),
    enabled: Boolean(synthesisRoute),
  });
  const relsQuery = useQuery({
    queryKey: ["objects", workshopId, relKind?.route],
    queryFn: () => objectsApi.list(workshopId, relKind!.route),
    enabled: Boolean(relKind),
  });
  const groupsQuery = useQuery({
    queryKey: ["objects", workshopId, groupKind?.route],
    queryFn: () => objectsApi.list(workshopId, groupKind!.route),
    enabled: Boolean(groupKind),
  });
  const actionsQuery = useQuery({
    queryKey: ["objects", workshopId, actionKind?.route],
    queryFn: () => objectsApi.list(workshopId, actionKind!.route),
    enabled: Boolean(actionKind),
  });
  const weightsQuery = useQuery({
    queryKey: ["weights", workshopId],
    queryFn: () => workshopsApi.weights(workshopId),
  });

  const myRole = workshop.my_role;
  const canContribute = myRole === "facilitator" || myRole === "analyst";
  const canRank = myRole === "facilitator";

  const categories = workshop.methodology.factor_categories;
  const types = workshop.methodology.relationship_types;

  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );
  const categoryIdByKey = useMemo(
    () => new Map(categories.map((c) => [c.key, c.id])),
    [categories],
  );

  /**
   * THE GRID, DERIVED. Column and row order follow `factor_categories`'
   * own sort order rather than the order relationship types happen to be
   * listed in, so the axes read the way the methodology describes itself.
   */
  const grid = useMemo(() => {
    if (types.length === 0) return null;
    if (types.some((t) => !t.source_category_id || !t.target_category_id)) return null;
    const cols = categories.filter((c) => types.some((t) => t.source_category_id === c.id));
    const rows = categories.filter((c) => types.some((t) => t.target_category_id === c.id));
    if (cols.length === 0 || rows.length === 0) return null;
    // A COMPLETE CROSS-PRODUCT OR NOTHING. With a cell missing, the grid has
    // a hole where a quadrant should be, and an empty box is indistinguishable
    // from one nobody has filled in yet.
    if (cols.length * rows.length !== types.length) return null;
    const at = new Map<string, RelationshipType>();
    for (const t of types) at.set(`${t.source_category_id}|${t.target_category_id}`, t);
    for (const c of cols) {
      for (const rr of rows) if (!at.has(`${c.id}|${rr.id}`)) return null;
    }
    return { cols, rows, at };
  }, [types, categories]);

  /** Themes, with the category derived from the notes they cite. */
  const themesByCategory = useMemo(() => {
    const categoryKeyOf = new Map((factorsQuery.data ?? []).map((f) => [f.id, f.category_key]));
    const titleOf = new Map((factorsQuery.data ?? []).map((f) => [f.id, f.title]));
    const out = new Map<string, ThemeOnAxis[]>();
    for (const c of categories) out.set(c.id, []);
    for (const t of themesQuery.data ?? []) {
      if (!LIVE_STATES.has(t.state)) continue;
      const noteIds = t.evidence.factor ?? [];
      const keys = [
        ...new Set(noteIds.map((id) => categoryKeyOf.get(id)).filter((k): k is string => Boolean(k))),
      ];
      // A theme spanning categories has no single home on an axis. It is
      // reported below rather than dropped — see the panel at the foot.
      if (keys.length !== 1) continue;
      const catId = categoryIdByKey.get(keys[0]!);
      if (!catId) continue;
      out.get(catId)?.push({
        id: t.id,
        title: t.title ?? "(untitled theme)",
        notes: noteIds.map((id) => titleOf.get(id) ?? "").filter(Boolean),
        categoryId: catId,
      });
    }
    return out;
  }, [themesQuery.data, factorsQuery.data, categories, categoryIdByKey]);

  const unplaceableThemes = useMemo(() => {
    const categoryKeyOf = new Map((factorsQuery.data ?? []).map((f) => [f.id, f.category_key]));
    return (themesQuery.data ?? [])
      .filter((t) => LIVE_STATES.has(t.state))
      .map((t) => {
        const keys = [
          ...new Set(
            (t.evidence.factor ?? [])
              .map((id) => categoryKeyOf.get(id))
              .filter((k): k is string => Boolean(k)),
          ),
        ];
        return { id: t.id, title: t.title ?? "(untitled theme)", keys };
      })
      .filter((t) => t.keys.length !== 1);
  }, [themesQuery.data, factorsQuery.data]);

  const themeLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of factorsQuery.data ?? []) m.set(f.id, f.title);
    for (const t of themesQuery.data ?? []) m.set(t.id, t.title ?? "(untitled theme)");
    return m;
  }, [factorsQuery.data, themesQuery.data]);

  /** Half-made pairings, held here until both ends have been dropped. */
  const [pending, setPending] = useState<Record<string, { sourceId?: string; targetId?: string }>>({});

  const invalidateObjects = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["objects", workshopId] });
  }, [queryClient, workshopId]);

  const createPair = useMutation({
    mutationFn: (v: { typeKey: string; sourceId: string; targetId: string }) =>
      objectsApi.create(workshopId, relKind!.route, {
        source_id: v.sourceId,
        target_id: v.targetId,
        relationship_type_key: v.typeKey,
      }),
    onSuccess: () => {
      toast.success("Paired");
      invalidateObjects();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeObject = useMutation({
    mutationFn: (v: { route: string; id: string }) =>
      objectsApi.remove(workshopId, v.route, v.id),
    onSuccess: () => invalidateObjects(),
    onError: (e: Error) => toast.error(e.message),
  });

  const rate = useMutation({
    mutationFn: (v: { route: string; objectId: string; weightKey: string; value: number | null }) =>
      workshopsApi.setWeight(workshopId, v.route, v.objectId, v.weightKey, v.value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["weights", workshopId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const reorder = useMutation({
    mutationFn: (v: { route: string; scopeId?: string; ids: string[] }) =>
      objectsApi.setOrder(workshopId, v.route, {
        ...(v.scopeId ? { scope_id: v.scopeId } : {}),
        ids: v.ids,
      }),
    onSuccess: () => invalidateObjects(),
    onError: (e: Error) => toast.error(e.message),
  });

  const moveAction = useMutation({
    mutationFn: (v: { id: string; parentId: string }) =>
      objectsApi.update(workshopId, actionKind!.route, v.id, { parent_id: v.parentId }),
    onSuccess: () => invalidateObjects(),
    onError: (e: Error) => toast.error(e.message),
  });

  // ---- pairing drag: a theme from an edge into a quadrant -----------------

  const roleFor = useCallback(
    (typeId: string, categoryId: string): "source" | "target" | null => {
      const t = types.find((x) => x.id === typeId);
      if (!t) return null;
      if (t.source_category_id === categoryId) return "source";
      if (t.target_category_id === categoryId) return "target";
      return null;
    },
    [types],
  );

  const pairDrag = usePointerDrag<ThemeOnAxis, { typeId: string; role: "source" | "target" }>({
    hitTest: useCallback(
      (x, y, src) => {
        for (const el of document.elementsFromPoint(x, y)) {
          const typeId = (el as HTMLElement).dataset?.["cellTypeId"];
          if (!typeId) continue;
          const role = roleFor(typeId, src.categoryId);
          return role ? { typeId, role } : null;
        }
        return null;
      },
      [roleFor],
    ),
    sameTarget: useCallback(
      (a, b) => a?.typeId === b?.typeId && a?.role === b?.role,
      [],
    ),
    onDrop: useCallback(
      (src: ThemeOnAxis, tgt: { typeId: string; role: "source" | "target" }) => {
        const type = types.find((t) => t.id === tgt.typeId);
        if (!type) return;
        setPending((prev) => {
          const half = { ...(prev[tgt.typeId] ?? {}) };
          if (tgt.role === "source") half.sourceId = src.id;
          else half.targetId = src.id;
          if (half.sourceId && half.targetId) {
            createPair.mutate({
              typeKey: type.key,
              sourceId: half.sourceId,
              targetId: half.targetId,
            });
            const next = { ...prev };
            delete next[tgt.typeId];
            return next;
          }
          return { ...prev, [tgt.typeId]: half };
        });
      },
      // createPair is a stable mutation object from react-query.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [types],
    ),
  });

  // ---- ranking drag: an action within, or between, initiatives ------------

  const rankDrag = usePointerDrag<
    { id: string; label: string; initiativeId: string },
    { kind: "action"; id: string; before: boolean } | { kind: "group"; id: string }
  >({
    hitTest: useCallback((x, y, src) => {
      for (const el of document.elementsFromPoint(x, y)) {
        const node = el as HTMLElement;
        if (node.dataset?.["actionId"] && node.dataset["actionId"] !== src.id) {
          const box = node.getBoundingClientRect();
          return { kind: "action" as const, id: node.dataset["actionId"]!, before: y < box.top + box.height / 2 };
        }
        if (node.dataset?.["groupId"]) {
          return { kind: "group" as const, id: node.dataset["groupId"]! };
        }
      }
      return null;
    }, []),
    sameTarget: useCallback((a, b) => {
      if (!a || !b) return a === b;
      if (a.kind !== b.kind) return false;
      if (a.kind === "action" && b.kind === "action") return a.id === b.id && a.before === b.before;
      return a.id === b.id;
    }, []),
    onDrop: useCallback(
      (
        src: { id: string; label: string; initiativeId: string },
        tgt: { kind: "action"; id: string; before: boolean } | { kind: "group"; id: string },
      ) => {
        const all = actionsQuery.data ?? [];
        const target = tgt.kind === "action" ? all.find((a) => a.id === tgt.id) : undefined;
        const destGroup = tgt.kind === "group" ? tgt.id : target?.parent_id;
        if (!destGroup || !actionKind) return;

        // IT JOINS ITS NEW HOME BEFORE LEAVING THE OLD ONE, the rule the
        // capture board's regroup follows: reversed, a failed second call
        // leaves the action under no heading at all, which reads as the drag
        // having destroyed it.
        const place = () => {
          const siblings = all
            .filter((a) => a.parent_id === destGroup && a.id !== src.id)
            .sort(byRank)
            .map((a) => a.id);
          let at = siblings.length;
          if (tgt.kind === "action") {
            const i = siblings.indexOf(tgt.id);
            if (i >= 0) at = tgt.before ? i : i + 1;
          }
          siblings.splice(at, 0, src.id);
          reorder.mutate({ route: actionKind.route, scopeId: destGroup, ids: siblings });
        };

        if (src.initiativeId !== destGroup) {
          moveAction.mutate({ id: src.id, parentId: destGroup }, { onSuccess: place });
        } else {
          place();
        }
      },
      // the mutations are stable react-query objects
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [actionsQuery.data, actionKind],
    ),
  });

  // ---- weights -------------------------------------------------------------

  const actionWeight: WeightDefinition | undefined = useMemo(() => {
    if (!actionsConfig?.weightKey) return undefined;
    return (weightsQuery.data?.definitions ?? []).find(
      (d) => d.key === actionsConfig.weightKey && d.applies_to === actionsConfig.kind,
    );
  }, [weightsQuery.data, actionsConfig]);

  const myWeight = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of weightsQuery.data?.mine ?? []) m.set(`${v.weight_key}:${v.object_id}`, v.value);
    return m;
  }, [weightsQuery.data]);
  const totalWeight = useMemo(() => {
    const m = new Map<string, { value: number; voters: number }>();
    for (const t of weightsQuery.data?.totals ?? []) {
      m.set(`${t.weight_key}:${t.object_id}`, { value: t.value, voters: t.voters });
    }
    return m;
  }, [weightsQuery.data]);

  // ---- render --------------------------------------------------------------

  const loading =
    kindsQuery.isLoading || factorsQuery.isLoading || themesQuery.isLoading || relsQuery.isLoading;

  if (loading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the matrix…
        </div>
      </section>
    );
  }

  // NOT A BROKEN SCREEN. A methodology whose relationship types do not form a
  // complete grid gets the flat matrix, which is correct for any shape.
  if (!grid || !relKind) {
    return <RelationshipMatrix workshop={workshop} stage={stage} />;
  }

  const relsByType = new Map<string, WorkObject[]>();
  for (const rel of relsQuery.data ?? []) {
    if (!LIVE_STATES.has(rel.state)) continue;
    const k = rel.relationship_type_id ?? "";
    if (!relsByType.has(k)) relsByType.set(k, []);
    relsByType.get(k)!.push(rel);
  }
  const groupsByType = new Map<string, WorkObject[]>();
  for (const g of groupsQuery.data ?? []) {
    if (!LIVE_STATES.has(g.state)) continue;
    const k = g.relationship_type_id ?? "";
    if (!groupsByType.has(k)) groupsByType.set(k, []);
    groupsByType.get(k)!.push(g);
  }
  const actionsByGroup = new Map<string, WorkObject[]>();
  for (const a of actionsQuery.data ?? []) {
    if (!LIVE_STATES.has(a.state) || !a.parent_id) continue;
    if (!actionsByGroup.has(a.parent_id)) actionsByGroup.set(a.parent_id, []);
    actionsByGroup.get(a.parent_id)!.push(a);
  }

  const actionCount = (actionsQuery.data ?? []).filter(
    (a) => a.parent_id && LIVE_STATES.has(a.state),
  ).length;

  return (
    <div className="space-y-4">
      <section className="console-panel" data-build="live">
        <PanelHeading
          build="live"
          title="Strategy matrix"
          hint={`${(relsQuery.data ?? []).length} paired · ${actionCount} ${
            actionsConfig ? actionsConfig.label.toLowerCase() : "action"
          }${actionCount === 1 ? "" : "s"}`}
        />
        <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
          Drag a theme from the top edge and one from the left edge into a cell to pair them.
          {actionsConfig && (
            <>
              {" "}
              Then write the {actionsConfig.label.toLowerCase()}s that pairing suggests under
              an {actionsConfig.groupLabel.toLowerCase()} heading. Each cell only accepts the
              categories its own rule allows.
            </>
          )}
        </p>

        {/* The grid scrolls sideways rather than squeezing: a cell narrower
            than its content is unusable, and the axis headers must stay
            readable. The floor is below the content column's width at
            desktop, so nothing scrolls until the window is genuinely small —
            a floor ABOVE the available width can never be grown out of. */}
        <div className="overflow-x-auto">
          <div
            data-matrix-grid
            className="grid min-w-[58rem] gap-px bg-border"
            style={{
              gridTemplateColumns: `minmax(13rem, 0.8fr) repeat(${grid.cols.length}, minmax(17rem, 1fr))`,
            }}
          >
            {/* The empty corner — row 1, column 1. */}
            <div className="bg-card" />

            {grid.cols.map((c) => (
              <AxisHeaderCell
                key={`col-${c.id}`}
                category={c}
                themes={themesByCategory.get(c.id) ?? []}
                dragHandlers={pairDrag.dragHandlers}
                didMove={pairDrag.didMove}
                dragging={pairDrag.drag?.id}
              />
            ))}

            {grid.rows.map((rowCat) => (
              <Fragment key={`row-${rowCat.id}`}>
                <AxisHeaderCell
                  category={rowCat}
                  themes={themesByCategory.get(rowCat.id) ?? []}
                  dragHandlers={pairDrag.dragHandlers}
                  didMove={pairDrag.didMove}
                  dragging={pairDrag.drag?.id}
                />
                {grid.cols.map((colCat) => {
                  const type = grid.at.get(`${colCat.id}|${rowCat.id}`)!;
                  return (
                    <QuadrantCell
                      key={type.id}
                      workshopId={workshopId}
                      type={type}
                      sourceCategory={colCat}
                      targetCategory={rowCat}
                      relationships={(relsByType.get(type.id) ?? []).sort(byRank)}
                      groups={(groupsByType.get(type.id) ?? []).sort(byRank)}
                      actionsByGroup={actionsByGroup}
                      labelById={themeLabelById}
                      pending={pending[type.id]}
                      onClearPending={() =>
                        setPending((p) => {
                          const n = { ...p };
                          delete n[type.id];
                          return n;
                        })
                      }
                      isDropTarget={pairDrag.target?.typeId === type.id}
                      dropRole={pairDrag.target?.typeId === type.id ? pairDrag.target.role : null}
                      config={actionsConfig}
                      groupKind={groupKind}
                      actionKind={actionKind}
                      canContribute={canContribute}
                      canRank={canRank}
                      myRole={myRole}
                      weight={actionWeight}
                      myWeight={myWeight}
                      totalWeight={totalWeight}
                      contributors={
                        actionsConfig?.weightKey
                          ? weightsQuery.data?.participation?.[actionsConfig.weightKey]?.contributors
                          : undefined
                      }
                      onRate={(objectId, value) =>
                        actionKind &&
                        actionWeight &&
                        rate.mutate({
                          route: actionKind.route,
                          objectId,
                          weightKey: actionWeight.key,
                          value,
                        })
                      }
                      onDelete={(route, id) => removeObject.mutate({ route, id })}
                      onCreated={invalidateObjects}
                      rankHandlers={rankDrag.dragHandlers}
                      rankTarget={rankDrag.target}
                      rankingId={rankDrag.drag?.id}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>
      </section>

      {/* STEP (c) OF THE ROOM'S SEQUENCE — pair the themes, write the
          actions, TIDY THEM, then rank them. So it sits below the matrix:
          the matrix is what the room is looking at, and the tidy-up is what
          you reach for once a quadrant is full.

          The same component the capture board uses, told which subject this
          stage tidies. Whether there is a tidy-up at all is the server's
          answer — it offers one wherever the methodology has a `changeset`
          prompt for this stage type — so a methodology that configures none
          gets no button here and none of this is SWOT knowledge. */}
      {actionsConfig && (
        <CleanupPanel
          workshopId={workshop.id}
          stage={stage}
          isFacilitator={canRank}
          subject={actionsConfig.kind}
          noun={actionsConfig.label.toLowerCase()}
          heading={`Tidy the ${actionsConfig.label.toLowerCase()}s`}
          blurb={
            <>
              Fixes typos, sharpens vague {actionsConfig.label.toLowerCase()}s, files misplaced
              ones under the right {actionsConfig.groupLabel.toLowerCase()} and folds
              near-duplicates away — across every cell at once, so the same work written down
              twice is caught. Changes are applied straight away, listed below, and any of them
              can be undone. Nothing is approved and nothing is deleted.{" "}
              <strong className="font-medium text-foreground">
                One the room has already rated is never folded away:
              </strong>{" "}
              that rating is the prioritisation decision, and merging it would throw the decision
              out with the duplicate.
            </>
          }
          invalidate={["objects", "weights"]}
        />
      )}

      {/* LISTED, NOT DROPPED. A theme that cannot sit on an axis is work
          somebody did, and omitting it silently reads as the theme having
          been lost. It says why, so the fix is obvious from here. */}
      {unplaceableThemes.length > 0 && (
        <section className="console-panel" data-build="live">
          <PanelHeading
            build="live"
            title="Themes that cannot be placed"
            hint={`${unplaceableThemes.length}`}
          />
          <ul className="divide-y divide-border">
            {unplaceableThemes.map((t) => (
              <li key={t.id} className="px-4 py-2.5">
                <p className="text-xs font-medium">{t.title}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t.keys.length === 0
                    ? "It groups no notes, so it has no category."
                    : `It spans ${t.keys.join(" and ")}, so it has no single axis to sit on.`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The ghosts. Portalled to the body so a scrolling cell cannot clip
          them, and they SAY what the drop will do. */}
      {pairDrag.drag &&
        createPortal(
          <div
            ref={pairDrag.ghostRef}
            className="pointer-events-none fixed left-0 top-0 z-50 rounded border border-accent bg-card px-2 py-1.5 text-xs shadow-lg"
            style={{ width: pairDrag.drag.width }}
          >
            <p className="truncate font-medium">{pairDrag.drag.label ?? pairDrag.drag.title}</p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {pairDrag.target
                ? `drop as the ${pairDrag.target.role}`
                : "release to leave it where it is"}
            </p>
          </div>,
          document.body,
        )}
      {rankDrag.drag &&
        createPortal(
          <div
            ref={rankDrag.ghostRef}
            className="pointer-events-none fixed left-0 top-0 z-50 rounded border border-accent bg-card px-2 py-1.5 text-xs shadow-lg"
            style={{ width: rankDrag.drag.width }}
          >
            <p className="truncate font-medium">{rankDrag.drag.label}</p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {rankDrag.target ? "drop to place it here" : "release to leave it where it is"}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}

interface ThemeOnAxis {
  id: string;
  title: string;
  notes: string[];
  categoryId: string;
  /** Set by usePointerDrag's payload spread; used by the ghost. */
  label?: string;
}

/**
 * One axis header: a category and the themes that belong to it, each with
 * the notes it groups — the panels down the left and across the top of the
 * mockup. The whole card is the drag handle, never a rim: the capture board
 * shipped with a ~10px draggable border and it read as "this cannot move".
 */
/**
 * How many of a theme's notes the card shows before it offers the rest.
 * Stated once: the slice, the count in "+N more" and the check that decides
 * whether to offer it at all must agree, and three literals is three places
 * for them to stop agreeing.
 */
const SUMMARY_NOTES = 4;

function AxisHeaderCell({
  category,
  themes,
  dragHandlers,
  didMove,
  dragging,
}: {
  category: FactorCategory;
  themes: ThemeOnAxis[];
  dragHandlers: (payload: ThemeOnAxis) => { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
  /** True once the press travelled far enough to be a drag — see the toggle. */
  didMove: () => boolean;
  dragging: string | undefined;
}) {
  // Which themes are showing all their notes. Per THEME rather than one flag
  // for the cell: opening one to read it should not unfold the three below it
  // and push them off the bottom of a panel that scrolls.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex max-h-[26rem] flex-col bg-card">
      <div
        className="shrink-0 border-b border-border px-3 py-2"
        style={{ background: `color-mix(in srgb, var(${category.color_token}) 14%, transparent)` }}
      >
        <p className="label-caps text-[10px]">{category.name}</p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {themes.length} {themes.length === 1 ? "theme" : "themes"}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2">
        {themes.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            No themes yet. Group notes into themes on the {category.name.toLowerCase()} stage
            first.
          </p>
        )}
        {themes.map((t) => (
          <div
            key={t.id}
            {...dragHandlers({ ...t, label: t.title })}
            className={`cursor-grab touch-none select-none rounded border border-border bg-background p-2 transition-opacity active:cursor-grabbing ${
              dragging === t.id ? "opacity-40" : ""
            }`}
            style={{
              borderLeftWidth: 3,
              borderLeftColor: `var(${category.color_token})`,
            }}
          >
            <p className="text-xs font-medium leading-snug">{t.title}</p>
            {t.notes.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {/* OPEN, EVERY NOTE IS READABLE IN FULL. `truncate` is right
                    for the four-line summary — it keeps the card the size of
                    a card — and wrong once somebody has asked to see the
                    rest: expanding to a column of clipped lines answers
                    "there are seven" and not "what do they say", which is the
                    question that made them click. */}
                {(expanded.has(t.id) ? t.notes : t.notes.slice(0, SUMMARY_NOTES)).map((n, i) => (
                  <li
                    key={i}
                    className={cn(
                      "text-[10px] text-muted-foreground",
                      expanded.has(t.id) ? "leading-snug" : "truncate",
                    )}
                  >
                    · {n}
                  </li>
                ))}
                {t.notes.length > SUMMARY_NOTES && (
                  <li>
                    {/* A BUTTON INSIDE A DRAG SOURCE, so it has to know a
                        drag from a click. The whole card carries
                        `onPointerDown` to start a drag, and the click fires
                        on release whether or not the pointer travelled — so
                        without `didMove()` the list would unfold every time
                        somebody dropped a theme into a quadrant, which is the
                        gesture this cell exists for. Same rule as the capture
                        board's click-to-edit. */}
                    <button
                      type="button"
                      onClick={() => {
                        if (didMove()) return;
                        toggle(t.id);
                      }}
                      aria-expanded={expanded.has(t.id)}
                      className="font-mono text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      {expanded.has(t.id)
                        ? "show fewer"
                        : `+${t.notes.length - SUMMARY_NOTES} more`}
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One quadrant: the pairings made there, and the work they produced. */
function QuadrantCell({
  workshopId,
  type,
  sourceCategory,
  targetCategory,
  relationships,
  groups,
  actionsByGroup,
  labelById,
  pending,
  onClearPending,
  isDropTarget,
  dropRole,
  config,
  groupKind,
  actionKind,
  canContribute,
  canRank,
  myRole,
  weight,
  myWeight,
  totalWeight,
  contributors,
  onRate,
  onDelete,
  onCreated,
  rankHandlers,
  rankTarget,
  rankingId,
}: {
  workshopId: string;
  type: RelationshipType;
  sourceCategory: FactorCategory;
  targetCategory: FactorCategory;
  relationships: WorkObject[];
  groups: WorkObject[];
  actionsByGroup: Map<string, WorkObject[]>;
  labelById: Map<string, string>;
  pending: { sourceId?: string; targetId?: string } | undefined;
  onClearPending: () => void;
  isDropTarget: boolean;
  dropRole: "source" | "target" | null;
  config: ActionsConfig | null;
  groupKind: ObjectKind | undefined;
  actionKind: ObjectKind | undefined;
  canContribute: boolean;
  canRank: boolean;
  myRole: string;
  weight: WeightDefinition | undefined;
  myWeight: Map<string, number>;
  totalWeight: Map<string, { value: number; voters: number }>;
  contributors: number | undefined;
  onRate: (objectId: string, value: number | null) => void;
  onDelete: (route: string, id: string) => void;
  onCreated: () => void;
  rankHandlers: (p: { id: string; label: string; initiativeId: string }) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  };
  rankTarget: { kind: "action"; id: string; before: boolean } | { kind: "group"; id: string } | null;
  rankingId: string | undefined;
}) {
  const [addingGroup, setAddingGroup] = useState(false);

  const short = (id: string | undefined) => {
    if (!id) return "?";
    const l = labelById.get(id);
    if (!l) return "?";
    return l.length > 22 ? `${l.slice(0, 22)}…` : l;
  };

  return (
    <div
      data-cell-type-id={type.id}
      className={`flex max-h-[26rem] flex-col bg-background transition-colors ${
        isDropTarget ? "ring-2 ring-inset ring-accent" : ""
      }`}
    >
      <div className="shrink-0 border-b border-border px-3 py-2">
        <p className="text-sm font-medium">{type.name}</p>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {sourceCategory.name} × {targetCategory.name} · {relationships.length} paired
        </p>
        {type.guidance_text && (
          <p className="mt-1 text-[11px] text-muted-foreground">{type.guidance_text}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* What the drop would do, drawn before release. */}
        {isDropTarget && (
          <p className="border-b border-dashed border-accent bg-accent/10 px-3 py-1.5 font-mono text-[10px] text-accent">
            drop as the {dropRole === "source" ? sourceCategory.name : targetCategory.name} half
          </p>
        )}

        {pending && (pending.sourceId || pending.targetId) && (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
            <p className="min-w-0 truncate text-[11px]">
              <span className="font-medium">{short(pending.sourceId ?? pending.targetId)}</span>
              <span className="text-muted-foreground">
                {" "}
                — now drop a{" "}
                {pending.sourceId ? targetCategory.name : sourceCategory.name} theme
              </span>
            </p>
            <button
              type="button"
              onClick={onClearPending}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Cancel this pairing"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {relationships.length > 0 && (
          <ul className="divide-y divide-border/60">
            {relationships.map((rel) => (
              <li key={rel.id} className="flex items-start gap-1.5 px-3 py-1.5">
                <p className="min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {short(rel.source_id)} → {short(rel.target_id)}
                </p>
                {canContribute && (
                  <button
                    type="button"
                    onClick={() => onDelete("relationships", rel.id)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label="Remove this pairing"
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {relationships.length === 0 && !pending && (
          <p className="px-3 py-2.5 text-[11px] text-muted-foreground">Nothing paired yet.</p>
        )}

        {config && groupKind && actionKind && (
          <div className="border-t border-border">
            {groups.map((g) => (
              <InitiativeBlock
                key={g.id}
                workshopId={workshopId}
                group={g}
                actions={(actionsByGroup.get(g.id) ?? []).sort(byRank)}
                config={config}
                actionKind={actionKind}
                groupKind={groupKind}
                canContribute={canContribute}
                canRank={canRank}
                myRole={myRole}
                weight={weight}
                myWeight={myWeight}
                totalWeight={totalWeight}
                contributors={contributors}
                onRate={onRate}
                onDelete={onDelete}
                onCreated={onCreated}
                rankHandlers={rankHandlers}
                rankTarget={rankTarget}
                rankingId={rankingId}
              />
            ))}

            {canContribute &&
              (addingGroup ? (
                <QuickAddForm
                  workshopId={workshopId}
                  route={groupKind.route}
                  placeholder={`${config.groupLabel} name — e.g. the programme these sit under`}
                  extra={{ relationship_type_key: type.key }}
                  onDone={() => {
                    setAddingGroup(false);
                    onCreated();
                  }}
                  onCancel={() => setAddingGroup(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingGroup(true)}
                  disabled={relationships.length === 0}
                  title={
                    relationships.length === 0
                      ? "Pair two themes here first — the actions follow from the pairing"
                      : undefined
                  }
                  className="flex w-full items-center gap-1.5 border-t border-dashed border-border px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="size-3" />
                  Add {config.groupLabel.toLowerCase()}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One heading in a quadrant, and the actions under it. */
function InitiativeBlock({
  workshopId,
  group,
  actions,
  config,
  actionKind,
  groupKind,
  canContribute,
  canRank,
  myRole,
  weight,
  myWeight,
  totalWeight,
  contributors,
  onRate,
  onDelete,
  onCreated,
  rankHandlers,
  rankTarget,
  rankingId,
}: {
  workshopId: string;
  group: WorkObject;
  actions: WorkObject[];
  config: ActionsConfig;
  actionKind: ObjectKind;
  groupKind: ObjectKind;
  canContribute: boolean;
  canRank: boolean;
  myRole: string;
  weight: WeightDefinition | undefined;
  myWeight: Map<string, number>;
  totalWeight: Map<string, { value: number; voters: number }>;
  contributors: number | undefined;
  onRate: (objectId: string, value: number | null) => void;
  onDelete: (route: string, id: string) => void;
  onCreated: () => void;
  rankHandlers: (p: { id: string; label: string; initiativeId: string }) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  };
  rankTarget: { kind: "action"; id: string; before: boolean } | { kind: "group"; id: string } | null;
  rankingId: string | undefined;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div data-group-id={group.id} className="border-t border-border/60 px-3 py-2 first:border-t-0">
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide">
          {group.title}
        </p>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {actions.length}
        </span>
        {canContribute && (
          <button
            type="button"
            onClick={() => onDelete(groupKind.route, group.id)}
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${group.title ?? "this initiative"}`}
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>

      <ul className="mt-1 space-y-1">
        {actions.map((a, i) => {
          const key = weight ? `${weight.key}:${a.id}` : "";
          const total = weight ? totalWeight.get(key) : undefined;
          const isBefore =
            rankTarget?.kind === "action" && rankTarget.id === a.id && rankTarget.before;
          const isAfter =
            rankTarget?.kind === "action" && rankTarget.id === a.id && !rankTarget.before;
          return (
            <li key={a.id} data-action-id={a.id} className="relative">
              {isBefore && <InsertLine />}
              <div
                className={`rounded border border-border bg-card p-1.5 transition-opacity ${
                  rankingId === a.id ? "opacity-40" : ""
                }`}
              >
                <div className="flex items-start gap-1.5">
                  {canRank && (
                    <button
                      type="button"
                      {...rankHandlers({
                        id: a.id,
                        label: a.title ?? "this action",
                        initiativeId: group.id,
                      })}
                      className="mt-px shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                      aria-label={`Reorder ${a.title ?? "this action"}`}
                      title="Drag to set the running order"
                    >
                      <GripVertical className="size-3" />
                    </button>
                  )}
                  <span className="mt-px shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {i + 1}.
                  </span>
                  <p className="min-w-0 flex-1 text-[11px] leading-snug">{a.title}</p>
                  {canContribute && (
                    <button
                      type="button"
                      onClick={() => onDelete(actionKind.route, a.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${a.title ?? "this action"}`}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
                {a.description && (
                  <p className="mt-0.5 pl-4 text-[10px] text-muted-foreground">{a.description}</p>
                )}
                {weight && (
                  <ThemeRating
                    definition={weight}
                    mine={myWeight.get(key)}
                    total={total?.value}
                    voters={total?.voters}
                    contributors={contributors}
                    canRate={weight.allowed_roles.includes(myRole as never)}
                    pending={false}
                    onRate={(v) => onRate(a.id, v)}
                    themeTitle={a.title ?? "this action"}
                  />
                )}
              </div>
              {isAfter && <InsertLine />}
            </li>
          );
        })}
      </ul>

      {actions.length === 0 && !adding && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          No {config.label.toLowerCase()}s yet.
        </p>
      )}

      {canContribute &&
        (adding ? (
          <QuickAddForm
            workshopId={workshopId}
            route={actionKind.route}
            placeholder={`${config.label} — what to do`}
            withDescription
            extra={{ parent_id: group.id }}
            onDone={() => {
              setAdding(false);
              onCreated();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-3" />
            Add {config.label.toLowerCase()}
          </button>
        ))}
    </div>
  );
}

function InsertLine() {
  return <div className="pointer-events-none my-0.5 h-0.5 rounded bg-accent" aria-hidden />;
}

/**
 * One title, optionally one description, straight into the generic object
 * endpoint. Deliberately not `ObjectForm`: that renders every registry field,
 * and a cell is not where somebody fills in impact and feasibility scores.
 */
function QuickAddForm({
  workshopId,
  route,
  placeholder,
  withDescription,
  extra,
  onDone,
  onCancel,
}: {
  workshopId: string;
  route: string;
  placeholder: string;
  withDescription?: boolean;
  extra: Record<string, string>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () =>
      objectsApi.create(workshopId, route, {
        title: title.trim(),
        ...(withDescription && description.trim() ? { description: description.trim() } : {}),
        ...extra,
      }),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="mt-1 space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
    >
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
      {withDescription && (
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="More detail (optional)"
          rows={2}
          className="text-xs"
        />
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-6 px-2 text-[10px]"
          disabled={!title.trim() || create.isPending}
        >
          {create.isPending && <Loader2 className="size-3 animate-spin" />}
          Add
        </Button>
      </div>
    </form>
  );
}
