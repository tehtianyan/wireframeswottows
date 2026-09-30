import { useMemo, useState } from "react";
import { Trophy } from "lucide-react";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import type {
  Factor,
  FactorCategory,
  WeightAggregate,
  WeightDefinition,
  WeightParticipation,
} from "@/lib/api";

// The aggregated result of the prioritize stage — App Spec §4.12 Step 4-5,
// "Results displayed / Top-ranked factors identified".
//
// The grid below this ranks WITHIN each category column, which is wireframe
// §3.19 and is what a participant needs while allocating. But the question the
// stage exists to answer is "what did the group prioritise?", and that is a
// single ranking ACROSS categories. Without it the totals were on screen but
// never added up: nothing told you the top factor overall.
//
// TWO NUMBERS, NOT ONE. Every row shows its total and how many people are
// behind it, against how many have allocated at all. A total on its own reads
// as agreement even when one enthusiast produced it, and that misreading is
// exactly what a prioritization screen must not encourage.
//
// Nothing here names a weight or a scale. It ranks by the stage's primary
// weight definition, so it is a vote leaderboard for SWOT-TOWS and a severity
// ranking for an operating-model assessment, from the same component.

const MEDAL = ["text-amber-500", "text-zinc-400", "text-amber-700"];

export function PriorityLeaderboard({
  definition,
  factors,
  categories,
  totals,
  participation,
}: {
  /** The weight to rank by — the stage's first, from config. */
  definition: WeightDefinition;
  factors: Factor[];
  categories: FactorCategory[];
  totals: WeightAggregate[];
  participation: WeightParticipation | undefined;
}) {
  const [showAll, setShowAll] = useState(false);

  const byCategory = useMemo(
    () => new Map(categories.map((c) => [c.key, c])),
    [categories],
  );

  const rows = useMemo(() => {
    const agg = new Map<string, WeightAggregate>();
    for (const t of totals) {
      if (t.weight_key === definition.key) agg.set(t.object_id, t);
    }
    return factors
      .map((f) => ({
        factor: f,
        value: agg.get(f.id)?.value ?? 0,
        voters: agg.get(f.id)?.voters ?? 0,
        label: agg.get(f.id)?.label ?? "",
      }))
      // Ties break on the wider backing, then alphabetically, so the order is
      // stable between renders rather than shifting under the reader.
      .sort(
        (a, b) =>
          b.value - a.value ||
          b.voters - a.voters ||
          a.factor.title.localeCompare(b.factor.title),
      );
  }, [factors, totals, definition.key]);

  const ranked = rows.filter((r) => r.value > 0);
  const unranked = rows.length - ranked.length;
  const contributors = participation?.contributors ?? 0;
  const allocated = participation?.allocated ?? 0;
  const top = ranked[0]?.value ?? 0;

  if (ranked.length === 0) {
    return (
      <section className="console-panel" data-build="live">
        <PanelHeading build="live" title={`${definition.name} — group total`} />
        <p className="p-4 text-xs text-muted-foreground">
          Nobody has allocated yet. Once people start, the group's ranking appears here.
        </p>
      </section>
    );
  }

  const visible = showAll ? ranked : ranked.slice(0, 10);

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title={`${definition.name} — group total`}
        hint={`${contributors} ${contributors === 1 ? "person has" : "people have"} allocated · ${allocated} spent`}
      />

      <ol className="divide-y divide-border">
        {visible.map((row, i) => {
          const category = byCategory.get(row.factor.category_key);
          const tint = category ? `var(--${category.color_token})` : undefined;
          return (
            <li key={row.factor.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <span
                className={cn(
                  "w-5 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums",
                  i < 3 ? MEDAL[i] : "text-muted-foreground",
                )}
              >
                {i + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{row.factor.title}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {category && (
                    <span
                      className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                      style={{ borderColor: tint, color: tint }}
                    >
                      {category.name}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {row.voters} of {contributors || row.voters}{" "}
                    {(contributors || row.voters) === 1 ? "contributor" : "contributors"}
                  </span>
                </div>

                {/* Bar relative to the leader, so the SHAPE of the result is
                    readable — a runaway favourite looks different from a flat
                    spread, and that difference is the facilitator's cue. */}
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-elevated">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: top > 0 ? `${Math.max(2, (row.value / top) * 100)}%` : "0%",
                      background: tint ?? "var(--foreground)",
                    }}
                  />
                </div>
              </div>

              <div className="shrink-0 text-right">
                <span className="font-mono text-sm font-semibold tabular-nums">{row.value}</span>
                {row.label && (
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    {row.label}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3.5 py-2">
        <span className="text-[11px] text-muted-foreground">
          {unranked > 0
            ? `${unranked} factor${unranked === 1 ? "" : "s"} received nothing — worth a look before the stage closes.`
            : "Every factor has been allocated something."}
        </span>
        {ranked.length > 10 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {showAll ? "Show top 10" : `Show all ${ranked.length}`}
          </button>
        )}
      </div>
    </section>
  );
}
