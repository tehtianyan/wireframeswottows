import { Loader2 } from "lucide-react";
import { WeightControl } from "@/components/methodology/WeightControl";
import { weightLabel, type WeightDefinition } from "@/lib/api";

/**
 * The group's rating of one theme, and the caller's own contribution to it.
 *
 * Used on the capture board, where the room groups notes into themes and then
 * rates those themes — the prioritisation step that used to be a stage of its
 * own. The scale, the step and who may set it all come from
 * `methodology_weights`, so this component names no methodology and no range:
 * SWOT-TOWS rates a theme 1-5 averaged across participants, Porter's Five
 * Forces rates a force assessment 1-5 with one agreed value, and both render
 * through `WeightControl` from their own definitions.
 *
 * TWO NUMBERS, NEVER ONE. The group figure always carries how many people are
 * behind it. An average of 4.5 from two people is not the finding 4.5 from
 * eleven is, and on a wall the whole room is looking at, a bare figure reads
 * as agreement. The same rule the leaderboard and the report already follow.
 *
 * The count is shown only when the weight is `per_participant`: "1 rater" on a
 * single agreed value would mislead in the other direction, implying a lone
 * opinion where the methodology asked for one considered number.
 *
 * Note for callers: this is passed into the board as a NODE, and the board
 * spreads the prop conditionally rather than passing `undefined`, because
 * `exactOptionalPropertyTypes` refuses an explicit undefined on an optional
 * prop — the same reason the AI slot is spread.
 */
export function ThemeRating({
  definition,
  mine,
  total,
  voters,
  contributors,
  canRate,
  pending,
  onRate,
  themeTitle,
}: {
  definition: WeightDefinition;
  /** The caller's own value, or undefined when they have not rated. */
  mine: number | undefined;
  /** The rolled-up group figure, or undefined when nobody has rated. */
  total: number | undefined;
  /** How many people are behind `total`. */
  voters: number | undefined;
  /** How many people have rated anything with this weight — the denominator. */
  contributors: number | undefined;
  canRate: boolean;
  pending: boolean;
  onRate: (value: number | null) => void;
  themeTitle: string;
}) {
  const perParticipant = definition.per_participant;

  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-dashed border-border/60 pt-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="label-caps shrink-0 text-[10px]">{definition.name}</span>
        {total === undefined ? (
          <span className="font-mono text-[10px] text-muted-foreground">not yet rated</span>
        ) : (
          <span
            className="font-mono text-[11px] tabular-nums"
            // The denominator goes in the title rather than on the wall, the
            // way the note's score pill carries it: the figure and its backing
            // belong together, and "of 12 contributors" on every theme would
            // crowd a panel that is mostly notes.
            title={
              perParticipant && contributors !== undefined
                ? `${formatValue(total)} — from ${voters ?? 0} of ${contributors} who have rated`
                : weightLabel(definition, total)
            }
          >
            {formatValue(total)}
            {perParticipant && voters !== undefined && (
              <span className="ml-1 text-muted-foreground">
                ({voters} {voters === 1 ? "rater" : "raters"})
              </span>
            )}
          </span>
        )}
        {pending && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {canRate ? (
        <WeightControl
          definition={definition}
          value={mine}
          disabled={pending}
          pending={pending}
          onChange={onRate}
          itemLabel={themeTitle}
        />
      ) : (
        // SAID, NOT HIDDEN. A control that silently is not there looks like a
        // feature that has not loaded. SWOT-TOWS allows participants only, so
        // a facilitator reading the room's average needs to know the absence
        // is deliberate — the same reasoning as omitting the presence dot
        // rather than drawing a grey one.
        <span className="font-mono text-[10px] text-muted-foreground">
          {describeRaters(definition)}
        </span>
      )}
    </div>
  );
}

/** Trailing zeros off a mean: "4" rather than "4.0", "3.7" rather than "3.70". */
function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * Who may rate, in the methodology's own terms. Built from `allowed_roles`
 * rather than written out, so a methodology that allows analysts says so
 * without this file being edited.
 */
function describeRaters(definition: WeightDefinition): string {
  const roles = definition.allowed_roles;
  if (roles.length === 0) return "not rateable";
  const names = roles.map((r) => r.replace(/_/g, " "));
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} only`;
}
