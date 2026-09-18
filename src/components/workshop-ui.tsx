import { cn } from "@/lib/utils";
import { useUiPrefs } from "@/lib/ui-prefs";

// What remains after the mock screens were retired: the two genuinely shared
// primitives. StatusPill, CategoryTag and the fake AIAssistantPanel went with
// them — the first two were SWOT-specific, and the third answered questions
// with canned string matching rather than the real assistant.

export type BuildState = "live" | "mock";

export function BuildBadge({ state, className }: { state: BuildState; className?: string }) {
  const { showBuildStatus } = useUiPrefs();
  if (!showBuildStatus) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider",
        state === "live"
          ? "border-success/50 bg-success/10 text-success"
          : "border-destructive/50 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {state === "live" ? "Functional" : "Mock UI"}
    </span>
  );
}

export function PanelHeading({
  title,
  hint,
  action,
  build,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  build?: BuildState;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="truncate font-display text-sm font-semibold">{title}</h3>
          {build && <BuildBadge state={build} />}
        </div>
        {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}


