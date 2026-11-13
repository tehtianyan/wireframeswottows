import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  Download,
  GripVertical,
  Hourglass,
  Loader2,
  TrendingUp,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { usePointerDrag } from "@/lib/usePointerDrag";
import {
  DELIVERY_FIELD_GROUP,
  deliveryApi,
  objectKindsApi,
  participantsApi,
  workshopsApi,
  type DeliveryBoard as Board,
  type DeliveryItem,
  type MethodologyStage,
  type ObjectField,
  type Participant,
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

  // ---- the plan behind a card ----
  const [planning, setPlanning] = useState<DeliveryItem | null>(null);

  // THE FORM IS BUILT FROM THE REGISTRY, not written out here. The server
  // declares which fields belong to the delivery group, their types, their
  // bounds and their option labels; a second list in this file would be the
  // place the two drift, and adding a unit would then mean editing both.
  const kindsQuery = useQuery({
    queryKey: ["object-kinds"],
    queryFn: () => objectKindsApi.list(),
    staleTime: Infinity,
  });
  const deliverable = (kindsQuery.data ?? []).find((k) => k.key === board?.kind);
  const planFields = useMemo(
    () => (deliverable?.fields ?? []).filter((f) => f.group === DELIVERY_FIELD_GROUP),
    [deliverable],
  );

  /**
   * The registry's words for a stored unit key.
   *
   * ONE LIST, ON THE SERVER. A copy here is where the two drift, and the
   * symptom is a card reading "money_annual" — which only gets noticed by
   * whoever has to explain it in a steering meeting. An unknown key prints
   * itself rather than vanishing, so a value stored before a unit was renamed
   * is still legible.
   */
  const unitLabel = useMemo(() => {
    const f = planFields.find((x) => x.name === "value_unit");
    const map = new Map<string, string>();
    (f?.options ?? []).forEach((o, i) => map.set(o, f?.option_labels?.[i] ?? o));
    return (key: string) => map.get(key) ?? key;
  }, [planFields]);

  // The roster, for the owner picker. Only fetched where somebody can edit.
  const rosterQuery = useQuery({
    queryKey: ["participants", workshop.id],
    queryFn: () => participantsApi.list(workshop.id),
    enabled: Boolean(board?.can_move),
  });
  const roster = rosterQuery.data ?? [];

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
                        onPlan={board.can_move ? () => setPlanning(it) : undefined}
                        unitLabel={unitLabel}
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

      {/* WHAT IT TAKES TO DELIVER IT, behind the card rather than on it.
          Eight fields on a kanban card would bury the one thing the board is
          scanned for — where the work stands — so the card shows only what
          has been filled in, and the rest is a click away. */}
      {planning && board && (
        <PlanDialog
          workshopId={workshop.id}
          stageKey={stage.key}
          item={planning}
          fields={planFields}
          roster={roster}
          onClose={() => setPlanning(null)}
          onSaved={() => {
            setPlanning(null);
            queryClient.invalidateQueries({ queryKey: ["delivery", workshop.id] });
          }}
        />
      )}
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
  onPlan,
  unitLabel,
}: {
  item: DeliveryItem;
  rating?: { value: number; voters: number } | undefined;
  /** False while the ratings are still loading — see the board. */
  ratingsKnown: boolean;
  contributors: number;
  canMove: boolean;
  lifting: boolean;
  onPointerDown?: ((e: React.PointerEvent<HTMLElement>) => void) | undefined;
  /** Opens the owner/dates/effort/value form. Absent for a reader. */
  onPlan?: (() => void) | undefined;
  /** The registry's words for a stored unit key — never a second list. */
  unitLabel: (key: string) => string;
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

      {/* ONLY WHAT HAS BEEN FILLED IN. An empty "Owner: —" on every card
          would be eight rows of nothing on a board whose job is to be
          scanned, and would read as a form the facilitator failed to
          complete rather than one they chose to skip. */}
      <PlanSummary item={item} unitLabel={unitLabel} />

      {onPlan && (
        <button
          type="button"
          // NOT A DRAG. The card itself is the drag handle, so a press that
          // reaches this button must not also lift the card — the same rule
          // the matrix's "+N more" follows.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onPlan}
          className="mt-2 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <CalendarClock className="size-3" />
          {hasPlan(item) ? "Edit plan" : "Add owner, dates, effort, value"}
        </button>
      )}
    </article>
  );
}

/** True when any delivery detail has been recorded. */
function hasPlan(it: DeliveryItem): boolean {
  return Boolean(
    it.owner_name ||
      it.start_date ||
      it.end_date ||
      it.effort_person_days !== null ||
      it.value_amount !== null,
  );
}

function PlanSummary({
  item,
  unitLabel,
}: {
  item: DeliveryItem;
  unitLabel: (key: string) => string;
}) {
  const bits: { key: string; icon: ReactNode; text: string; title?: string }[] = [];
  if (item.owner_name) {
    bits.push({ key: "owner", icon: <User className="size-3" />, text: item.owner_name });
  }
  const when =
    item.start_date && item.end_date
      ? `${item.start_date} → ${item.end_date}`
      : item.end_date
        ? `due ${item.end_date}`
        : item.start_date
          ? `from ${item.start_date}`
          : "";
  if (when) bits.push({ key: "when", icon: <CalendarClock className="size-3" />, text: when });
  if (item.effort_person_days !== null) {
    bits.push({
      key: "effort",
      icon: <Hourglass className="size-3" />,
      text: `${trim(item.effort_person_days)}d`,
      title: `${trim(item.effort_person_days)} person-days of effort`,
    });
  }
  if (item.value_amount !== null && item.value_unit) {
    bits.push({
      key: "value",
      icon: <TrendingUp className="size-3" />,
      // Compact on the card; the unit and the basis are in the title, and in
      // full in the dialog and the export.
      text: compactNumber(item.value_amount),
      title:
        `${item.value_amount.toLocaleString()} — ${unitLabel(item.value_unit)}` +
        (item.value_basis ? `\n${item.value_basis}` : ""),
    });
  }
  if (bits.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/60 pt-1.5">
      {bits.map((b) => (
        <span
          key={b.key}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
          {...(b.title ? { title: b.title } : {})}
        >
          {b.icon}
          <span className="font-mono">{b.text}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * 450000 reads as "450k" on a card.
 *
 * The exact figure is in the tooltip, the dialog and the export — a card is
 * scanned, and twelve digits in a 13rem column wraps and pushes the row.
 */
function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${trim(n / 1_000_000_000)}bn`;
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}m`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return trim(n);
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * The owner, the dates, the effort and the value — built from the registry.
 *
 * EVERY FIELD IS OPTIONAL AND THE FORM SAYS SO. These are filled against the
 * clock, often in the last ten minutes of a session, and the requirement was
 * explicit: "optional fields so that the facilitator can skip these when he is
 * out of time." A required input here would stop the action being recorded.
 *
 * NOTHING ABOUT THE FIELDS IS WRITTEN OUT HERE. The server sends their names,
 * types, bounds and option labels; this renders whatever arrives in the
 * delivery group. Adding a unit is a line in pkg/objects, not an edit here and
 * another there.
 */
function PlanDialog({
  workshopId,
  stageKey,
  item,
  fields,
  roster,
  onClose,
  onSaved,
}: {
  workshopId: string;
  stageKey: string;
  item: DeliveryItem;
  fields: ObjectField[];
  roster: Participant[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Seeded from the card, so re-opening shows what is already recorded
  // rather than an empty form that would clear it on save.
  const [values, setValues] = useState<Record<string, string>>(() => ({
    owner_user_id: item.owner_user_id ?? "",
    // Only the TYPED name belongs in the text box. Seeding it with a roster
    // member's resolved name would make saving write both halves of a pair
    // the database refuses, and the server would then clear the account.
    owner_name: item.owner_user_id ? "" : item.owner_name,
    start_date: item.start_date ?? "",
    end_date: item.end_date ?? "",
    effort_person_days: item.effort_person_days === null ? "" : String(item.effort_person_days),
    value_amount: item.value_amount === null ? "" : String(item.value_amount),
    value_unit: item.value_unit,
    value_basis: item.value_basis,
  }));
  const set = (name: string, v: string) => setValues((s) => ({ ...s, [name]: v }));

  const save = useMutation({
    mutationFn: () => {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = (values[f.name] ?? "").trim();
        if (raw === "") {
          // EXPLICIT NULL, NOT OMISSION. Clearing a field somebody filled in
          // last week has to reach the database; omitting the key would mean
          // "leave it alone", and the value would quietly survive.
          out[f.name] = null;
          continue;
        }
        out[f.name] = f.type === "decimal" || f.type === "int" ? Number(raw) : raw;
      }
      return deliveryApi.setPlan(workshopId, item.id, stageKey, out);
    },
    onSuccess: () => {
      toast.success("Saved.");
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The pair the database refuses: naming somebody on the roster and typing a
  // name are the same question answered twice. Choosing one clears the other
  // HERE as well as on the server, so the form never shows a state it would
  // refuse to save.
  const chooseMember = (id: string) =>
    setValues((s) => ({ ...s, owner_user_id: id, owner_name: id ? "" : (s["owner_name"] ?? "") }));
  const typeName = (name: string) =>
    setValues((s) => ({
      ...s,
      owner_name: name,
      owner_user_id: name ? "" : (s["owner_user_id"] ?? ""),
    }));

  const field = (name: string) => fields.find((f) => f.name === name);
  const amount = field("value_amount");
  const unit = field("value_unit");

  return (
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Delivery detail"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="console-panel max-h-[85vh] w-full max-w-lg overflow-y-auto p-4"
      >
        <div className="mb-3">
          <p className="text-sm font-medium leading-snug">{item.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            All of this is optional — fill in what you know and move on.
          </p>
        </div>

        <div className="space-y-3">
          {/* ---- owner: the roster, or a name ---- */}
          {field("owner_user_id") && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="label-caps">{field("owner_user_id")!.label}</span>
                <select
                  value={values["owner_user_id"] ?? ""}
                  onChange={(e) => chooseMember(e.target.value)}
                  className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-xs"
                >
                  <option value="">Nobody yet</option>
                  {roster.map((p) => (
                    <option key={p.user_id} value={p.user_id}>
                      {p.name || p.email}
                    </option>
                  ))}
                </select>
              </label>
              {field("owner_name") && (
                <label className="block">
                  <span className="label-caps">{field("owner_name")!.label}</span>
                  <Input
                    value={values["owner_name"] ?? ""}
                    onChange={(e) => typeName(e.target.value)}
                    placeholder="Somebody not in the room"
                    className="mt-1 h-8 text-xs"
                  />
                </label>
              )}
            </div>
          )}

          {/* ---- when ---- */}
          <div className="grid gap-2 sm:grid-cols-2">
            {(["start_date", "end_date"] as const).map((name) => {
              const f = field(name);
              if (!f) return null;
              return (
                <label key={name} className="block">
                  <span className="label-caps">{f.label}</span>
                  <Input
                    type="date"
                    value={values[name] ?? ""}
                    onChange={(e) => set(name, e.target.value)}
                    className="mt-1 h-8 text-xs"
                  />
                </label>
              );
            })}
          </div>

          {/* ---- effort ---- */}
          {field("effort_person_days") && (
            <label className="block">
              <span className="label-caps">{field("effort_person_days")!.label}</span>
              <Input
                type="number"
                min={0}
                step="0.5"
                value={values["effort_person_days"] ?? ""}
                onChange={(e) => set("effort_person_days", e.target.value)}
                placeholder="e.g. 12.5"
                className="mt-1 h-8 text-xs"
              />
              {field("effort_person_days")!.help && (
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  {field("effort_person_days")!.help}
                </span>
              )}
            </label>
          )}

          {/* ---- the value, as an amount AND a unit ---- */}
          {amount && unit && (
            <div className="space-y-2 rounded-sm border border-border/60 p-2.5">
              <div className="grid gap-2 sm:grid-cols-[1fr_1.3fr]">
                <label className="block">
                  <span className="label-caps">{amount.label}</span>
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={values["value_amount"] ?? ""}
                    onChange={(e) => set("value_amount", e.target.value)}
                    placeholder="e.g. 450000"
                    className="mt-1 h-8 text-xs"
                  />
                </label>
                <label className="block">
                  <span className="label-caps">{unit.label}</span>
                  <select
                    value={values["value_unit"] ?? ""}
                    onChange={(e) => set("value_unit", e.target.value)}
                    className="mt-1 h-8 w-full rounded-sm border border-border bg-background px-2 text-xs"
                  >
                    <option value="">Choose a unit</option>
                    {(unit.options ?? []).map((o, i) => (
                      <option key={o} value={o}>
                        {unit.option_labels?.[i] ?? o}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {/* THE AMOUNT AND THE UNIT STAND OR FALL TOGETHER — the database
                  says so, and saying it here means the facilitator finds out
                  while typing rather than when the save is refused. */}
              {Boolean(values["value_amount"]) !== Boolean(values["value_unit"]) && (
                <p className="text-[10px] text-warning">
                  A figure needs a unit, and a unit needs a figure — otherwise neither is
                  saved.
                </p>
              )}
              {field("value_basis") && (
                <label className="block">
                  <span className="label-caps">{field("value_basis")!.label}</span>
                  <Input
                    value={values["value_basis"] ?? ""}
                    onChange={(e) => set("value_basis", e.target.value)}
                    placeholder="e.g. 3% churn reduction on $15M ARR"
                    className="mt-1 h-8 text-xs"
                  />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
