import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import {
  aiApi,
  aiSuggestions,
  type AIExecuteResult,
  type MethodologyStage,
  type WorkshopDetail,
} from "@/lib/api";

// The AI Assistant Panel every workspace in the wireframe spec carries.
//
// Which actions appear comes from methodology_ai_prompts via the API, so a
// methodology's assistant is configured, not coded. The panel never sees a
// prompt template.
//
// Governance is visible on purpose: suggestions are labelled as AI output,
// accepting one creates an item that still needs human review, and nothing
// here can approve anything (App Spec §12.19).

export function AiActionPanel({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<AIExecuteResult | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [busyIndex, setBusyIndex] = useState<number | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ai-status", workshop.id, stage.key],
    queryFn: () => aiApi.status(workshop.id, stage.key),
  });

  const execute = useMutation({
    mutationFn: (functionKey: string) =>
      aiApi.execute(workshop.id, { stage_key: stage.key, function_key: functionKey }),
    onSuccess: (data) => {
      setResult(data);
      setAccepted(new Set());
      queryClient.invalidateQueries({ queryKey: ["ai-status", workshop.id] });
    },
    // The API returns the spec's fixed failure message; show it as-is so the
    // user knows they can simply carry on without AI.
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: (v: { action: "accept" | "reject"; index?: number }) =>
      aiApi.review(workshop.id, result!.output_id, {
        action: v.action,
        ...(v.index !== undefined ? { index: v.index, stage_key: stage.key } : {}),
      }),
    onMutate: (v) => setBusyIndex(v.index ?? null),
    onSettled: () => setBusyIndex(null),
    onSuccess: (_d, v) => {
      if (v.action === "accept" && v.index !== undefined) {
        setAccepted((prev) => new Set(prev).add(v.index!));
        toast.success("Added for review");
      } else {
        setResult(null);
        toast.success("Suggestions dismissed");
      }
      // The accepted item is now a real object in this stage.
      queryClient.invalidateQueries({ queryKey: ["factors", workshop.id] });
      queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
      queryClient.invalidateQueries({ queryKey: ["citable", workshop.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = statusQuery.data;
  const contributor = workshop.my_role === "facilitator" || workshop.my_role === "analyst";

  if (statusQuery.isLoading) return null;

  // Nothing configured server-side, or nothing for this stage: show no panel
  // rather than buttons that cannot work.
  if (!status?.configured || status.functions.length === 0) return null;

  const remaining = status.limit_per_hour - status.used_this_hour;
  const suggestions = result ? aiSuggestions(result.content) : [];

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title="AI assistant"
        hint={`${remaining} of ${status.limit_per_hour} left this hour`}
      />

      <div className="space-y-2 border-b border-border p-3.5">
        {status.functions.map((fn) => (
          <Button
            key={fn.function_key}
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={execute.isPending || remaining <= 0}
            onClick={() => execute.mutate(fn.function_key)}
          >
            {execute.isPending && execute.variables === fn.function_key ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Sparkles className="size-3.5" />
            )}
            {fn.name}
          </Button>
        ))}
        {remaining <= 0 && (
          <p className="text-[11px] text-muted-foreground">
            You have used this hour's AI requests. You can carry on working without AI.
          </p>
        )}
        <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
          AI drafts suggestions from this workshop's own data. Nothing it proposes is added
          until you accept it, and accepted items still go through review.
        </p>
      </div>

      {result && (
        <div>
          <div className="flex items-center justify-between border-b border-border bg-elevated/40 px-3.5 py-2">
            <span className="label-caps">
              {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => review.mutate({ action: "reject" })}
              disabled={review.isPending}
            >
              Dismiss all
            </Button>
          </div>

          <div className="divide-y divide-border">
            {suggestions.length === 0 && (
              <p className="p-3.5 text-xs text-muted-foreground">
                The assistant had nothing to add from the data available.
              </p>
            )}
            {suggestions.map((s, i) => (
              <SuggestionRow
                key={i}
                suggestion={s}
                accepted={accepted.has(i)}
                busy={busyIndex === i}
                canAccept={contributor}
                onAccept={() => review.mutate({ action: "accept", index: i })}
              />
            ))}
          </div>

          {!contributor && (
            <p className="border-t border-border px-3.5 py-2.5 text-[11px] text-muted-foreground">
              Only a facilitator or analyst can add these to the workshop.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function SuggestionRow({
  suggestion,
  accepted,
  busy,
  canAccept,
  onAccept,
}: {
  suggestion: Record<string, unknown>;
  accepted: boolean;
  busy: boolean;
  canAccept: boolean;
  onAccept: () => void;
}) {
  const title = typeof suggestion["title"] === "string" ? suggestion["title"] : "(untitled)";
  const description =
    typeof suggestion["description"] === "string" ? suggestion["description"] : undefined;
  const rationale = typeof suggestion["rationale"] === "string" ? suggestion["rationale"] : undefined;
  const confidence =
    typeof suggestion["confidence_score"] === "number" ? suggestion["confidence_score"] : undefined;

  return (
    <div className={cn("px-3.5 py-3", accepted && "opacity-60")}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded border border-violet-500/40 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
          <Sparkles className="size-2.5" />
          AI generated
        </span>
        {confidence !== undefined && (
          <span className="font-mono text-[10px] text-muted-foreground">
            confidence {confidence.toFixed(2)}
          </span>
        )}
      </div>

      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      {rationale && (
        <p className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          {rationale}
        </p>
      )}

      <div className="mt-2 flex justify-end">
        {accepted ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            Added — awaiting review
          </span>
        ) : canAccept ? (
          <Button size="sm" variant="outline" onClick={onAccept} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Add for review
          </Button>
        ) : (
          <X className="size-3.5 text-muted-foreground" aria-label="You cannot add this" />
        )}
      </div>
    </div>
  );
}
