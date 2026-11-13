import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckSquare,
  Columns3,
  Grid2x2,
  Layers,
  Loader2,
  Plus,
  Radio,
  Sparkles,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { MAX_FACTOR_TITLE, MAX_OBJECT_TITLE } from "@/lib/limits";
import { useBoardDrag, type DropTarget } from "@/lib/useBoardDrag";
import { synthesisWeightKeys } from "@/lib/stages";
import { StickyNote, type NoteScore } from "./StickyNote";
import { CleanupPanel } from "./CleanupPanel";
import { ThemeRating } from "./ThemeRating";
import { useFactorChannel, type ChannelStatus } from "@/lib/useFactorChannel";
import { useWorkshopPresenceContext } from "@/lib/workshop-presence";
import { boardColumns } from "@/lib/grid";
import type { PresentMember } from "@/lib/useWorkshopPresence";
import {
  objectKindsApi,
  objectsApi,
  workshopsApi,
  type Factor,
  type FactorCategory,
  type Methodology,
  type MethodologyStage,
  type WeightDefinition,
  type WorkObject,
  type WorkshopRole,
} from "@/lib/api";

// The capture board — every factor category on screen at once, as a wall of
// sticky notes that fills in live.
//
// THE GRID COMES FROM THE CATEGORY COUNT, NOT FROM SWOT. Four categories
// produce the familiar 2x2; PESTLE's six produce 3x2 and the Business Model
// Canvas's nine produce 3x3, from this same component. Nothing here knows what
// a strength is — exactly as `category_matrix` works in the report engine.
//
// A methodology opts in with `"layout": "board"` on its capture stages.
//
// Four things the board must keep doing, each of which UAT found missing:
//
//  - EVERY PANEL IS ON SCREEN AT ONCE. The panels scroll INTERNALLY, so a wall
//    with thirty notes in Strengths does not push Opportunities and Threats
//    below the fold. A SWOT board whose bottom half needs scrolling to reach
//    is not a SWOT board; the whole point is seeing the four together.
//  - OLDEST NOTE AT THE TOP. The wall reads in the order the room produced it.
//  - THE GROUP'S FIGURE IS ON THE NOTE, with the number of people behind it.
//  - A THEME IS MADE BY STACKING, the way it is made on a physical wall.

// `boardColumns` moved to src/lib/grid.ts on 2026-11-07: the relationship
// matrix needs the same "4 gives a 2x2" answer from its relationship-type
// count, and two copies of that rule is two chances to disagree about it.

/**
 * Display order within a category: hand-set position first, then creation
 * order, OLDEST FIRST.
 *
 * The API returns `votes desc, created_at desc`, which the prioritize stage
 * needs and a capture wall must not have — newest-first means every note the
 * room adds appears at the top and pushes the session's history down, so the
 * wall reads backwards against the conversation that produced it.
 *
 * A null position means never placed by hand, and sorts after everything
 * placed: a note added during a session lands at the bottom of its panel,
 * which is where a new sticky goes.
 */
export function compareForBoard(a: Factor, b: Factor): number {
  const pa = a.board_position ?? null;
  const pb = b.board_position ?? null;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  const byAge = a.created_at.localeCompare(b.created_at);
  // The id breaks a tie so the order cannot shuffle between renders — two
  // notes created in the same millisecond is routine when a board is seeded.
  return byAge !== 0 ? byAge : a.id.localeCompare(b.id);
}

type ViewMode = "grid" | "columns";

/**
 * One change to a theme's membership.
 *
 * A LIST OF THESE IS APPLIED AS ONE OPERATION — see `editThemes`. Regrouping
 * is always at least two changes (join the new theme, leave the old), and
 * describing them as data rather than as two calls is what lets the cache be
 * written once instead of rendering the gap between them.
 *
 * `delete` exists because emptying a theme now removes it rather than being
 * refused; see `detachPlan`.
 */
type ThemeEdit =
  | { kind: "set"; themeId: string; ids: string[] }
  | { kind: "delete"; themeId: string };
const VIEW_KEY = "swot.captureBoard.view";

/**
 * How wide a sticky note is, stated ONCE.
 *
 * The notes are square (`StickyNote` sets the ratio and nothing else sets a
 * width), so this track size is also their height — which makes it the single
 * number that decides whether the wall reads as a wall of post-its or as a
 * stack of panels. `auto-fill` keeps a note the same size whatever the view:
 * four or five across a grid-view panel, two or three across a narrower
 * column-view one, rather than one enormous tile per row.
 *
 * Used by the panel AND by the notes inside a theme. They were different
 * values once, and a note that changed size when it joined a group read as a
 * different kind of object.
 *
 * A FIXED TRACK, NOT `1fr`. With `minmax(7.5rem, 1fr)` the tiles stretch to
 * fill whatever container they are in, so a note inside a theme came out at
 * 179px against 123px for the note beside it — same shape, visibly different
 * size, because a theme's box is narrower than the panel and fits one fewer
 * column. A real post-it does not change size with the space around it.
 * Leftover width is left as a ragged right edge, which is what a wall looks
 * like. The `min(...)` lower bound only engages when the container is
 * narrower than one tile, so a very narrow panel shrinks the note instead of
 * overflowing sideways.
 */
const NOTE_TRACK = "repeat(auto-fill, minmax(min(7.5rem, 100%), 7.5rem))";

/** A stable empty set, so "no notes are being carried" is not a new object
 *  on every render — which would re-render every theme stack on every tick. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export function CaptureBoard({
  workshopId,
  methodology,
  stage,
  myRole,
  me,
  aiSlot,
}: {
  workshopId: string;
  methodology: Methodology;
  stage: MethodologyStage;
  myRole: WorkshopRole;
  me: { user_id: string; name: string } | null;
  /**
   * The assistant for THIS stage, rendered inside the focused panel's
   * composer instead of in a column of its own.
   *
   * Passed in as a node, so the board goes on knowing nothing about AI — the
   * route is still the only place that decides which actions a stage offers,
   * exactly as when this was StageShell's `aiPanel`. It goes on the FOCUSED
   * panel only: the functions are stage-scoped, and a capture stage is one
   * category, so an assistant offered on all four would be answering about the
   * wrong one on three of them.
   */
  aiSlot?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<ViewMode>("grid");
  const [pendingTheme, setPendingTheme] = useState<{
    ids: string[];
    categoryKey: string;
    /**
     * The themes the notes are LEAVING to form this one, when the drag started
     * inside one or more stacks. Carried through the naming prompt because the
     * detach must not happen until the new theme really exists — cancelling
     * the prompt has to leave the wall exactly as it was. A LIST, since a
     * selection can be drawn from several themes at once.
     */
    detach?: ThemeEdit[];
  } | null>(null);

  /**
   * The notes picked out for a bulk action.
   *
   * IT SURVIVES A VIEW CHANGE AND A REFETCH but not a category change: a
   * selection is about what is in front of you, and ids are filtered against
   * the live factor list wherever it is read, so a note somebody else deleted
   * cannot linger in it as a ghost that a later drag would try to move.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * Selection mode, for touch. A modifier-click is the mouse gesture and a
   * tablet has no modifier key — and a tablet passed round a table is the
   * device this board was rewritten for. In this mode a tap selects instead
   * of opening the editor.
   */
  const [selecting, setSelecting] = useState(false);

  // Remembered per browser only — a layout preference is one viewer's reading
  // comfort, not shared workshop state, and must survive a storage failure
  // rather than take the board down with it.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === "grid" || saved === "columns") setView(saved);
    } catch {
      /* private mode, blocked storage: the default is fine */
    }
  }, []);
  const chooseView = (v: ViewMode) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const focusedKey = (stage.config["factor_category_key"] as string | undefined) ?? "";

  // A facilitator works across the whole wall; everyone else adds to the stage
  // they are on. NOTE this is an AFFORDANCE, not a boundary: the create
  // endpoint has never been scoped to a stage, so a participant posting to
  // another category through the API is allowed today and stays allowed.
  const facilitator = myRole === "facilitator";
  const contributor = facilitator || myRole === "participant" || myRole === "analyst";
  // Who may correct a note the room has already decided on. The same two roles
  // the API calls reviewers, named here once so the board and the server agree
  // on which of them is being asked about.
  const reviewer = facilitator || myRole === "analyst";
  const canAddTo = (key: string) => contributor && (facilitator || key === focusedKey);

  // The factors channel keeps the board live; presence comes from the workshop
  // layout route, which is the one place anybody is announced. The board used
  // to read presence off the factors channel — a second channel the roster
  // never listened to, so the two surfaces disagreed by construction.
  const { status } = useFactorChannel(workshopId);
  const { present } = useWorkshopPresenceContext();

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
    // A safety net only: the channel is what makes this live. If the socket
    // drops, the board keeps catching up rather than silently going stale.
    refetchInterval: status === "live" ? false : 8000,
  });

  // The group's figures. Read through the generic weights endpoint rather than
  // a `votes` field, so the pill on a note shows whatever weight the
  // methodology attaches to a factor — votes here, likelihood on a risk board.
  const weightsQuery = useQuery({
    queryKey: ["weights", workshopId],
    queryFn: () => workshopsApi.weights(workshopId),
  });

  // The object kind a synthesize stage produces, from the registry. This is
  // what makes stacking into themes configuration rather than SWOT knowledge:
  // a methodology with no synthesize stage simply has no theme route, and the
  // board offers no stacking.
  const kindsQuery = useQuery({
    queryKey: ["object-kinds"],
    queryFn: () => objectKindsApi.list(),
    staleTime: Infinity,
  });
  const themeKind = useMemo(
    () => kindsQuery.data?.find((k) => k.stage_type === "synthesize"),
    [kindsQuery.data],
  );
  const methodologySynthesizes = useMemo(
    () => methodology.stages.some((s) => s.stage_type === "synthesize"),
    [methodology.stages],
  );
  const themeRoute = methodologySynthesizes ? themeKind?.route : undefined;

  const themesQuery = useQuery({
    queryKey: ["objects", workshopId, themeRoute],
    queryFn: () => objectsApi.list(workshopId, themeRoute!),
    enabled: Boolean(themeRoute),
  });

  // ---- Rating a theme: the prioritisation step, on the board ----
  //
  // The room groups notes into themes here and then rates those themes, so
  // capture, theming and prioritisation all happen on one screen per category
  // instead of across three stages.
  //
  // WHICH WEIGHTS, FROM CONFIG. The keys come from the SYNTHESIZE stage's own
  // `weights` declaration (src/lib/stages.ts explains why there rather than
  // here), resolved against the definitions the methodology actually has. A
  // methodology that declares none gets no rating control and no empty row
  // where one would have been — which is every methodology but SWOT-TOWS and
  // Five Forces today.
  const themeWeights = useMemo(() => {
    const declared = synthesisWeightKeys(methodology.stages);
    if (declared.length === 0) return [];
    const defs = weightsQuery.data?.definitions ?? [];
    return declared
      .map((key) => defs.find((d) => d.key === key && d.applies_to === "synthesis"))
      .filter((d): d is WeightDefinition => Boolean(d));
  }, [methodology.stages, weightsQuery.data]);

  // The caller's own rating and the group's figure, keyed the same way.
  const themeRatings = useMemo(() => {
    const mine = new Map<string, number>();
    for (const v of weightsQuery.data?.mine ?? []) {
      if (v.object_kind === "synthesis") mine.set(`${v.weight_key}:${v.object_id}`, v.value);
    }
    const totals = new Map<string, { value: number; voters: number }>();
    for (const t of weightsQuery.data?.totals ?? []) {
      if (t.object_kind === "synthesis") {
        totals.set(`${t.weight_key}:${t.object_id}`, { value: t.value, voters: t.voters });
      }
    }
    return { mine, totals };
  }, [weightsQuery.data]);

  const rateTheme = useMutation({
    mutationFn: (v: { themeId: string; weightKey: string; value: number | null }) =>
      workshopsApi.setWeight(workshopId, themeRoute!, v.themeId, v.weightKey, v.value),
    // Invalidated rather than patched: the group figure is an aggregate the
    // server computes, and guessing what an average becomes after one more
    // rating is how a screen starts disagreeing with the database.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["weights", workshopId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  // WHO MAY RATE COMES FROM THE DEFINITION, not from this component's idea of
  // who participates. SWOT-TOWS allows participants only — the facilitator
  // decides when rating stops, so their own rating averaged in with the
  // room's would carry more weight than anybody else's. Five Forces allows
  // facilitators and analysts and no participants. Both are honoured by
  // reading `allowed_roles`.
  const renderThemeRating = useMemo(() => {
    if (themeWeights.length === 0 || !themeRoute) return undefined;
    return (theme: WorkObject) => (
      <>
        {themeWeights.map((def) => {
          const k = `${def.key}:${theme.id}`;
          const total = themeRatings.totals.get(k);
          const part = weightsQuery.data?.participation?.[def.key];
          return (
            <ThemeRating
              key={def.key}
              definition={def}
              mine={themeRatings.mine.get(k)}
              total={total?.value}
              voters={total?.voters}
              contributors={part?.contributors}
              canRate={def.allowed_roles.includes(myRole)}
              pending={
                rateTheme.isPending &&
                rateTheme.variables?.themeId === theme.id &&
                rateTheme.variables?.weightKey === def.key
              }
              onRate={(value) => rateTheme.mutate({ themeId: theme.id, weightKey: def.key, value })}
              themeTitle={theme.title ?? "this theme"}
            />
          );
        })}
      </>
    );
  }, [themeWeights, themeRoute, themeRatings, weightsQuery.data, myRole, rateTheme]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
  const invalidateThemes = () =>
    queryClient.invalidateQueries({ queryKey: ["objects", workshopId] });

  const createFactor = useMutation({
    mutationFn: (v: { categoryKey: string; title: string }) =>
      workshopsApi.createFactor(workshopId, { category_key: v.categoryKey, title: v.title }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  // MOVING IS OPTIMISTIC, and that is the other half of the reported lag.
  // The note used to stay where it was until a PATCH round-tripped and a
  // refetch came back — on a live board that is a visible beat between letting
  // go and the note arriving, which reads as the drag being slow when it is
  // the network being honest. The cache is written first and rolled back if
  // the server refuses.
  //
  // This is NOT the thing the authorization model forbids. That rule is about
  // the Realtime socket: a row arriving over the socket must never be rendered
  // without passing back through Go. This is the client's own mutation, whose
  // response it is entitled to trust, and a refetch follows regardless.
  const updateFactor = useMutation({
    mutationFn: (v: { id: string; title?: string; description?: string; category_key?: string }) => {
      const { id, ...input } = v;
      return workshopsApi.updateFactor(workshopId, id, input);
    },
    onMutate: async (v) => {
      if (!v.category_key) return;
      const key = ["factors", workshopId, "all"];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Factor[]>(key);
      queryClient.setQueryData<Factor[]>(key, (old) =>
        (old ?? []).map((f) =>
          // The position is cleared with the move: a note arriving in a new
          // panel has not been placed by hand there, so it goes to the end
          // rather than keeping a slot number that means nothing.
          f.id === v.id ? { ...f, category_key: v.category_key!, board_position: null } : f,
        ),
      );
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["factors", workshopId, "all"], ctx.previous);
      toast.error(e.message);
    },
    onSettled: () => invalidate(),
  });

  const deleteFactor = useMutation({
    mutationFn: (id: string) => workshopsApi.deleteFactor(workshopId, id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const setOrder = useMutation({
    mutationFn: (v: { categoryKey: string; ids: string[] }) =>
      workshopsApi.setFactorOrder(workshopId, v.categoryKey, v.ids),
    onMutate: async (v) => {
      const key = ["factors", workshopId, "all"];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Factor[]>(key);
      const at = new Map(v.ids.map((id, i) => [id, i]));
      queryClient.setQueryData<Factor[]>(key, (old) =>
        (old ?? []).map((f) => (at.has(f.id) ? { ...f, board_position: at.get(f.id)! } : f)),
      );
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["factors", workshopId, "all"], ctx.previous);
      toast.error(e.message);
    },
    onSettled: () => invalidate(),
  });

  const createTheme = useMutation({
    mutationFn: (v: { title: string; ids: string[] }) =>
      objectsApi.create(workshopId, themeRoute!, {
        title: v.title,
        evidence: { factor: v.ids },
      }),
    onSuccess: () => {
      invalidateThemes();
      queryClient.invalidateQueries({ queryKey: ["citable", workshopId] });
      toast.success("Theme created — it is on the Synthesis stage too, awaiting review");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * THEME MEMBERSHIP CHANGES AS ONE OPERATION, APPLIED TO THE CACHE FIRST.
   *
   * Two UAT reports met here and have one cause between them.
   *
   * "The latency should be instantaneous": moving a note between panels and
   * reordering within one were already optimistic, and dropping a note onto a
   * THEME was not — it waited for a PATCH and then for a refetch before the
   * note appeared in the stack. On a live board that is a visible beat
   * between letting go and anything happening, which reads as the drag being
   * slow when it is the network being honest.
   *
   * "Sometimes the theme shows only the new note, with the existing ones
   * outside it, then organizes itself back": regrouping is TWO server calls —
   * add to the new theme, remove from the old — each of which invalidated and
   * refetched. The board therefore rendered whatever the server happened to
   * know between them. Making each call optimistic SEPARATELY would not fix
   * it; it would just move the intermediate frame earlier. So the edits are
   * applied to the cache in ONE write, and there is no frame between them to
   * render.
   *
   * The ids are computed in `onMutate` FROM THE CACHE, never from a value the
   * caller closed over, so a second drag that starts before the first has
   * settled builds on what is actually there.
   *
   * This is not what the authorization model forbids. That rule is about the
   * Realtime socket: a row arriving over it must never be rendered without
   * passing back through Go. This is the client's own mutation, and the
   * refetch in `onSettled` is still the arbiter.
   */
  const editThemes = useMutation({
    mutationFn: async (edits: ThemeEdit[]) => {
      // IN ORDER, AND THE ORDER IS THE RULE: a note joins its new theme
      // BEFORE it leaves the old one. Reversed, a failed second call would
      // leave it in no theme at all, which reads as the drag having destroyed
      // the grouping. Callers build the list in that order; this just honours
      // it rather than firing them off together.
      for (const e of edits) {
        if (e.kind === "delete") {
          await objectsApi.remove(workshopId, themeRoute!, e.themeId);
        } else {
          await objectsApi.update(workshopId, themeRoute!, e.themeId, {
            evidence: { factor: e.ids },
          });
        }
      }
    },
    onMutate: async (edits) => {
      const key = ["objects", workshopId, themeRoute];
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkObject[]>(key);
      const removed = new Set(
        edits.filter((e) => e.kind === "delete").map((e) => e.themeId),
      );
      const set = new Map(
        edits.filter((e): e is Extract<ThemeEdit, { kind: "set" }> => e.kind === "set")
          .map((e) => [e.themeId, e.ids]),
      );
      queryClient.setQueryData<WorkObject[]>(key, (old) =>
        (old ?? [])
          .filter((t) => !removed.has(t.id))
          .map((t) =>
            set.has(t.id)
              ? { ...t, evidence: { ...(t.evidence ?? {}), factor: set.get(t.id)! } }
              : t,
          ),
      );
      return { previous };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(["objects", workshopId, themeRoute], ctx.previous);
      }
      toast.error(e.message);
    },
    onSettled: () => {
      invalidateThemes();
      queryClient.invalidateQueries({ queryKey: ["citable", workshopId] });
    },
  });

  const factors = factorsQuery.data ?? [];

  // Which weight to show on a note: the methodology's first factor weight, the
  // same choice the leaderboard makes. Null for a methodology with none, and
  // the pill then simply does not appear.
  const scoreDefinition: WeightDefinition | null = useMemo(() => {
    const forFactors = (weightsQuery.data?.definitions ?? []).filter(
      (d) => d.applies_to === "factor",
    );
    return forFactors[0] ?? null;
  }, [weightsQuery.data]);

  const scores = useMemo(() => {
    const m = new Map<string, NoteScore>();
    if (!scoreDefinition) return m;
    const participation = weightsQuery.data?.participation?.[scoreDefinition.key];
    for (const t of weightsQuery.data?.totals ?? []) {
      if (t.weight_key !== scoreDefinition.key) continue;
      // Nothing allocated is not a figure worth putting on a wall; a zero pill
      // on every note during capture is noise that hides the real ones.
      if (t.value === 0 && t.voters === 0) continue;
      m.set(t.object_id, {
        name: scoreDefinition.name,
        value: t.value,
        voters: t.voters,
        contributors: participation?.contributors ?? 0,
        perParticipant: scoreDefinition.per_participant,
        ...(t.label ? { label: t.label } : {}),
      });
    }
    return m;
  }, [weightsQuery.data, scoreDefinition]);

  // Which theme each note belongs to, and each theme's own note list.
  const themes = useMemo(() => {
    const byFactor = new Map<string, WorkObject>();
    const members = new Map<string, string[]>();
    for (const t of themesQuery.data ?? []) {
      if (t.state === "rejected" || t.state === "archived") continue;
      const ids = t.evidence?.factor ?? [];
      if (ids.length === 0) continue;
      members.set(t.id, ids);
      for (const id of ids) byFactor.set(id, t);
    }
    return { byFactor, members };
  }, [themesQuery.data]);

  const byCategory = useMemo(() => {
    const m = new Map<string, Factor[]>();
    for (const c of methodology.factor_categories) m.set(c.key, []);
    for (const f of factors) {
      // `archived` is a note "Deduplicate and Fix" folded into a near-duplicate. It
      // is kept so the merge can be undone, but it is off the wall — leaving
      // it visible would make a merge look like it had done nothing.
      if (f.state === "rejected" || f.state === "archived") continue;
      m.get(f.category_key)?.push(f);
    }
    for (const list of m.values()) list.sort(compareForBoard);
    return m;
  }, [factors, methodology.factor_categories]);

  /**
   * One category's wall as a sequence of BLOCKS: a loose note, or a whole
   * theme group. A theme appears at the position of its earliest member, so
   * grouping notes does not jump the group to the top of the panel.
   */
  const blocksFor = useCallback(
    (categoryKey: string): Block[] => {
      const list = byCategory.get(categoryKey) ?? [];
      const emitted = new Set<string>();
      const out: Block[] = [];
      for (const f of list) {
        const theme = themes.byFactor.get(f.id);
        if (!theme) {
          out.push({ kind: "note", factor: f });
          continue;
        }
        if (emitted.has(theme.id)) continue;
        emitted.add(theme.id);
        const ids = new Set(themes.members.get(theme.id) ?? []);
        out.push({
          kind: "theme",
          theme,
          factors: list.filter((x) => ids.has(x.id)),
        });
      }
      return out;
    },
    [byCategory, themes],
  );

  // The three-step readout, counted on the FOCUSED category only — this stage
  // is one category, and a count spanning the whole wall would report that the
  // room had themed strengths when it had themed opportunities.
  //
  // COUNTED FROM THE BLOCKS THE PANEL RENDERS, not from a parallel walk of the
  // theme list. The first version intersected every theme's members with the
  // category's live factors, and reported "THEME 3" above a panel drawing two:
  // a factor belongs to exactly one stack on screen, so a theme whose members
  // have all been regrouped elsewhere is still a theme citing this category
  // but is not drawn. Two rules for "what is on this panel" is how a readout
  // starts disagreeing with the thing it is describing — found by LOOKING at a
  // screenshot, with every assertion green.
  //
  // Absent unless the methodology can actually do all three here, so a board
  // with no synthesize stage or no theme weight shows no step it cannot offer
  // rather than one permanently stuck at zero.
  const flowSteps = useMemo((): FlowStep[] | undefined => {
    if (!themeRoute || themeWeights.length === 0) return undefined;
    const blocks = blocksFor(focusedKey);
    // DISTINCT notes OF THIS CATEGORY, which is not the same as the number the
    // panel draws, for two reasons that both inflate a naive count:
    //
    //  - `synthesis_factors` is many-to-many and nothing forbids two themes
    //    citing one factor, so a stack can draw a note another stack has
    //    already drawn. Measured on the demo board: six notes rendered for
    //    five strengths, because one was in two themes.
    //  - a theme may span categories, deliberately — whether it may is a
    //    methodology question the engine does not answer — so a stack renders
    //    members belonging to other panels too.
    //
    // "How many strengths have we captured" is a question about factors, not
    // about tiles, so it is counted over a set of ids filtered to the focused
    // category. That also makes it agree with the panel's own header, which
    // counts the same thing.
    const seen = new Set<string>();
    for (const b of blocks) {
      for (const f of b.kind === "note" ? [b.factor] : b.factors) {
        if (f.category_key === focusedKey) seen.add(f.id);
      }
    }
    const notes = seen.size;
    const stacks = blocks.filter((b) => b.kind === "theme");
    const key = themeWeights[0]!.key;
    const rated = stacks.filter(
      (b) => b.kind === "theme" && themeRatings.totals.has(`${key}:${b.theme.id}`),
    ).length;
    return [
      { label: "Capture", detail: String(notes), reached: notes > 0 },
      { label: "Theme", detail: String(stacks.length), reached: stacks.length > 0 },
      {
        label: "Prioritise",
        detail: stacks.length ? `${rated}/${stacks.length}` : "0",
        reached: rated > 0,
      },
    ];
  }, [themeRoute, themeWeights, blocksFor, focusedKey, themeRatings]);

  /** The flat id order a reorder sends: every note in the category, in view order. */
  const flatOrder = useCallback(
    (categoryKey: string): string[] =>
      blocksFor(categoryKey).flatMap((b) =>
        b.kind === "note" ? [b.factor.id] : b.factors.map((f) => f.id),
      ),
    [blocksFor],
  );

  /**
   * Moves notes into a category.
   *
   * A REVIEWED NOTE IS SKIPPED, NOT REFUSED FOR THE WHOLE GROUP. One frozen
   * note in a selection of eight must not cancel the other seven — the same
   * choice planCleanup makes, and for the same reason: one bad item binning
   * nine good ones is the worse failure. It says how many it left behind, so
   * nothing is silently not done.
   */
  function moveTo(factorIds: string[], categoryKey: string) {
    let frozen = 0;
    let moved = 0;
    for (const id of factorIds) {
      const f = factors.find((x) => x.id === id);
      if (!f || f.category_key === categoryKey) continue;
      if (f.state === "approved" || f.state === "rejected") {
        frozen++;
        continue;
      }
      updateFactor.mutate({ id, category_key: categoryKey });
      moved++;
    }
    if (frozen > 0) {
      toast.error(
        moved > 0
          ? `${frozen} reviewed ${frozen === 1 ? "note was" : "notes were"} left where they are. Reject a note instead, so the decision stays on the record.`
          : "A reviewed note cannot be moved. Reject it instead, so the decision stays on the record.",
      );
    }
  }

  /** Inserts notes, in board order, before or after another note. */
  function reorder(categoryKey: string, factorIds: string[], relativeTo: string, after: boolean) {
    const moving = new Set(factorIds);
    const ids = flatOrder(categoryKey).filter((id) => !moving.has(id));
    const at = ids.indexOf(relativeTo);
    if (at === -1) return;
    // The selection keeps its own relative order rather than the order the
    // notes happened to be clicked in: the wall is what the room is reading.
    const ordered = flatOrder(categoryKey).filter((id) => moving.has(id));
    ids.splice(after ? at + 1 : at, 0, ...ordered);
    setOrder.mutate({ categoryKey, ids });
  }

  function sendToEnd(categoryKey: string, factorIds: string[]) {
    const moving = new Set(factorIds);
    const ids = flatOrder(categoryKey).filter((id) => !moving.has(id));
    ids.push(...flatOrder(categoryKey).filter((id) => moving.has(id)));
    setOrder.mutate({ categoryKey, ids });
  }

  /**
   * May these notes leave this theme?
   *
   * EMPTYING A THEME NOW DELETES IT, AND IT USED TO BE REFUSED. The old rule
   * said a theme must keep at least one note, because an empty theme is a
   * titled claim citing nothing — true, and the conclusion was wrong. It sent
   * the facilitator to the Synthesis stage to delete a theme they had just
   * emptied on this one, which is a different screen, a different mental
   * model, and a step nobody wants mid-workshop. UAT reported it. The honest
   * answer to "this group now has nothing in it" is to remove the group, here,
   * and say so.
   *
   * A REVIEWED THEME IS STILL REFUSED, and that is a different rule rather
   * than a remnant of the old one: approving a theme is a decision about a
   * named set of notes, so dissolving it as a side effect of dragging one
   * note would retract somebody's approval without telling them. The message
   * names that reason instead of the one above.
   */
  function detachPlan(themeId: string, factorIds: string[]): ThemeEdit | null {
    const leaving = new Set(factorIds);
    const rest = (themes.members.get(themeId) ?? []).filter((x) => !leaving.has(x));
    if (rest.length > 0) return { kind: "set", themeId, ids: rest };

    const theme = themesQuery.data?.find((t) => t.id === themeId);
    if (theme && (theme.state === "approved" || theme.state === "rejected")) {
      toast.error(
        `"${theme.title ?? "That theme"}" has been reviewed, so it cannot be emptied. ` +
          "Reopen it on the Synthesis stage first.",
      );
      return null;
    }
    return { kind: "delete", themeId };
  }

  /** Says what happened when a plan dissolves the theme, which is not obvious. */
  function announceDetach(plan: ThemeEdit) {
    if (plan.kind !== "delete") return;
    const theme = themesQuery.data?.find((t) => t.id === plan.themeId);
    toast.success(
      `"${theme?.title ?? "The theme"}" had no notes left, so it was removed. ` +
        "The notes are back on the wall.",
    );
  }

  /**
   * The selection in BOARD order, and only notes that still exist.
   *
   * Read through this everywhere rather than iterating the Set: a Set has
   * insertion order, which is the order things were clicked, and the wall's
   * order is what the room is looking at. Filtering against the live factors
   * is what stops a note deleted by somebody else from lingering in the
   * selection as an id that a later drag would try to move.
   */
  const orderedSelection = useMemo(
    () => factors.filter((f) => selected.has(f.id)).sort(compareForBoard).map((f) => f.id),
    [factors, selected],
  );

  /** The categories the selection is drawn from — one is the common case. */
  const selectionCategories = useMemo(() => {
    const keys = new Set<string>();
    for (const f of factors) if (selected.has(f.id)) keys.add(f.category_key);
    return keys;
  }, [factors, selected]);

  const toggleSelected = useCallback((factorId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(factorId)) next.add(factorId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
  }, []);

  /**
   * The notes a drag is carrying.
   *
   * ONE GESTURE MOVES THE WHOLE SELECTION, which is UAT's "drag and drop
   * multiple notes in bulk". Picking up a note that is NOT in the selection
   * carries only that note and leaves the selection alone — the alternative,
   * clearing it, loses work on a mis-click, and acting on it would move notes
   * the person did not touch.
   */
  const carried = useCallback(
    (factorId: string): string[] =>
      selected.has(factorId) && selected.size > 1
        ? orderedSelection.filter((id) => selected.has(id))
        : [factorId],
    [selected, orderedSelection],
  );

  /** The theme each carried note is leaving, as one edit per theme. */
  const detachPlans = useCallback(
    (ids: string[], except?: string): ThemeEdit[] | null => {
      const byTheme = new Map<string, string[]>();
      for (const id of ids) {
        const t = themes.byFactor.get(id);
        if (!t || t.id === except) continue;
        byTheme.set(t.id, [...(byTheme.get(t.id) ?? []), id]);
      }
      const plans: ThemeEdit[] = [];
      for (const [themeId, leaving] of byTheme) {
        const plan = detachPlan(themeId, leaving);
        // REFUSED MEANS REFUSED FOR THE WHOLE DROP, unlike a frozen note in a
        // category move. A selection half out of its themes is a state the
        // person cannot see or reason about, and the refusal has already
        // named which theme and why.
        if (!plan) return null;
        plans.push(plan);
      }
      return plans;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, themesQuery.data],
  );

  const handleDrop = useCallback(
    (source: { factorId: string; categoryKey: string; themeId?: string }, target: DropTarget | null) => {
      if (!target) return;
      const ids = carried(source.factorId);
      switch (target.kind) {
        case "panel": {
          if (target.categoryKey === source.categoryKey) {
            if (facilitator) sendToEnd(source.categoryKey, ids);
            return;
          }
          // Notes dragged out of a theme into another category LEAVE the
          // theme. The alternative is a theme whose notes sit in two
          // different panels, which renders as the same theme drawn twice,
          // and which nobody asked for by dropping on a panel.
          const plans = detachPlans(ids);
          if (!plans) return;
          if (plans.length === 0) {
            moveTo(ids, target.categoryKey);
            return;
          }
          plans.forEach(announceDetach);
          void editThemes
            .mutateAsync(plans)
            .then(() => moveTo(ids, target.categoryKey))
            .catch(() => {});
          return;
        }
        case "before":
        case "after":
          reorder(target.categoryKey, ids, target.factorId, target.kind === "after");
          return;
        case "stack": {
          // Regrouping: the notes are coming out of their themes into a new
          // one. Checked BEFORE the prompt opens, so an impossible move is
          // refused while the gesture is still in mind rather than after
          // somebody has typed a name.
          const plans = detachPlans(ids);
          if (!plans) return;
          // The prompt is the point: a theme with no name is a pile, and the
          // naming is where the analytical work happens. App Spec treats a
          // theme as a reviewable object, so it has to arrive with a title.
          setPendingTheme({
            ids: [target.factorId, ...ids.filter((id) => id !== target.factorId)],
            categoryKey: target.categoryKey,
            ...(plans.length > 0 ? { detach: plans } : {}),
          });
          return;
        }
        case "theme": {
          const existing = themes.members.get(target.themeId) ?? [];
          const joining = ids.filter((id) => !existing.includes(id));
          if (joining.length === 0) return;
          const plans = detachPlans(ids, target.themeId);
          if (!plans) return;
          plans.forEach(announceDetach);
          // ADD FIRST, THEN REMOVE, in ONE optimistic write. The order of the
          // SERVER calls still matters — if a removal ran first and the add
          // then failed, a note would belong to no theme at all, which reads
          // as the drag having destroyed the grouping. What is new is that
          // the SCREEN no longer shows the half-done state between them: that
          // intermediate frame is exactly the "theme briefly shows only the
          // new note" UAT reported.
          void editThemes.mutateAsync([
            { kind: "set", themeId: target.themeId, ids: [...existing, ...joining] },
            ...plans,
          ]);
          return;
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facilitator, factors, themes, flatOrder, carried, detachPlans],
  );

  const dragging = useBoardDrag({
    onDrop: handleDrop,
    allow: {
      move: contributor,
      // Rearranging the shared wall is the facilitator's job — see the
      // handler's note on why this one is a boundary, not an affordance.
      reorder: facilitator,
      stack: contributor && Boolean(themeRoute),
    },
  });

  const draggedFactor = dragging.drag
    ? factors.find((f) => f.id === dragging.drag!.factorId)
    : null;
  const draggedCategory = draggedFactor
    ? methodology.factor_categories.find((c) => c.key === draggedFactor.category_key)
    : undefined;

  if (factorsQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the board…
        </div>
      </section>
    );
  }

  const columns =
    view === "columns"
      ? methodology.factor_categories.length
      : boardColumns(methodology.factor_categories.length);

  return (
    <div className="space-y-3">
      {/* ONE ROW, NOT TWO PANELS. The live indicator, who is in the room and
          the layout toggle were a panel of their own above a panel of their
          own, which is two panels of chrome between the header and the wall.
          They are the same information on one line. */}
      <BoardToolbar
        view={view}
        onView={chooseView}
        categoryCount={methodology.factor_categories.length}
        canReorder={facilitator}
        canStack={contributor && Boolean(themeRoute)}
        themeLabel={themeKind?.label ?? "Theme"}
        status={status}
        present={present}
        facilitator={facilitator}
        {...(contributor
          ? {
              selecting,
              onSelecting: (on: boolean) => {
                setSelecting(on);
                if (!on) setSelected(new Set());
              },
            }
          : {})}
        {...(flowSteps ? { steps: flowSteps } : {})}
      />

      {/* THE SELECTION BAR, which is also the answer to "let me make a theme
          of ONE note". Grouping used to be reachable only by dropping one
          note onto another, so a theme of a single note — a point that
          stands on its own and should still carry a name, a rating and a
          place in the report — could not be made at all without inventing a
          second note to stack it on. Here the same control makes a theme of
          one or of twenty, so there is nothing extra to learn. */}
      {selected.size > 0 && (
        <SelectionBar
          count={orderedSelection.length}
          themeLabel={themeKind?.label ?? "Theme"}
          canGroup={
            // SAME CATEGORY ONLY, the client affordance the drop already
            // follows. Whether a theme may span categories is a methodology
            // question the engine deliberately does not answer, so the board
            // declines to decide it here either — and says why, rather than
            // offering a disabled button with no explanation.
            Boolean(themeRoute) && selectionCategories.size === 1
          }
          spansCategories={selectionCategories.size > 1}
          onGroup={() => {
            const first = factors.find((f) => f.id === orderedSelection[0]);
            if (!first) return;
            const plans = detachPlans(orderedSelection);
            if (!plans) return;
            setPendingTheme({
              ids: orderedSelection,
              categoryKey: first.category_key,
              ...(plans.length > 0 ? { detach: plans } : {}),
            });
          }}
          onClear={clearSelection}
        />
      )}

      {/* Tidying the whole wall is the facilitator's job, and the panel hides
          itself entirely when the methodology has no cleanup prompt. */}
      <CleanupPanel
        workshopId={workshopId}
        stage={stage}
        isFacilitator={facilitator}
        blurb={
          <>
            Fixes typos, clarifies vague notes, moves misplaced ones and folds near-duplicates
            away — across every panel at once. Changes are applied straight away, listed below,
            and any of them can be undone. Nothing is approved and nothing is deleted.{" "}
            <strong className="font-medium text-foreground">
              This is not the same as grouping notes into a theme:
            </strong>{" "}
            a duplicate is archived, and a note that a theme already cites is never folded away at
            all.
          </>
        }
      />

      <div
        className={cn(
          "gap-3",
          // Column view scrolls sideways only when the categories genuinely
          // cannot fit; at four they do, which is the case this was asked for.
          view === "columns" ? "flex overflow-x-auto pb-1" : "grid",
        )}
        {...(view === "grid"
          ? { style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } }
          : {})}
      >
        {methodology.factor_categories.map((category) => (
          <Quadrant
            key={category.key}
            category={category}
            view={view}
            focused={category.key === focusedKey}
            blocks={blocksFor(category.key)}
            count={(byCategory.get(category.key) ?? []).length}
            categories={methodology.factor_categories}
            selected={selected}
            selecting={selecting}
            onToggleSelect={toggleSelected}
            movable={(byCategory.get(category.key) ?? []).filter(
              (f) => f.state !== "approved" && f.state !== "rejected",
            )}
            scores={scores}
            canAdd={canAddTo(category.key)}
            canMove={contributor}
            canCorrect={reviewer}
            {...(category.key === focusedKey && aiSlot ? { assist: aiSlot } : {})}
            {...(renderThemeRating ? { renderThemeRating } : {})}
            drag={dragging.drag}
            target={dragging.target}
            onDragHandle={(f, e, el) =>
              dragging.beginDrag(
                e,
                {
                  factorId: f.id,
                  categoryKey: f.category_key,
                  // Undefined for a loose note. Supplied for one inside a
                  // stack, which is what tells the hit-testing that this drag
                  // is a regrouping rather than a reorder.
                  ...(themes.byFactor.get(f.id)
                    ? { themeId: themes.byFactor.get(f.id)!.id }
                    : {}),
                },
                el,
              )
            }
            onAdd={(title) => createFactor.mutate({ categoryKey: category.key, title })}
            onSave={(id, input) => updateFactor.mutate({ id, ...input })}
            onDelete={(id) => deleteFactor.mutate(id)}
            onMoveTo={(factorId, categoryKey) => moveTo([factorId], categoryKey)}
            onRemoveFromTheme={(themeId, factorId) => {
              // THE × TAKES THE LAST NOTE OUT TOO, and the theme goes with it.
              // It used to refuse and point at the Synthesis stage, which is
              // a different screen for a decision already made here.
              const plan = detachPlan(themeId, [factorId]);
              if (!plan) return;
              announceDetach(plan);
              editThemes.mutate([plan]);
            }}
            savingId={updateFactor.isPending ? updateFactor.variables?.id ?? null : null}
            deletingId={deleteFactor.isPending ? deleteFactor.variables ?? null : null}
          />
        ))}
      </div>

      {/* The note in hand. Rendered to the body so no panel's overflow can
          clip it halfway across the board, which is what happens if it lives
          inside the column it came from. */}
      {dragging.drag &&
        draggedFactor &&
        createPortal(
          <div
            ref={dragging.ghostRef}
            aria-hidden
            // A stable hook for a browser check. The ghost is portalled to
            // the body and styled by class, so there is nothing else to find
            // it by — and a probe that cannot find it reports a drag that
            // showed nothing, which is indistinguishable from a broken drag.
            data-drag-ghost
            className="pointer-events-none fixed left-0 top-0 z-[60] will-change-transform"
            style={{ width: dragging.drag.width, height: dragging.drag.height }}
          >
            <GhostNote
              factor={draggedFactor}
              category={draggedCategory}
              target={dragging.target}
              themeLabel={themeKind?.label ?? "Theme"}
              fromTheme={Boolean(dragging.drag.themeId)}
              carrying={carried(dragging.drag.factorId).length}
            />
          </div>,
          document.body,
        )}

      {pendingTheme && (
        <ThemeTitlePrompt
          label={themeKind?.label ?? "Theme"}
          notes={pendingTheme.ids
            .map((id) => factors.find((f) => f.id === id)?.title ?? "")
            .filter(Boolean)}
          busy={createTheme.isPending}
          onCancel={() => setPendingTheme(null)}
          onCreate={(title) => {
            const leaving = pendingTheme.detach;
            createTheme.mutate(
              { title, ids: pendingTheme.ids },
              {
                onSuccess: () => {
                  setPendingTheme(null);
                  clearSelection();
                  // Only now that the new theme exists do the notes leave
                  // their old ones. If the create had failed, nothing moved.
                  if (leaving && leaving.length > 0) {
                    leaving.forEach(announceDetach);
                    editThemes.mutate(leaving);
                  }
                },
              },
            );
          }}
        />
      )}
    </div>
  );
}

type Block =
  | { kind: "note"; factor: Factor }
  | { kind: "theme"; theme: WorkObject; factors: Factor[] };

/**
 * What is picked out, and what can be done with it.
 *
 * IT APPEARS ONLY WHEN SOMETHING IS SELECTED, and it says the count in words
 * rather than showing a permanent empty tray. A bar that is always there is a
 * row of chrome between the header and the wall, which is the thing the
 * board's composition was reorganised to remove.
 */
function SelectionBar({
  count,
  themeLabel,
  canGroup,
  spansCategories,
  onGroup,
  onClear,
}: {
  count: number;
  themeLabel: string;
  canGroup: boolean;
  spansCategories: boolean;
  onGroup: () => void;
  onClear: () => void;
}) {
  return (
    <section
      className="console-panel flex flex-wrap items-center justify-between gap-2 px-3.5 py-2"
      data-selection-bar
      aria-live="polite"
    >
      <span className="text-xs">
        <strong className="font-medium">
          {count} {count === 1 ? "note" : "notes"} selected
        </strong>
        <span className="text-muted-foreground">
          {" "}
          — drag any one of them to move them all
          {spansCategories ? ", or clear and pick from one panel to group them" : ""}
        </span>
      </span>
      <div className="flex items-center gap-1.5">
        {canGroup && (
          <Button size="sm" onClick={onGroup}>
            <Layers className="size-3.5" />
            Group into a {themeLabel.toLowerCase()}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </section>
  );
}

function BoardToolbar({
  view,
  onView,
  categoryCount,
  canReorder,
  canStack,
  themeLabel,
  status,
  present,
  facilitator,
  selecting,
  onSelecting,
  steps,
}: {
  view: ViewMode;
  onView: (v: ViewMode) => void;
  categoryCount: number;
  canReorder: boolean;
  canStack: boolean;
  themeLabel: string;
  status: ChannelStatus;
  present: PresentMember[];
  facilitator: boolean;
  /**
   * Selection mode, when the caller may move notes at all. Absent for an
   * observer: a control that selects notes nothing can then be done with is
   * the same silent no-op as a disabled button with no reason beside it.
   */
  selecting?: boolean;
  onSelecting?: (on: boolean) => void;
  /** The three-step readout, or undefined when this board has no theming. */
  steps?: FlowStep[];
}) {
  return (
    <section
      className="console-panel flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3.5 py-2"
      data-build="live"
    >
      <p className="order-2 w-full text-[11px] leading-relaxed text-muted-foreground lg:order-none lg:w-auto lg:flex-1">
        {canStack && (
          <>
            Drop a note <strong className="font-medium text-foreground">onto another</strong> to
            group them into a {themeLabel.toLowerCase()}, or{" "}
            <strong className="font-medium text-foreground">drag one out of a group</strong> to
            regroup it
            {canReorder ? ", " : "."}
          </>
        )}
        {canReorder && (
          <>
            {/* LEFT OR RIGHT, matching the axis the drag reads now that the
                notes are tiles in rows. The words and the gesture have to
                agree: instructions that describe the previous layout are
                worse than none, because they are followed. */}
            {canStack ? "or " : "Drop "}on the{" "}
            <strong className="font-medium text-foreground">left or right edge</strong> to reorder.
          </>
        )}
        {!canStack && !canReorder && "Drag a note to another panel to recategorise it."}
        {/* The affordance, not a boundary — the create endpoint has never been
            stage-scoped. It was a line of its own in the status panel. */}
        {facilitator && " You can add to any panel."}
      </p>

      {steps && <FlowSteps steps={steps} />}

      <div className="flex shrink-0 items-center gap-2.5">
        <LiveState status={status} />
        <Presence present={present} />
      </div>

      {/* SELECT MODE IS THE TOUCH PATH. On a mouse, Ctrl/Cmd-click a note and
          the checkboxes appear by themselves, so this is the way in for a
          tablet — the device a board passed round a table is most likely to
          be on, and the reason the drag was rewritten for pointer events. */}
      {onSelecting && (
        <button
          type="button"
          onClick={() => onSelecting(!selecting)}
          aria-pressed={Boolean(selecting)}
          title={
            selecting
              ? "Stop selecting — tapping a note edits it again"
              : "Select several notes to move or group them together"
          }
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
            selecting
              ? "bg-elevated text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <CheckSquare className="size-3" />
          Select
        </button>
      )}

      {/* A toggle, not a breakpoint: which reads better depends on how much is
          on the wall, and that changes during a session. */}
      <div
        className="inline-flex shrink-0 overflow-hidden rounded-sm border border-border"
        role="group"
        aria-label="Board layout"
      >
        <button
          type="button"
          onClick={() => onView("grid")}
          aria-pressed={view === "grid"}
          title={`Grid — all ${categoryCount} panels together`}
          className={cn(
            "flex items-center gap-1 px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
            view === "grid"
              ? "bg-elevated text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Grid2x2 className="size-3" />
          Grid
        </button>
        <button
          type="button"
          onClick={() => onView("columns")}
          aria-pressed={view === "columns"}
          title={`Columns — one column per category`}
          className={cn(
            "flex items-center gap-1 border-l border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
            view === "columns"
              ? "bg-elevated text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Columns3 className="size-3" />
          Columns
        </button>
      </div>
    </section>
  );
}

/**
 * The stage's assistant, on a ✨ beside the box you type notes into.
 *
 * The panel passed in is the SAME `AiActionPanel` that used to occupy a column
 * of the board, unchanged: the renderer choice by declared `output_kind`, the
 * per-suggestion review, the rate limit and the "only a facilitator or analyst
 * can add these" refusal all keep working, and a methodology that configures a
 * new stage function gets it here without this file knowing. Reusing it rather
 * than writing a composer-sized version is deliberate — a second
 * implementation of the governance rules is a second place for them to drift.
 */
/**
 * One step of the capture → theme → prioritise readout.
 *
 * `reached` is DERIVED FROM THE DATA, never stored. The stage does not hold a
 * phase and nothing is locked: UAT asked for the order to be signposted, and
 * a facilitator running a live room has to be able to go back to capture after
 * a theme suggests something nobody wrote down. A stored phase would also be a
 * new column, a new endpoint, a "who may advance" rule and an audit event —
 * all to enforce an order the room can already see.
 */
type FlowStep = { label: string; detail: string; reached: boolean };

function FlowSteps({ steps }: { steps: FlowStep[] }) {
  // The furthest step with anything in it is the one the room is on. Marked
  // rather than enforced, which is the whole point.
  const current = steps.reduce((acc, s, i) => (s.reached ? i : acc), 0);
  return (
    <ol className="order-3 flex shrink-0 items-center gap-1.5 lg:order-none" aria-label="Stage progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true" className="text-border">—</span>}
          <span
            title={s.detail}
            aria-current={i === current ? "step" : undefined}
            className={cn(
              "flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
              i === current
                ? "bg-foreground/10 text-foreground"
                : s.reached
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60",
            )}
          >
            <span aria-hidden="true">{s.reached ? "●" : "○"}</span>
            {s.label}
            <span className="tabular-nums opacity-70">{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function AssistButton({
  assist,
  category,
  className,
}: {
  assist: ReactNode;
  category: FactorCategory;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Ask the assistant for ${category.name.toLowerCase()} ideas`}
          className={cn(
            "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
        >
          <Sparkles className="size-3.5" />
          <span className="sr-only">Ask the assistant for ideas</span>
        </button>
      </PopoverTrigger>
      {/* The panel brings its own border, radius and shadow as a console panel.
          Inside a popover that is a second frame around the first, so its
          chrome is suppressed here rather than made conditional in the panel —
          this is the only place it is embedded. */}
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[70vh] w-[22rem] overflow-y-auto p-0 [&>section]:rounded-none [&>section]:border-0 [&>section]:shadow-none"
      >
        {assist}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Whether the wall is live, in the smallest honest form.
 *
 * It said "Live — notes appear as people add them" in full, which is a sentence
 * about a steady state that is only interesting when it is NOT true. So the
 * healthy case is now an icon with the sentence in its tooltip, and the two
 * degraded cases keep their words: an absent explanation is what makes a board
 * that has silently stopped updating look like a board where nobody is typing.
 */
function LiveState({ status }: { status: ChannelStatus }) {
  if (status === "live") {
    return (
      <span
        className="flex items-center gap-1.5"
        title="Live — notes appear as people add them"
      >
        <Radio className="size-3.5 text-success" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Live
        </span>
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="flex items-center gap-1.5">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">Connecting…</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <WifiOff className="size-3.5 text-warning" />
      {/* Says what is actually true rather than pretending to be live. */}
      <span className="text-[11px] text-muted-foreground">
        Not live — refreshing every few seconds
      </span>
    </span>
  );
}

/** Who is here NOW, per the presence channel. An absent dot is honest; a grey one is a guess. */
function Presence({ present }: { present: PresentMember[] }) {
  if (present.length === 0) return null;
  return (
    <span
      className="flex items-center gap-1"
      title={`In the room: ${present.map((p) => `${p.name} (${p.role})`).join(", ")}`}
    >
      <span className="flex -space-x-1.5">
        {present.slice(0, 5).map((p) => (
          <span
            key={p.user_id}
            className="grid size-5 place-items-center rounded-full border border-background bg-elevated font-mono text-[9px] font-semibold text-muted-foreground"
          >
            {p.name
              .split(/\s+/)
              .map((w) => w[0])
              .slice(0, 2)
              .join("")
              .toUpperCase()}
          </span>
        ))}
      </span>
      {present.length > 5 && (
        <span className="text-[10px] text-muted-foreground">+{present.length - 5}</span>
      )}
    </span>
  );
}

function Quadrant({
  category,
  view,
  focused,
  blocks,
  count,
  categories,
  movable,
  scores,
  canAdd,
  canMove,
  canCorrect,
  assist,
  drag,
  target,
  selected,
  selecting,
  onToggleSelect,
  onDragHandle,
  onAdd,
  onSave,
  onDelete,
  onMoveTo,
  onRemoveFromTheme,
  renderThemeRating,
  savingId,
  deletingId,
}: {
  category: FactorCategory;
  view: ViewMode;
  focused: boolean;
  blocks: Block[];
  count: number;
  categories: FactorCategory[];
  movable: Factor[];
  scores: Map<string, NoteScore>;
  canAdd: boolean;
  canMove: boolean;
  /** May correct a note that has already been reviewed. */
  canCorrect: boolean;
  /** Which notes are picked out for a bulk action. */
  selected: Set<string>;
  /** Selection mode: a tap selects rather than opening the editor. */
  selecting: boolean;
  onToggleSelect: (factorId: string) => void;
  /** The stage's assistant, offered from this panel's composer. */
  assist?: ReactNode;
  /**
   * The rating row for one theme, as a node. Passed down rather than
   * reassembled here for the same reason `assist` is: the weights, who may set
   * them and the mutation all belong to the board, and a panel that built its
   * own would be a second place for the rules to drift.
   */
  renderThemeRating?: (theme: WorkObject) => ReactNode;
  drag: { factorId: string; categoryKey: string } | null;
  target: DropTarget | null;
  onDragHandle: (f: Factor, e: React.PointerEvent, el: HTMLElement) => void;
  onAdd: (title: string) => void;
  onSave: (id: string, input: { title: string; description: string }) => void;
  onDelete: (id: string) => void;
  onMoveTo: (factorId: string, categoryKey: string) => void;
  onRemoveFromTheme: (themeId: string, factorId: string) => void;
  savingId: string | null;
  deletingId: string | null;
}) {
  const [draft, setDraft] = useState("");
  const tint = `var(--${category.color_token})`;

  // "Dropping anywhere in this panel" — the whole-panel highlight. Only shown
  // for a drop that would actually land here.
  const panelIsTarget =
    drag !== null && target !== null && target.categoryKey === category.key;
  const wholePanel = panelIsTarget && target.kind === "panel";

  return (
    <section
      data-panel-category={category.key}
      className={cn(
        "console-panel flex flex-col transition-[box-shadow,border-color] duration-150",
        // SCROLLS INSIDE ITSELF, so every panel stays on screen however much
        // is on the wall. The height is capped rather than fixed: a panel with
        // three notes does not reserve space for thirty.
        //
        // THE STRIP FILLS THE WIDTH IT IS GIVEN (2026-11-07). This was a fixed
        // `w-[19rem]`, so four panels came to ~1252px and stopped there: on any
        // display wider than that the wall was visibly narrower than the header
        // panel above it, with dead space to its right. `flex-1` lets them
        // share whatever the column has.
        //
        // THE FLOOR HAD TO COME DOWN WITH IT, and keeping 19rem was the first
        // version's mistake — measured, not guessed. 4 × 19rem plus three gaps
        // is 1252px, and the content column at a 1440 viewport is 1192: a floor
        // ABOVE the available width can never be grown out of, so the panels
        // stayed 304px wide and simply overflowed into this strip's own scroll.
        // The whole change would have done nothing, while reading as done.
        // 15rem is the real floor — the width at which a panel still holds two
        // 7.5rem notes side by side once its padding is taken off — so four
        // panels fit at 1192 and grow from there, and nine PESTLE categories
        // still overflow into the sideways scroll, which is what that is for.
        //
        // This is the opposite call to a NOTE, which must not grow with its
        // container, and for the opposite reason: a post-it has a real size,
        // and a panel is the space a post-it goes on.
        view === "columns" ? "min-w-[15rem] flex-1" : "",
        wholePanel && "shadow-lg",
      )}
      style={{
        borderColor: focused || panelIsTarget ? tint : undefined,
        ...(focused ? { boxShadow: `inset 0 2px 0 0 ${tint}` } : {}),
        ...(wholePanel ? { background: `color-mix(in srgb, ${tint} 7%, var(--card))` } : {}),
      }}
      aria-label={category.name}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
            style={{ borderColor: tint, color: tint }}
          >
            {category.name}
          </span>
          {focused && (
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              this stage
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* An observer or an executive viewer gets no composer, so without
              this the assistant would have vanished for them when it moved
              into the composer — a silent loss rather than a decision. */}
          {assist && !canAdd && <AssistButton assist={assist} category={category} />}
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{count}</span>
        </div>
      </div>

      {/* EVERY PANEL CARRIES ITS OWN GUIDANCE (2026-11-07).
          It was gated on `focused`, so on stage 1 only Strengths said what it
          was for and the other three were four coloured boxes — yet a
          facilitator may add to any of them, and anybody may drag a note into
          one. A panel you can write in that does not say what belongs in it is
          the thing the methodology-first principle exists to prevent, and this
          text is per-CATEGORY config, not per-stage: it is as true in the
          Threats panel on stage 1 as it is on stage 4.
          It also made the four panels different heights, which is what pushed
          the composers out of line — see `mt-auto` below for the half of that
          fix which does not depend on the text being the same length. */}
      {category.guidance_text && (
        <p className="shrink-0 border-b border-border/60 px-3 py-2 text-xs leading-snug text-muted-foreground">
          {category.guidance_text}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {/* A WALL OF POST-ITS, NOT A LIST OF ROWS. This was `space-y-2`, one
            note per row at the full width of the panel — which is why a note
            read as a wide rectangle while the notes inside a theme (laid out
            two-up, below) read as squares. Several small squares to a row is
            both the physical thing being modelled and what keeps a note's
            size independent of how wide its panel happens to be: `auto-fill`
            puts four across a grid-view panel and two across a narrower
            column-view one, at much the same size either way. */}
        <div
          className="grid min-h-32 max-h-[26rem] flex-1 content-start gap-2 overflow-y-auto overscroll-contain p-3"
          style={{ gridTemplateColumns: NOTE_TRACK }}
        >
          {blocks.map((block) =>
            block.kind === "note" ? (
              <StickyNote
                key={block.factor.id}
                factor={block.factor}
                category={category}
                canEdit={canMove}
                canCorrect={canCorrect}
                canMove={canMove}
                score={scores.get(block.factor.id) ?? null}
                selected={selected.has(block.factor.id)}
                selectable={selecting}
                onToggleSelect={canMove ? () => onToggleSelect(block.factor.id) : undefined}
                // EVERY NOTE THE DRAG CARRIES SHOWS AS LIFTED, not just the
                // one under the pointer. Dragging eight and watching one fade
                // reads as the other seven having been left behind.
                isDragging={
                  drag?.factorId === block.factor.id ||
                  (drag !== null &&
                    selected.has(block.factor.id) &&
                    selected.has(drag.factorId) &&
                    selected.size > 1)
                }
                insertBefore={
                  target?.kind === "before" && target.factorId === block.factor.id
                }
                insertAfter={target?.kind === "after" && target.factorId === block.factor.id}
                isStackTarget={
                  target?.kind === "stack" && target.factorId === block.factor.id
                }
                onSave={(input) => onSave(block.factor.id, input)}
                onDelete={() => onDelete(block.factor.id)}
                onDragHandle={
                  canMove ? (e, el) => onDragHandle(block.factor, e, el) : undefined
                }
                isSaving={savingId === block.factor.id}
                isDeleting={deletingId === block.factor.id}
              />
            ) : (
              // A theme is a GROUP, so it takes a row of its own rather than
              // sitting in the flow as though it were one more note.
              <div key={block.theme.id} className="col-span-full">
                <ThemeStack
                  theme={block.theme}
                  factors={block.factors}
                  category={category}
                  scores={scores}
                  canEdit={canMove}
                  canCorrect={canCorrect}
                  canMove={canMove}
                  isTarget={target?.kind === "theme" && target.themeId === block.theme.id}
                  draggingId={drag?.factorId ?? null}
                  carriedIds={
                    drag !== null && selected.has(drag.factorId) && selected.size > 1
                      ? selected
                      : EMPTY_IDS
                  }
                  selected={selected}
                  selecting={selecting}
                  onToggleSelect={onToggleSelect}
                  onDragHandle={onDragHandle}
                  onSave={onSave}
                  onRemove={(factorId) => onRemoveFromTheme(block.theme.id, factorId)}
                  rating={renderThemeRating?.(block.theme)}
                  savingId={savingId}
                />
              </div>
            ),
          )}

          {blocks.length === 0 && !canAdd && (
            <p className="col-span-full text-xs text-muted-foreground">Nothing here yet.</p>
          )}
        </div>

        {/* THE FOOT OF THE PANEL, PINNED THERE.
            `mt-auto` takes the leftover space in this column, so "Add a note…"
            sits on the panel's bottom edge rather than wherever the content
            above happens to end. Both views lay the panels out with the default
            `stretch`, so every panel in a row is already the same height — and
            that is what makes this enough: the composers line up whatever the
            guidance text's length, however many notes are on the wall, and in
            grid view and column view alike. Measuring or clamping the guidance
            to equalise the heights would have been the same answer reached the
            fragile way.
            The keyboard move-select is INSIDE this group and above the form,
            because it renders only when there is something to move: below the
            form it would have shifted the composer by its own height in
            whichever panels had notes, which is the misalignment again from a
            second cause. */}
        <div className="mt-auto shrink-0">
          {/* Keyboard equivalent of dragging, so recategorising is not mouse-only. */}
          {canMove && movable.length > 0 && (
            <div className="border-t border-border/60 px-3 py-1.5">
              <label className="sr-only" htmlFor={`move-${category.key}`}>
                Move a note out of {category.name}
              </label>
              <select
                id={`move-${category.key}`}
                defaultValue=""
                onChange={(e) => {
                  const [id, key] = e.target.value.split("|");
                  if (id && key) onMoveTo(id, key);
                  e.currentTarget.value = "";
                }}
                className="w-full bg-transparent font-mono text-[10px] text-muted-foreground outline-none"
              >
                <option value="">Move a note to…</option>
                {movable.flatMap((f) =>
                  categories
                    .filter((c) => c.key !== category.key)
                    .map((c) => (
                      <option key={`${f.id}|${c.key}`} value={`${f.id}|${c.key}`}>
                        {f.title.slice(0, 28)} → {c.name}
                      </option>
                    )),
                )}
              </select>
            </div>
          )}

          {canAdd && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = draft.trim();
              if (!t) return;
              onAdd(t);
              setDraft("");
            }}
            className="border-t border-border/60 p-3"
          >
            <label className="sr-only" htmlFor={`add-${category.key}`}>
              Add a note to {category.name}
            </label>
            <div
              className="flex items-start gap-1.5 rounded-sm border border-dashed p-2"
              style={{ borderColor: `color-mix(in srgb, ${tint} 40%, transparent)` }}
            >
              <Plus className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <textarea
                id={`add-${category.key}`}
                value={draft}
                rows={1}
                maxLength={MAX_FACTOR_TITLE}
                placeholder="Add a note…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                className="max-h-24 w-full resize-none bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground"
              />
              {/* THE ASSISTANT, WHERE THE TYPING HAPPENS.
                  It was a 340px column beside the board — permanent, and
                  nowhere near the box you are stuck in front of. Here it is
                  one button, open only while wanted. `type="button"` matters:
                  it sits inside the add-a-note form, and the default would
                  submit it. */}
              {assist && <AssistButton assist={assist} category={category} className="mt-0.5" />}
            </div>
          </form>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * A theme on the wall: a named group of notes, drawn as a stack.
 *
 * It is a REAL object — a `synthesis` row with `synthesis_factors` citations —
 * so it appears on the Synthesis stage, in the report and in the traceability
 * chain, and it carries the same governance as a theme made there. Grouping
 * notes during capture is analytical work, and work that evaporates at the
 * next stage is work the room did for nothing.
 */
function ThemeStack({
  theme,
  factors,
  category,
  scores,
  canEdit,
  canCorrect,
  canMove,
  isTarget,
  draggingId,
  carriedIds,
  selected,
  selecting,
  onToggleSelect,
  onDragHandle,
  onSave,
  onRemove,
  rating,
  savingId,
}: {
  theme: WorkObject;
  factors: Factor[];
  category: FactorCategory;
  scores: Map<string, NoteScore>;
  canEdit: boolean;
  /** May correct a note already reviewed. */
  canCorrect: boolean;
  /** The group's rating of this theme, when the methodology declares one. */
  rating?: ReactNode;
  /** Whether a note can be lifted back OUT of this stack. */
  canMove: boolean;
  isTarget: boolean;
  draggingId: string | null;
  /** Every note the current drag is carrying, so all of them read as lifted. */
  carriedIds: ReadonlySet<string>;
  selected: Set<string>;
  selecting: boolean;
  onToggleSelect: (factorId: string) => void;
  onDragHandle: (f: Factor, e: React.PointerEvent, el: HTMLElement) => void;
  onSave: (id: string, input: { title: string; description: string }) => void;
  onRemove: (factorId: string) => void;
  savingId: string | null;
}) {
  const tint = `var(--${category.color_token})`;
  const decided = theme.state === "approved" || theme.state === "rejected";

  return (
    <div
      data-theme-id={theme.id}
      data-theme-category={category.key}
      className={cn(
        "rounded-sm border-2 border-dashed p-2 transition-[border-color,background] duration-150",
      )}
      style={{
        borderColor: isTarget ? tint : `color-mix(in srgb, ${tint} 40%, transparent)`,
        background: isTarget
          ? `color-mix(in srgb, ${tint} 10%, var(--card))`
          : "color-mix(in srgb, var(--muted) 30%, transparent)",
      }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-1.5">
          <Layers className="mt-0.5 size-3 shrink-0" style={{ color: tint }} />
          <span className="min-w-0 break-words text-xs font-semibold leading-snug">
            {theme.title ?? "(untitled theme)"}
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {factors.length}
        </span>
      </div>

      {/* The rating sits with the theme's NAME, above its notes, because it is
          a judgement about the group and not about any one note in it. */}
      {rating}

      {/* THE SAME TRACK SIZE AS THE WALL OUTSIDE. `grid-cols-2` made a note
          inside a theme bigger than a note beside it — the theme spans the
          full panel, so two columns of it are wider than a loose tile — and a
          note that changes size when it joins a group reads as a different
          kind of object. It is the same note. */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: NOTE_TRACK }}
      >
        {factors.map((f) => (
          // `group` IS LOAD-BEARING. The × below is revealed by
          // `group-hover`, and without a `group` ancestor here that variant
          // matched nothing — so the only way out of a theme appeared on
          // keyboard focus and never on hover. A note could be put into a
          // theme and, with a mouse, not taken out again.
          <div key={f.id} className="group relative">
            <StickyNote
              factor={f}
              category={category}
              canEdit={canEdit}
              // A NOTE IN A THEME CAN BE LIFTED OUT. It used to be fixed in
              // place, on the reasoning that its position belongs to its
              // theme — true of REORDERING, and wrong about regrouping: the
              // physical gesture for "this belongs with that one instead" is
              // to peel the note off the pile and put it on another, and the
              // × was the only alternative offered (see above for why even
              // that was invisible).
              canMove={canMove}
              themed
              isDragging={draggingId === f.id || carriedIds.has(f.id)}
              score={scores.get(f.id) ?? null}
              selected={selected.has(f.id)}
              selectable={selecting}
              onToggleSelect={canMove ? () => onToggleSelect(f.id) : undefined}
              // THE REAL SAVE. This was a no-op with a comment pointing at a
              // card that does not exist here, so clicking a note inside a
              // theme opened an editor and threw away whatever was typed. A
              // note is the same note in a group; fixing a typo in one should
              // not require taking it out first.
              onSave={(input) => onSave(f.id, input)}
              // No bin inside a stack: removal here means leaving the theme,
              // which is the × below. Deleting the note outright is done on
              // the wall, where its consequences for the theme are visible.
              onDragHandle={canMove ? (e, el) => onDragHandle(f, e, el) : undefined}
              isSaving={savingId === f.id}
            />
            {canEdit && !decided && (
              <button
                type="button"
                onClick={() => onRemove(f.id)}
                title={`Take "${f.title}" out of this theme`}
                aria-label={`Remove ${f.title} from the theme`}
                className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      {isTarget && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-wider" style={{ color: tint }}>
          Add to this theme
        </p>
      )}
    </div>
  );
}

/**
 * The note while it is in hand.
 *
 * It says what the drop will DO, on the thing being dragged, where the eye
 * already is. A panel-level highlight alone leaves the person guessing between
 * "this will join that note" and "this will move category" — which are
 * different enough that guessing is not acceptable in front of a room.
 */
function GhostNote({
  factor,
  category,
  target,
  themeLabel,
  fromTheme,
  carrying,
}: {
  factor: Factor;
  category: FactorCategory | undefined;
  target: DropTarget | null;
  themeLabel: string;
  /** True when the note was lifted out of a stack: every intent changes. */
  fromTheme: boolean;
  /** How many notes this drag is carrying, including the one drawn. */
  carrying: number;
}) {
  const label = themeLabel.toLowerCase();
  const tint = category ? `var(--${category.color_token})` : "var(--border)";
  const intent =
    target === null
      ? "Release to leave it where it is"
      : target.kind === "stack"
        ? fromTheme
          ? `Out of this ${label}, into a new one with that note`
          : `New ${label} with that note`
        : target.kind === "theme"
          ? fromTheme
            ? `Move to that ${label}`
            : `Add to that ${label}`
          : target.kind === "panel"
            ? target.categoryKey === factor.category_key
              ? "Move to the end"
              : fromTheme
                ? `Out of this ${label} and over here`
                : "Move here"
            : "Reorder";

  return (
    <div className="relative size-full">
      <div
        className="size-full overflow-hidden rounded-sm border p-2.5 text-sm leading-snug shadow-2xl"
        style={{
          background: `color-mix(in srgb, ${tint} 18%, var(--card))`,
          borderColor: tint,
        }}
      >
        <span className="line-clamp-6">{factor.title}</span>
      </div>
      {/* WHAT IS IN HAND, WHEN IT IS MORE THAN ONE NOTE. The ghost is a single
          tile, so dragging eight and seeing one is the gesture failing to
          report itself — and the eight fade out behind it, which without this
          reads as seven notes having vanished. The count sits on the corner
          like the edge of a stack of paper. */}
      {carrying > 1 && (
        <span
          className="absolute -right-2 -top-2 grid min-w-5 place-items-center rounded-full px-1 py-0.5 font-mono text-[10px] font-semibold text-background shadow"
          style={{ background: tint }}
        >
          {carrying}
        </span>
      )}
      <span
        className="absolute -bottom-6 left-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-background"
        style={{ background: tint }}
      >
        {intent}
      </span>
    </div>
  );
}

/**
 * Naming a theme the moment it is created.
 *
 * The name is not a formality: "these two notes are the same thing" is a claim
 * and the title is the claim. An untitled pile is what a whiteboard produces;
 * a named theme is what the next stage can work with.
 */
function ThemeTitlePrompt({
  label,
  notes,
  busy,
  onCancel,
  onCreate,
}: {
  label: string;
  notes: string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Name this ${label.toLowerCase()}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (t) onCreate(t);
        }}
        className="console-panel w-full max-w-md space-y-3 p-4"
      >
        <div>
          <h2 className="font-display text-sm font-semibold">Name this {label.toLowerCase()}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            What do these notes have in common? The name is what the Synthesis stage, the report
            and the traceability chain will carry.
          </p>
        </div>

        <ul className="space-y-1 rounded-sm border border-border bg-elevated/40 p-2">
          {notes.map((n, i) => (
            <li key={i} className="text-xs leading-snug text-muted-foreground">
              · {n}
            </li>
          ))}
        </ul>

        <input
          ref={ref}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={MAX_OBJECT_TITLE}
          placeholder={`${label} name…`}
          aria-label={`${label} name`}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:border-primary"
        />

        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Layers className="size-3.5" />}
            Create {label.toLowerCase()}
          </Button>
        </div>
      </form>
    </div>
  );
}
