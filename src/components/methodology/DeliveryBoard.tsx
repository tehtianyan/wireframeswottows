import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, GripVertical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { usePointerDrag } from "@/lib/usePointerDrag";
import {
  deliveryApi,
  workshopsApi,
  type DeliveryBoard as Board,
  type DeliveryItem,
  type MethodologyStage,
  type WorkshopDetail,
} from "@/lib/api";

// The delivery board — the kanban on the Reporting stage.
//
// WHAT IT IS FOR. The workshop finishes with agreed, ranked actions, and then
// somebody has to do them. Until this existed the trail stopped at a report:
// an action looked identical whether it was finished or forgotten. The board
// is the columns the methodology declares, and the export hands the lot to
// the tracker the work will really be managed in.
//
// NOTHING HERE NAMES A COLUMN. "To Do", "In Progress" and "Done" arrive from
// the server's reading of the report stage's config, and this file neither
// names one nor assumes how many there are — `boardColumns` lays out whatever
// comes back, the same function the capture board and the relationship matrix
// use. A literal "Done" in this component would be the bug `pkg/weights`
// forbids for scale bounds, one layer up.
//
// IT MOVES CARDS BETWEEN COLUMNS AND DOES NOT REORDER WITHIN ONE. The order
// inside a column is the rank the facilitator already set on the TOWS matrix,
// in front of the room, with the ratings visible — which is exactly why that
// order outranks the aggregate. A second hand-set order here would be a
// second authority over the same question, and a drag on this screen could
// silently overrule the decision the workshop took. So each card shows its
// rank and its rating, and a drag changes only its column.

export function DeliveryBoard({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const [exporting, setExporting] = useState(false);

  const boardQuery = useQuery({
    queryKey: ["delivery", workshop.id, stage.key],
    queryFn: () => deliveryApi.get(workshop.id, stage.key),
    // A stage that declares no board answers with a refusal, which is a
    // normal answer here rather than an error worth retrying.
    retry: false,
  });

  const weightsQuery = useQuery({
    queryKey: ["weights", workshop.id],
    queryFn: () => workshopsApi.weights(workshop.id),
  });

  const board = boardQuery.data;

  const move = useMutation({
    mutationFn: ({ id, state }: { id: string; state: string }) =>
      deliveryApi.setState(workshop.id, id, stage.key, state),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["delivery", workshop.id] });
      toast.success(`Moved to ${r.state_name}.`);
    },
    onError: (e: Error) => {
      // The optimistic placement is discarded by the refetch, so the card
      // returns to where it really is rather than lying about having moved.
      queryClient.invalidateQueries({ queryKey: ["delivery", workshop.id] });
      toast.error(e.message);
    },
  });

  // OPTIMISTIC, WITH THE REFETCH AS THE ARBITER. Waiting for the round trip
  // before the card moves is the lag the capture board's drag was rewritten to
  // remove; this is the client's own mutation, not a row arriving from the
  // Realtime socket, so it is not the thing the authorization model forbids.
  const [pending, setPending] = useState<Record<string, string>>({});

  const stateOf = (it: DeliveryItem) => pending[it.id] ?? it.state;

  const drag = usePointerDrag<DeliveryItem, string>({
    // READ OUT OF THE LIVE DOM, never from rectangles collected when the drag
    // began: a column scrolls internally and the page scrolls under the
    // pointer, so a cached box is the wrong answer by the time it is used.
    hitTest: (x, y) => {
      for (const el of document.elementsFromPoint(x, y)) {
        const col = (el as HTMLElement).closest<HTMLElement>("[data-delivery-column]");
        if (col) return col.dataset["deliveryColumn"] ?? null;
      }
      return null;
    },
    sameTarget: (a, b) => a === b,
    onDrop: (item, stateKey) => {
      if (!stateKey || stateKey === stateOf(item)) return;
      setPending((p) => ({ ...p, [item.id]: stateKey }));
      move.mutate({ id: item.id, state: stateKey });
    },
  });

  const ratings = useMemo(() => {
    const m = new Map<string, { value: number; voters: number }>();
    if (!board?.weight_key) return m;
    for (const a of weightsQuery.data?.totals ?? []) {
      if (a.weight_key !== board.weight_key) continue;
      m.set(a.object_id, { value: a.value, voters: a.voters });
    }
    return m;
  }, [weightsQuery.data, board?.weight_key]);

  // "NOT YET RATED" IS A CLAIM, SO IT WAITS FOR THE ANSWER. The ratings load
  // in a second request, and while it is in flight every card has no entry in
  // the map — so the card said "not yet rated" about work the room HAD rated,
  // confidently, for as long as the request took. A screenshot caught it; the
  // suite could not, because by the time it asserts, both requests have
  // resolved. Same rule as the presence dot: an absent figure is honest and a
  // wrong one is a guess.
  const ratingsKnown = !weightsQuery.isPending;

  // The denominator the voter count needs to mean anything — the same rule the
  // leaderboard, the report and the note's own pill follow.
  const contributors = board?.weight_key
    ? (weightsQuery.data?.participation?.[board.weight_key]?.contributors ?? 0)
    : 0;

  const download = async () => {
    setExporting(true);
    try {
      await deliveryApi.downloadJira(workshop.id, stage.key, `${workshop.name}-jira.csv`);
      toast.success("Jira import file downloaded.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // A stage that declares no board renders nothing at all, which is how the
  // other seven methodologies are unaffected. The refusal is not an error
  // message to show — there is simply no board here.
  if (boardQuery.isError || !board) return null;

  const byState = (key: string) => board.items.filter((it) => stateOf(it) === key);

  return (
    <section className="console-panel" data-build="live" data-delivery-board>
      <PanelHeading
        build="live"
        title={board.label}
        hint={`${board.items.length} ${board.item_label.toLowerCase()}${
          board.items.length === 1 ? "" : "s"
        }`}
        action={
          board.exports.includes("jira") ? (
            <Button size="sm" variant="outline" onClick={download} disabled={exporting}>
              {exporting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              Export to Jira
            </Button>
          ) : undefined
        }
      />

      <p className="border-b border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
        {board.can_move
          ? `Drag a card to change where it stands. The order inside a column is the rank set on the matrix, and a card keeps it — moving one changes only its column.`
          : `Where each ${board.item_label.toLowerCase()} stands. A facilitator or analyst moves the cards.`}
      </p>

      {board.items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          Nothing to deliver yet. {board.item_label}s agreed in the workshop appear here.
        </p>
      ) : (
        /* A KANBAN IS ONE ROW OF EQUAL COLUMNS, so this is NOT `boardColumns`
           — that function answers "how do I lay out N panels in a block" and
           gives 2x2 for four, which on a four-state board would stack Done
           underneath To Do and stop being a kanban.

           `auto-fit` WITH A FLOOR, and the first version was a wrapping FLEX
           row instead. That measured correctly at 1440px and came out
           303/303/618 at 900: two columns wrapped and the third, alone on its
           line, took the whole of it — a flex LINE shares out its own free
           space, which is the same trap the stage tiles fell into. A grid's
           tracks are shared by every row, so the columns stay equal at every
           width, and `auto-fit` collapses the tracks nothing occupies rather
           than leaving gaps.

           The floor is BELOW the width being filled: three at 13rem is 624px
           against a 1192px content column, so they can actually be grown out
           of — the capture board shipped a "fix" whose floor was wider than
           its container and changed nothing on screen. Found by measuring the
           real document; every source check passed on the flex version. */
        <div
          className="grid gap-3 p-4"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(13rem, 1fr))" }}
          data-delivery-grid
        >
          {board.states.map((s) => {
            const items = byState(s.key);
            const isTarget = drag.target === s.key;
            return (
              <div
                key={s.key}
                data-delivery-column={s.key}
                className={cn(
                  "flex min-w-0 flex-col rounded-sm border border-border bg-card/40",
                  isTarget && "border-primary/70 bg-primary/5",
                )}
              >
                <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="label-caps">{s.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{items.length}</span>
                </div>
                {s.description && (
                  <p className="border-b border-border/60 px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
                    {s.description}
                  </p>
                )}
                <div className="flex-1 space-y-2 overflow-y-auto overscroll-contain p-2 [max-height:28rem]">
                  {items.length === 0 ? (
                    <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
                      Nothing here.
                    </p>
                  ) : (
                    items.map((it) => (
                      <Card
                        key={it.id}
                        item={it}
                        rating={ratings.get(it.id)}
                        ratingsKnown={ratingsKnown}
                        contributors={contributors}
                        canMove={board.can_move}
                        lifting={drag.drag?.id === it.id}
                        onPointerDown={board.can_move ? drag.dragHandlers(it).onPointerDown : undefined}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* The ghost is portalled by the hook and its transform is written to
          the node in a rAF callback, never to React state — pointer
          coordinates in state re-render the whole board on every mouse move,
          which is the one reliable way to recreate the stutter the capture
          board's drag was rewritten to remove. */}
      <div
        ref={drag.ghostRef}
        hidden={!drag.drag}
        className="pointer-events-none fixed left-0 top-0 z-50 max-w-[16rem] rounded-sm border border-primary/60 bg-card px-2.5 py-1.5 text-xs shadow-lg"
      >
        {drag.drag?.title}
      </div>
    </section>
  );
}

function Card({
  item,
  rating,
  ratingsKnown,
  contributors,
  canMove,
  lifting,
  onPointerDown,
}: {
  item: DeliveryItem;
  rating?: { value: number; voters: number } | undefined;
  /** False while the ratings are still loading — see the board. */
  ratingsKnown: boolean;
  contributors: number;
  canMove: boolean;
  lifting: boolean;
  onPointerDown?: ((e: React.PointerEvent<HTMLElement>) => void) | undefined;
}) {
  return (
    <article
      data-delivery-card={item.id}
      onPointerDown={onPointerDown}
      className={cn(
        "rounded-sm border border-border bg-card p-2.5",
        canMove && "cursor-grab",
        lifting && "opacity-40",
      )}
    >
      <div className="flex items-start gap-1.5">
        {canMove && <GripVertical className="mt-0.5 size-3 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium leading-snug">{item.title}</p>
          {item.group_title && (
            <p className="mt-1 truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              {item.group_title}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* THE RANK THE ROOM SET, kept visible beside the rating it may
            disagree with. Both numbers on screen is the whole point: the
            facilitator's order is the decision and the average is the room's
            view, and hiding either makes the other look unanimous. */}
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          #{item.rank + 1}
        </span>
        {item.type_key && (
          <span
            className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground"
            title={item.type_name}
          >
            {item.type_key}
          </span>
        )}
        {rating ? (
          <span
            className="rounded-sm bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            title={
              contributors > 0
                ? `Rated by ${rating.voters} of ${contributors} who took part`
                : `Rated by ${rating.voters}`
            }
          >
            {trim(rating.value)}
            <span className="ml-1 text-muted-foreground">
              ({rating.voters} {rating.voters === 1 ? "rater" : "raters"})
            </span>
          </span>
        ) : ratingsKnown ? (
          <span className="font-mono text-[10px] text-muted-foreground">not yet rated</span>
        ) : null}
        {/* UNAGREED WORK SAYS SO. An action nobody has approved looks exactly
            like one the room signed off, and on a delivery board that reads as
            a commitment. */}
        {item.object_state !== "approved" && (
          <span className="rounded-sm border border-warning/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-warning">
            {item.object_state}
          </span>
        )}
      </div>
    </article>
  );
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
