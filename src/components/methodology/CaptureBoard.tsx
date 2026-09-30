import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Radio, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { StickyNote } from "./StickyNote";
import { CleanupPanel } from "./CleanupPanel";
import { useFactorChannel, type ChannelStatus, type PresentPerson } from "@/lib/useFactorChannel";
import {
  workshopsApi,
  type Factor,
  type FactorCategory,
  type Methodology,
  type MethodologyStage,
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

/** Columns for n panels. 4 gives the 2x2 a SWOT board is expected to be. */
export function boardColumns(n: number): number {
  if (n <= 2) return Math.max(1, n);
  if (n <= 4) return 2;
  return 3;
}

export function CaptureBoard({
  workshopId,
  methodology,
  stage,
  myRole,
  me,
}: {
  workshopId: string;
  methodology: Methodology;
  stage: MethodologyStage;
  myRole: WorkshopRole;
  me: { user_id: string; name: string } | null;
}) {
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const focusedKey = (stage.config["factor_category_key"] as string | undefined) ?? "";

  // A facilitator works across the whole wall; everyone else adds to the stage
  // they are on. NOTE this is an AFFORDANCE, not a boundary: the create
  // endpoint has never been scoped to a stage, so a participant posting to
  // another category through the API is allowed today and stays allowed.
  const facilitator = myRole === "facilitator";
  const contributor = facilitator || myRole === "participant" || myRole === "analyst";
  const canAddTo = (key: string) => contributor && (facilitator || key === focusedKey);

  const { status, present } = useFactorChannel(workshopId, me ? { ...me, role: myRole } : null);

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
    // A safety net only: the channel is what makes this live. If the socket
    // drops, the board keeps catching up rather than silently going stale.
    refetchInterval: status === "live" ? false : 8000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });

  const createFactor = useMutation({
    mutationFn: (v: { categoryKey: string; title: string }) =>
      workshopsApi.createFactor(workshopId, { category_key: v.categoryKey, title: v.title }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const updateFactor = useMutation({
    mutationFn: (v: { id: string; title?: string; description?: string; category_key?: string }) => {
      const { id, ...input } = v;
      return workshopsApi.updateFactor(workshopId, id, input);
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFactor = useMutation({
    mutationFn: (id: string) => workshopsApi.deleteFactor(workshopId, id),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const byCategory = useMemo(() => {
    const m = new Map<string, Factor[]>();
    for (const c of methodology.factor_categories) m.set(c.key, []);
    for (const f of factorsQuery.data ?? []) {
      // `archived` is a note "Merge and Fix" folded into a near-duplicate. It
      // is kept so the merge can be undone, but it is off the wall — leaving
      // it visible would make a merge look like it had done nothing.
      if (f.state === "rejected" || f.state === "archived") continue;
      m.get(f.category_key)?.push(f);
    }
    return m;
  }, [factorsQuery.data, methodology.factor_categories]);

  const columns = boardColumns(methodology.factor_categories.length);

  function moveTo(factorId: string, categoryKey: string) {
    const f = (factorsQuery.data ?? []).find((x) => x.id === factorId);
    setDragging(null);
    setDropTarget(null);
    if (!f || f.category_key === categoryKey) return;
    if (f.state === "approved" || f.state === "rejected") {
      toast.error(
        "A reviewed note cannot be moved. Reject it instead, so the decision stays on the record.",
      );
      return;
    }
    updateFactor.mutate({ id: factorId, category_key: categoryKey });
  }

  if (factorsQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading the board…
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      <BoardStatus status={status} present={present} facilitator={facilitator} />

      {/* Tidying the whole wall is the facilitator's job, and the panel hides
          itself entirely when the methodology has no cleanup prompt. */}
      <CleanupPanel workshopId={workshopId} stage={stage} isFacilitator={facilitator} />

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {methodology.factor_categories.map((category) => (
          <Quadrant
            key={category.key}
            category={category}
            focused={category.key === focusedKey}
            factors={byCategory.get(category.key) ?? []}
            categories={methodology.factor_categories}
            canAdd={canAddTo(category.key)}
            canMove={contributor}
            isDropTarget={dropTarget === category.key && dragging !== null}
            onDragOver={() => setDropTarget(category.key)}
            onDragLeave={() => setDropTarget((t) => (t === category.key ? null : t))}
            onDrop={(factorId) => moveTo(factorId, category.key)}
            onAdd={(title) => createFactor.mutate({ categoryKey: category.key, title })}
            onSave={(id, input) => updateFactor.mutate({ id, ...input })}
            onDelete={(id) => deleteFactor.mutate(id)}
            onMoveStart={(id) => setDragging(id)}
            onMoveTo={moveTo}
            savingId={updateFactor.isPending ? updateFactor.variables?.id ?? null : null}
            deletingId={deleteFactor.isPending ? deleteFactor.variables ?? null : null}
          />
        ))}
      </div>
    </div>
  );
}

function BoardStatus({
  status,
  present,
  facilitator,
}: {
  status: ChannelStatus;
  present: PresentPerson[];
  facilitator: boolean;
}) {
  return (
    <section
      className="console-panel flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
      data-build="live"
    >
      <div className="flex items-center gap-2">
        {status === "live" ? (
          <>
            <Radio className="size-3.5 text-success" />
            <span className="text-xs text-muted-foreground">
              Live — notes appear as people add them
            </span>
          </>
        ) : status === "connecting" ? (
          <>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Connecting…</span>
          </>
        ) : (
          <>
            <WifiOff className="size-3.5 text-warning" />
            {/* Says what is actually true rather than pretending to be live. */}
            <span className="text-xs text-muted-foreground">
              Live updates unavailable — refreshing every few seconds instead
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {present.length > 0 && (
          <>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              In the room
            </span>
            <div className="flex -space-x-1.5">
              {present.slice(0, 6).map((p) => (
                <span
                  key={p.user_id}
                  title={`${p.name} · ${p.role}`}
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
            </div>
            {present.length > 6 && (
              <span className="text-[10px] text-muted-foreground">+{present.length - 6}</span>
            )}
          </>
        )}
        {facilitator && (
          <span className="text-[10px] text-muted-foreground">You can add to any panel</span>
        )}
      </div>
    </section>
  );
}

function Quadrant({
  category,
  focused,
  factors,
  categories,
  canAdd,
  canMove,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onAdd,
  onSave,
  onDelete,
  onMoveStart,
  onMoveTo,
  savingId,
  deletingId,
}: {
  category: FactorCategory;
  focused: boolean;
  factors: Factor[];
  categories: FactorCategory[];
  canAdd: boolean;
  canMove: boolean;
  isDropTarget: boolean;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: (factorId: string) => void;
  onAdd: (title: string) => void;
  onSave: (id: string, input: { title: string; description: string }) => void;
  onDelete: (id: string) => void;
  onMoveStart: (id: string) => void;
  onMoveTo: (factorId: string, categoryKey: string) => void;
  savingId: string | null;
  deletingId: string | null;
}) {
  const [draft, setDraft] = useState("");
  const tint = `var(--${category.color_token})`;

  const movable = factors.filter((f) => f.state !== "approved" && f.state !== "rejected");

  return (
    <section
      onDragOver={(e) => {
        if (!canMove) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDrop(id);
      }}
      className={cn(
        "console-panel flex min-h-56 flex-col transition-shadow",
        isDropTarget && "shadow-lg",
      )}
      style={{
        borderColor: focused || isDropTarget ? tint : undefined,
        ...(focused ? { boxShadow: `inset 0 2px 0 0 ${tint}` } : {}),
      }}
      aria-label={category.name}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
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
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {factors.length}
        </span>
      </div>

      {focused && category.guidance_text && (
        <p className="border-b border-border/60 px-3 py-2 text-xs leading-snug text-muted-foreground">
          {category.guidance_text}
        </p>
      )}

      <div className="flex flex-1 flex-col gap-2 p-3">
        {factors.map((f) => (
          <StickyNote
            key={f.id}
            factor={f}
            category={category}
            canEdit={canMove}
            canMove={canMove}
            onSave={(input) => onSave(f.id, input)}
            onDelete={() => onDelete(f.id)}
            onMoveStart={() => onMoveStart(f.id)}
            isSaving={savingId === f.id}
            isDeleting={deletingId === f.id}
          />
        ))}

        {factors.length === 0 && !canAdd && (
          <p className="text-xs text-muted-foreground">Nothing here yet.</p>
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
            className="mt-auto"
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
                maxLength={120}
                placeholder="Add a note…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                className="w-full resize-none bg-transparent text-sm leading-snug outline-none placeholder:text-muted-foreground"
              />
            </div>
          </form>
        )}
      </div>

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
    </section>
  );
}
