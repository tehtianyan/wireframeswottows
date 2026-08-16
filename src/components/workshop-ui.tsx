import { Sparkles, Send } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ActivityStatus, SwotCategory } from "@/lib/workshop-data";

const statusStyles: Record<ActivityStatus, string> = {
  "not-started": "bg-muted text-muted-foreground",
  "in-progress": "bg-info/15 text-info",
  complete: "bg-success/15 text-success",
  blocked: "bg-destructive/15 text-destructive",
};

const statusLabels: Record<ActivityStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  complete: "Complete",
  blocked: "Blocked",
};

export function StatusPill({ status, className }: { status: ActivityStatus; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        statusStyles[status],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {statusLabels[status]}
    </span>
  );
}

const categoryStyles: Record<SwotCategory, string> = {
  strength: "border-strength/40 bg-strength/10 text-strength",
  weakness: "border-weakness/40 bg-weakness/10 text-weakness",
  opportunity: "border-opportunity/40 bg-opportunity/10 text-opportunity",
  threat: "border-threat/40 bg-threat/10 text-threat",
};

export function CategoryTag({ category, className }: { category: SwotCategory; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        categoryStyles[category],
        className,
      )}
    >
      {category}
    </span>
  );
}

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


export function AIAssistantPanel({
  context,
  quickActions,
  suggestions,
}: {
  context: string;
  quickActions: string[];
  suggestions?: { title: string; detail: string }[];
}) {
  const [messages, setMessages] = useState<{ from: "ai" | "user"; text: string }[]>([
    {
      from: "ai",
      text: `I have context on ${context}. Ask me to explain progress, surface gaps, or draft a status summary.`,
    },
  ]);
  const [draft, setDraft] = useState("");

  function send(text: string) {
    if (!text.trim()) return;
    setMessages((prev) => [
      ...prev,
      { from: "user", text },
      {
        from: "ai",
        text: `Based on ${context}: ${answerFor(text)}`,
      },
    ]);
    setDraft("");
  }

  return (
    <section className="console-panel flex flex-col overflow-hidden">
      <PanelHeading
        title="AI Strategy Assistant"
        hint="Methodology-aware guidance"
        action={<Sparkles className="size-4 text-primary" />}
      />

      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-3">
        {quickActions.map((a) => (
          <button
            key={a}
            onClick={() => send(a)}
            className="rounded-full border border-border bg-elevated px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            {a}
          </button>
        ))}
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-2 border-b border-border px-4 py-3">
          <p className="label-caps">Suggestions</p>
          {suggestions.map((s) => (
            <div key={s.title} className="rounded-md border border-border bg-elevated p-2.5">
              <p className="text-xs font-medium">{s.title}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{s.detail}</p>
            </div>
          ))}
        </div>
      )}

      <div className="max-h-72 flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[92%] rounded-lg px-3 py-2 text-xs leading-relaxed",
              m.from === "ai"
                ? "bg-elevated text-foreground"
                : "ml-auto bg-primary/15 text-foreground",
            )}
          >
            {m.text}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex gap-2 border-t border-border p-3"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask the assistant…"
          className="h-9 bg-elevated text-xs"
        />
        <Button type="submit" size="icon" className="size-9 shrink-0">
          <Send className="size-4" />
        </Button>
      </form>
    </section>
  );
}

function answerFor(query: string) {
  const q = query.toLowerCase();
  if (q.includes("next"))
    return "close Threat Discovery, then confirm prioritisation quorum before theme approval — that unblocks recommendation drafting.";
  if (q.includes("gap"))
    return "threat coverage is thin on supply-chain risk, and no artifact addresses pricing pressure from AI-native entrants.";
  if (q.includes("summary") || q.includes("report"))
    return "the workshop is 62% through the methodology with healthy participation; two approval items and one blocked activity need facilitator attention.";
  if (q.includes("duplicate") || q.includes("merge"))
    return "“Strong Customer Loyalty” and “High Customer Retention” overlap at 87% similarity and are candidates to merge.";
  if (q.includes("quality"))
    return "artifact descriptions average 18 words, which is adequate; 4 artifacts lack tags and would weaken theme clustering.";
  return "the strongest signal is an under-monetised data asset paired with a delivery cost structure that blocks mid-market growth.";
}
