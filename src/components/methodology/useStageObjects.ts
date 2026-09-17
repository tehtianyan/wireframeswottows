import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  objectKindsApi,
  objectsApi,
  workshopsApi,
  type CitableKind,
  type MethodologyStage,
  type ObjectKind,
  type WorkObject,
  type WorkshopDetail,
} from "@/lib/api";

// Shared loading for any Phase 2 stage.
//
// A stage declares what its objects may cite in methodology config:
//   synthesize  {"groups": "factor"}
//   interpret   {"cites": ["synthesis", "factor_relationship"]}
//   recommend   {"cites": ["insight"]}
// This hook reads that, resolves the object kind the stage produces, and
// loads each citable pool. Nothing here knows what a theme or a TOWS
// relationship is.

/** A citable item flattened to what the picker needs, whatever its kind. */
export interface CitableItem {
  id: string;
  kind: CitableKind;
  label: string;
  sublabel?: string;
  state: string;
  /** Present for factors; lets the picker group by category. */
  categoryKey?: string;
}

/** Reads the stage's declared citation list, normalising `groups` to `cites`. */
export function citedKinds(stage: MethodologyStage): CitableKind[] {
  const cites = stage.config["cites"];
  if (Array.isArray(cites)) return cites as CitableKind[];
  // A synthesize stage says what it groups; that is the same relationship
  // expressed with one value, so treat it identically.
  const groups = stage.config["groups"];
  if (typeof groups === "string") return [groups as CitableKind];
  return [];
}

export function useStageObjects(workshop: WorkshopDetail, stage: MethodologyStage) {
  const workshopId = workshop.id;

  const kindsQuery = useQuery({
    queryKey: ["object-kinds"],
    queryFn: () => objectKindsApi.list(),
    staleTime: Infinity, // a platform constant, not workshop data
  });

  const kind: ObjectKind | undefined = useMemo(
    () => kindsQuery.data?.find((k) => k.stage_type === stage.stage_type),
    [kindsQuery.data, stage.stage_type],
  );

  const objectsQuery = useQuery({
    queryKey: ["objects", workshopId, kind?.route],
    queryFn: () => objectsApi.list(workshopId, kind!.route),
    enabled: Boolean(kind),
  });

  const cites = useMemo(() => citedKinds(stage), [stage]);

  // One query per citable kind. Factors have their own endpoint; everything
  // else goes through the generic object route from the registry.
  const poolQueries = useQueries({
    queries: cites.map((citeKind) => {
      const route = kindsQuery.data?.find((k) => k.key === citeKind)?.route;
      return {
        queryKey: ["citable", workshopId, citeKind],
        queryFn: async (): Promise<CitableItem[]> => {
          if (citeKind === "factor") {
            const factors = await workshopsApi.factors(workshopId);
            return factors.map((f) => ({
              id: f.id,
              kind: "factor" as const,
              label: f.title,
              ...(f.description ? { sublabel: f.description } : {}),
              state: f.state,
              categoryKey: f.category_key,
            }));
          }
          if (!route) return [];
          const objs = await objectsApi.list(workshopId, route);
          return objs.map((o) => ({
            id: o.id,
            kind: citeKind,
            label: o.title ?? "(untitled)",
            ...(o.description ? { sublabel: o.description } : {}),
            state: o.state,
          }));
        },
        enabled: citeKind === "factor" || Boolean(route),
      };
    }),
  });

  const pools = useMemo(() => {
    const m = new Map<CitableKind, CitableItem[]>();
    cites.forEach((c, i) => {
      // Rejected evidence should not be citable — an insight resting on a
      // rejected theme is worse than one resting on nothing.
      m.set(c, (poolQueries[i]?.data ?? []).filter((x) => x.state !== "rejected"));
    });
    return m;
  }, [cites, poolQueries]);

  const allCitable = useMemo(() => {
    const m = new Map<string, CitableItem>();
    for (const list of pools.values()) for (const item of list) m.set(item.id, item);
    return m;
  }, [pools]);

  return {
    kind,
    cites,
    pools,
    allCitable,
    objects: (objectsQuery.data ?? []) as WorkObject[],
    isLoading: kindsQuery.isLoading || objectsQuery.isLoading || poolQueries.some((q) => q.isLoading),
    isError: kindsQuery.isError || objectsQuery.isError,
    kindsQuery,
    objectsQuery,
  };
}
