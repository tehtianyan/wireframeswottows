import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronUp, Loader2, MessageCircleQuestion, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AiNarrativeView } from "./AiNarrativeView";
import { aiApi, aiNarrative, type AIExecuteResult, type AIFunction } from "@/lib/api";

// The assistant actions that belong to ONE THING rather than to a stage.
//
// App Spec §13.10-13.12 states each function's trigger, and three of them are
// not stage buttons:
//
//   §13.10 Summarize Workshop  "from Workshop Overview"
//   §13.11 Challenge This      "from an insight or recommendation card"
//   §13.12 Explain Why         "from an insight, recommendation, or report section"
//
// All three were previously listed in the stage panel. Challenge and Explain
// Why both interpolate a SELECTED object, so with no object to act on they were
// answering a question nobody had asked — and then the panel could not render
// the answer either, so they looked simply broken.
//
// Which actions appear here comes from `scope` and `applies_to` in
// methodology_ai_prompts, so placement stays configuration.

export function AiInlineActions({
  workshopId,
  scope,
  objectKind,
  objectId,
  stageKey,
  label,
}: {
  workshopId: string;
  scope: "object" | "workshop";
  /** Required when scope is "object" — the registry key of the selected item. */
  objectKind?: string;
  objectId?: string;
  /** Only used to resolve the prompt; these functions are not stage-bound. */
  stageKey?: string;
  /** Optional heading, for the workshop-level panel. */
  label?: string;
}) {
  const [result, setResult] = useState<AIExecuteResult | null>(null);
  const [ran, setRan] = useState<AIFunction | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ai-status", workshopId, stageKey ?? "(none)"],
    queryFn: () => aiApi.status(workshopId, stageKey),
  });

  const execute = useMutation({
    mutationFn: (fn: AIFunction) =>
      aiApi.execute(workshopId, {
        stage_key: stageKey ?? "",
        function_key: fn.function_key,
        ...(scope === "object" && objectKind && objectId
          ? { object_kind: objectKind, object_id: objectId }
          : {}),
      }),
    onMutate: (fn) => setRan(fn),
    onSuccess: (data) => setResult(data),
    // The API returns the spec's fixed §12.22 failure message; show it as-is.
    onError: (e: Error) => {
      setRan(null);
      toast.error(e.message);
    },
  });

  const functions = (statusQuery.data?.functions ?? []).filter((f) => {
    if (f.scope !== scope) return false;
    if (scope !== "object") return true;
    return objectKind !== undefined && f.applies_to.includes(objectKind);
  });

  if (!statusQuery.data?.configured || functions.length === 0) return null;

  const remaining = statusQuery.data.limit_per_hour - statusQuery.data.used_this_hour;
  const narrative = result ? aiNarrative(result.content) : null;

  // On a card these are quiet text buttons; on the overview a panel of its own.
  if (scope === "object") {
    return (
      <div className="mt-2">
        <div className="flex flex-wrap gap-1">
          {functions.map((fn) => (
            <Button
              key={fn.function_key}
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              disabled={execute.isPending || remaining <= 0}
              onClick={() => execute.mutate(fn)}
            >
              {execute.isPending && execute.variables?.function_key === fn.function_key ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <MessageCircleQuestion className="size-3" />
              )}
              {fn.name}
            </Button>
          ))}
        </div>

        {narrative && (
          <div className="mt-1.5 rounded-sm border border-border bg-elevated/40">
            <div className="flex items-center justify-between border-b border-border px-3.5 py-1.5">
              <span className="label-caps">{ran?.name}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => {
                  setResult(null);
                  setRan(null);
                }}
              >
                <ChevronUp className="size-3" />
                Hide
              </Button>
            </div>
            <AiNarrativeView narrative={narrative} />
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="console-panel" data-build="live">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-muted-foreground" />
          <span className="label-caps">{label ?? "AI assistant"}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {functions.map((fn) => (
            <Button
              key={fn.function_key}
              size="sm"
              variant="outline"
              disabled={execute.isPending || remaining <= 0}
              onClick={() => execute.mutate(fn)}
            >
              {execute.isPending && execute.variables?.function_key === fn.function_key ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {fn.name}
            </Button>
          ))}
        </div>
      </div>

      {narrative ? (
        <AiNarrativeView narrative={narrative} />
      ) : (
        <p className="px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {remaining <= 0
            ? "You have used this hour's AI requests. You can carry on working without AI."
            : "A read of where this workshop has got to, from its own data — what is done, what is still open, and what to do next."}
        </p>
      )}
    </section>
  );
}
