import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { weightLabel, weightSteps, type WeightDefinition } from "@/lib/api";

// One control for every weight a methodology can define.
//
// A weight with a 'budget' constraint renders as the +/- stepper the
// prioritization screen has always used, bounded by what the participant has
// left to spend. A weight with a bounded scale renders as a row of steps —
// 1-5 for a maturity level, -3..+3 for a bipolar rating, 0-100 in fives for a
// percentage.
//
// NOTHING HERE MAY ASSUME A RANGE. Every bound, every step and every label
// comes from the definition. A literal 5, or an array of five anything, is a
// bug: the methodologies seeded today mostly use 1-5, and that is precisely
// how a convention turns into a constant.

export function WeightControl({
  definition,
  value,
  remaining,
  disabled,
  pending,
  onChange,
  itemLabel,
}: {
  definition: WeightDefinition;
  /** The caller's current value, or undefined when unset. */
  value: number | undefined;
  /** Budget left to spend. Ignored unless the constraint is a budget. */
  remaining?: number;
  disabled?: boolean;
  pending?: boolean;
  /** null clears the weight. Zero is a value, not a clear. */
  onChange: (value: number | null) => void;
  /** What is being weighed, for the accessible name on each control. */
  itemLabel: string;
}) {
  if (definition.constraint_type === "budget") {
    return (
      <BudgetStepper
        definition={definition}
        value={value ?? definition.scale_min}
        remaining={remaining ?? 0}
        disabled={disabled ?? false}
        pending={pending ?? false}
        onChange={onChange}
        itemLabel={itemLabel}
      />
    );
  }
  return (
    <ScalePicker
      definition={definition}
      value={value}
      disabled={disabled ?? false}
      pending={pending ?? false}
      onChange={onChange}
      itemLabel={itemLabel}
    />
  );
}

function BudgetStepper({
  definition,
  value,
  remaining,
  disabled,
  pending,
  onChange,
  itemLabel,
}: {
  definition: WeightDefinition;
  value: number;
  remaining: number;
  disabled: boolean;
  pending: boolean;
  onChange: (value: number | null) => void;
  itemLabel: string;
}) {
  const step = definition.scale_step;
  const atFloor = value <= definition.scale_min;
  // A budget weight may also carry a ceiling; honour both when it does.
  const atCeiling =
    remaining < step ||
    (definition.scale_max !== null && value + step > definition.scale_max);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="icon"
        variant="outline"
        className="size-6"
        disabled={disabled || atFloor || pending}
        onClick={() => onChange(value - step)}
        aria-label={`Remove ${definition.name} from ${itemLabel}`}
      >
        <Minus className="size-3" />
      </Button>
      <span className="w-6 text-center font-mono text-xs tabular-nums">{value}</span>
      <Button
        size="icon"
        variant="outline"
        className="size-6"
        disabled={disabled || atCeiling || pending}
        onClick={() => onChange(value + step)}
        aria-label={`Add ${definition.name} to ${itemLabel}`}
      >
        <Plus className="size-3" />
      </Button>
      <span className="ml-1 text-[10px] text-muted-foreground">
        your {definition.name.toLowerCase()}
      </span>
    </div>
  );
}

function ScalePicker({
  definition,
  value,
  disabled,
  pending,
  onChange,
  itemLabel,
}: {
  definition: WeightDefinition;
  value: number | undefined;
  disabled: boolean;
  pending: boolean;
  onChange: (value: number | null) => void;
  itemLabel: string;
}) {
  const steps = weightSteps(definition);

  // An unbounded scale has no steps to lay out, so it takes a number field
  // rather than a row of buttons.
  if (steps.length === 0) {
    return (
      <NumberEntry
        definition={definition}
        value={value}
        disabled={disabled}
        pending={pending}
        onChange={onChange}
        itemLabel={itemLabel}
      />
    );
  }

  // Past a dozen or so steps a button row stops being scannable and starts
  // wrapping into a block — a 0-100 scale in fives is 21 of them.
  if (steps.length > 12) {
    return (
      <SelectEntry
        definition={definition}
        steps={steps}
        value={value}
        disabled={disabled}
        pending={pending}
        onChange={onChange}
        itemLabel={itemLabel}
      />
    );
  }

  const selectedLabel = value === undefined ? undefined : weightLabel(definition, value);

  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex flex-wrap items-center gap-1"
        role="radiogroup"
        aria-label={`${definition.name} for ${itemLabel}`}
      >
        {steps.map((s) => {
          const selected = value !== undefined && Math.abs(value - s) < 1e-9;
          const stepName = weightLabel(definition, s);
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={stepName ? `${s} — ${stepName}` : String(s)}
              title={stepName ?? undefined}
              disabled={disabled || pending}
              // Clicking the selected step again clears it, which is the only
              // way to unset a value on a scale that has no natural zero.
              onClick={() => onChange(selected ? null : s)}
              className={cn(
                "min-w-7 rounded border px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                (disabled || pending) && "cursor-not-allowed opacity-50",
              )}
            >
              {s}
            </button>
          );
        })}
      </div>
      {selectedLabel && (
        <span className="text-[10px] text-muted-foreground">{selectedLabel}</span>
      )}
    </div>
  );
}

function SelectEntry({
  definition,
  steps,
  value,
  disabled,
  pending,
  onChange,
  itemLabel,
}: {
  definition: WeightDefinition;
  steps: number[];
  value: number | undefined;
  disabled: boolean;
  pending: boolean;
  onChange: (value: number | null) => void;
  itemLabel: string;
}) {
  return (
    <select
      id={`weight-${definition.key}-${itemLabel.replace(/\W+/g, "-").toLowerCase()}`}
      aria-label={`${definition.name} for ${itemLabel}`}
      disabled={disabled || pending}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className={cn(
        "rounded border border-border bg-elevated px-2 py-1 font-mono text-xs tabular-nums",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        (disabled || pending) && "cursor-not-allowed opacity-50",
      )}
    >
      <option value="">Not set</option>
      {steps.map((s) => {
        const stepName = weightLabel(definition, s);
        return (
          <option key={s} value={s}>
            {stepName ? `${s} — ${stepName}` : s}
          </option>
        );
      })}
    </select>
  );
}

function NumberEntry({
  definition,
  value,
  disabled,
  pending,
  onChange,
  itemLabel,
}: {
  definition: WeightDefinition;
  value: number | undefined;
  disabled: boolean;
  pending: boolean;
  onChange: (value: number | null) => void;
  itemLabel: string;
}) {
  return (
    <input
      id={`weight-${definition.key}-${itemLabel.replace(/\W+/g, "-").toLowerCase()}`}
      type="number"
      inputMode="decimal"
      aria-label={`${definition.name} for ${itemLabel}`}
      min={definition.scale_min}
      step={definition.scale_step}
      disabled={disabled || pending}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className={cn(
        "w-20 rounded border border-border bg-elevated px-2 py-1 font-mono text-xs tabular-nums",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]",
        (disabled || pending) && "cursor-not-allowed opacity-50",
      )}
    />
  );
}

/** A read-only rendering of a rolled-up weight, for cards and lists. */
export function WeightBadge({
  definition,
  value,
  className,
}: {
  definition: WeightDefinition;
  value: number;
  className?: string;
}) {
  const label = weightLabel(definition, value);
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 rounded border border-border px-1.5 py-0.5",
        "font-mono text-[10px] tabular-nums text-muted-foreground",
        className,
      )}
      title={definition.guidance_text ?? undefined}
    >
      <span className="uppercase tracking-wider">{definition.name}</span>
      <span className="text-foreground">{value}</span>
      {label && <span className="normal-case tracking-normal">{label}</span>}
    </span>
  );
}
