import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import { FactorStatePill } from "./FactorCard";
import { WeightControl } from "./WeightControl";
import {
  workshopsApi,
  type Factor,
  type FactorCategory,
  type Methodology,
  type MethodologyStage,
  type WeightDefinition,
  type WorkshopRole,
} from "@/lib/api";

// The prioritize stage (wireframe §3, App Spec §6.7).
//
// It renders one column per factor category the methodology defines — four for
// SWOT-TOWS, six for PESTLE — and, in each, whichever WEIGHTS the methodology
// attaches to a factor. For SWOT-TOWS that is a single budget of votes, which
// is why this screen looks unchanged. For a risk methodology it is likelihood
// and impact on their own scales, from the same component.
//
// Nothing here knows a scale or a budget. Both come from the weight
// definitions, which come from configuration.

export function PrioritizationGrid({
  workshopId,
  methodology,
  stage,
  myRole,
}: {
  workshopId: string;
  methodology: Methodology;
  stage: MethodologyStage;
  myRole: WorkshopRole;
}) {
  const queryClient = useQueryClient();

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, "all"],
    queryFn: () => workshopsApi.factors(workshopId),
  });
  const weightsQuery = useQuery({
    queryKey: ["weights", workshopId],
    queryFn: () => workshopsApi.weights(workshopId),
  });

  const setWeight = useMutation({
    mutationFn: (v: { factorId: string; weightKey: string; value: number | null }) =>
      workshopsApi.setWeight(workshopId, "factors", v.factorId, v.weightKey, v.value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["weights", workshopId] });
      queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Which weights this stage surfaces. A stage may name them explicitly; when
  // it does not, every weight the methodology attaches to a factor is shown,
  // which is how the existing vote-only stages keep working untouched.
  const declared = Array.isArray(stage.config["weights"])
    ? (stage.config["weights"] as string[])
    : null;

  const definitions = useMemo(() => {
    const all = (weightsQuery.data?.definitions ?? []).filter((d) => d.applies_to === "factor");
    if (!declared) return all;
    return declared
      .map((key) => all.find((d) => d.key === key))
      .filter((d): d is WeightDefinition => Boolean(d));
  }, [weightsQuery.data, declared]);

  // The caller's own value per (weight, factor).
  const mine = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of weightsQuery.data?.mine ?? []) m.set(`${v.weight_key}:${v.object_id}`, v.value);
    return m;
  }, [weightsQuery.data]);

  // The rolled-up figure per (weight, factor), across everyone.
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of weightsQuery.data?.totals ?? []) m.set(`${t.weight_key}:${t.object_id}`, t.value);
    return m;
  }, [weightsQuery.data]);

  const spent = weightsQuery.data?.spent ?? {};

  const allowed = useMemo(() => {
    const s = new Set<string>();
    for (const d of definitions) if (d.allowed_roles.includes(myRole)) s.add(d.key);
    return s;
  }, [definitions, myRole]);

  // Only factors that survived review are worth weighing. A methodology whose
  // capture stage auto-approves never produces anything in 'submitted', and
  // this filter is then a no-op.
  const eligible = useMemo(
    () => (factorsQuery.data ?? []).filter((f) => f.state !== "rejected"),
    [factorsQuery.data],
  );

  if (factorsQuery.isLoading || weightsQuery.isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading prioritization…
        </div>
      </section>
    );
  }

  if (definitions.length === 0) {
    return (
      <section className="console-panel p-4">
        <p className="text-sm text-muted-foreground">
          This methodology's prioritization stage does not weigh factors.
        </p>
      </section>
    );
  }

  const budgets = definitions.filter((d) => d.constraint_type === "budget");
  const readOnly = allowed.size === 0;

  return (
    <div className="space-y-4">
      {budgets.map((d) => (
        <BudgetPanel
          key={d.key}
          definition={d}
          used={spent[d.key] ?? 0}
          methodologyName={methodology.name}
          canSet={allowed.has(d.key)}
        />
      ))}

      {budgets.length === 0 && (
        <section className="console-panel" data-build="live">
          <PanelHeading build="live" title="Rate each factor" />
          <div className="p-4">
            <p className="text-xs text-muted-foreground">
              {definitions.map((d) => d.name).join(" and ")}
              {definitions.length === 1 ? " is" : " are"} rated per factor
              {definitions[0]?.scale_max !== null
                ? ` on a ${definitions[0]?.scale_min}–${definitions[0]?.scale_max} scale`
                : ""}
              .{readOnly && " Your role is view-only, so you cannot change them."}
            </p>
          </div>
        </section>
      )}

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 260px), 1fr))` }}
      >
        {methodology.factor_categories.map((category) => (
          <CategoryColumn
            key={category.key}
            category={category}
            factors={eligible.filter((f) => f.category_key === category.key)}
            definitions={definitions}
            mine={mine}
            totals={totals}
            spent={spent}
            allowed={allowed}
            onChange={(factorId, weightKey, value) =>
              setWeight.mutate({ factorId, weightKey, value })
            }
            isPending={setWeight.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function BudgetPanel({
  definition,
  used,
  methodologyName,
  canSet,
}: {
  definition: WeightDefinition;
  used: number;
  methodologyName: string;
  canSet: boolean;
}) {
  const budget = definition.constraint_total ?? 0;
  const remaining = budget - used;

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title={`Your ${definition.name.toLowerCase()}`}
        hint={`${used} of ${budget} allocated`}
      />
      <div className="p-4">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-mono text-3xl font-semibold tabular-nums",
              remaining === 0 && "text-muted-foreground",
            )}
          >
            {remaining}
          </span>
          <span className="text-xs text-muted-foreground">
            {definition.name.toLowerCase()} remaining
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
          <div
            className="h-full bg-foreground/60 transition-all"
            style={{ width: budget > 0 ? `${Math.min(100, (used / budget) * 100)}%` : "0%" }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {`${methodologyName} allocates ${budget} per participant.`}
          {definition.guidance_text ? ` ${definition.guidance_text}` : ""}
          {!canSet && " Your role is view-only, so you cannot allocate."}
        </p>
      </div>
    </section>
  );
}

function CategoryColumn({
  category,
  factors,
  definitions,
  mine,
  totals,
  spent,
  allowed,
  onChange,
  isPending,
}: {
  category: FactorCategory;
  factors: Factor[];
  definitions: WeightDefinition[];
  mine: Map<string, number>;
  totals: Map<string, number>;
  spent: Record<string, number>;
  allowed: Set<string>;
  onChange: (factorId: string, weightKey: string, value: number | null) => void;
  isPending: boolean;
}) {
  // Sorted by the first weight's rolled-up figure, highest first — wireframe
  // §3.19. Which weight that is comes from config, not from "votes".
  const primary = definitions[0];
  const sorted = useMemo(() => {
    if (!primary) return factors;
    return [...factors].sort(
      (a, b) =>
        (totals.get(`${primary.key}:${b.id}`) ?? 0) - (totals.get(`${primary.key}:${a.id}`) ?? 0),
    );
  }, [factors, totals, primary]);

  return (
    <section
      className="console-panel"
      data-build="live"
      style={{ "--stage-accent": `var(--${category.color_token})` } as React.CSSProperties}
    >
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span
          className="inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider"
          style={{ borderColor: "var(--stage-accent)", color: "var(--stage-accent)" }}
        >
          {category.name}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{factors.length}</span>
      </div>

      <div className="divide-y divide-border">
        {sorted.length === 0 && (
          <p className="p-3.5 text-xs text-muted-foreground">
            No factors captured in this category.
          </p>
        )}
        {sorted.map((f) => (
          <div key={f.id} className="px-3.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 text-sm font-medium">{f.title}</p>
              {primary && (
                <span
                  className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                  title={`${primary.name} across everyone`}
                >
                  {totals.get(`${primary.key}:${f.id}`) ?? 0}
                </span>
              )}
            </div>
            {f.state !== "approved" && <FactorStatePill state={f.state} className="mt-1.5" />}

            <div className="mt-2 flex flex-col gap-2">
              {definitions.map((d) => {
                const budget = d.constraint_total ?? 0;
                return (
                  <div key={d.key} className="flex flex-col gap-1">
                    {definitions.length > 1 && (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {d.name}
                      </span>
                    )}
                    <WeightControl
                      definition={d}
                      value={mine.get(`${d.key}:${f.id}`)}
                      remaining={budget - (spent[d.key] ?? 0)}
                      disabled={!allowed.has(d.key)}
                      pending={isPending}
                      itemLabel={f.title}
                      onChange={(value) => onChange(f.id, d.key, value)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
