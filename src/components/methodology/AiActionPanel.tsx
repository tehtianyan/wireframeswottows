import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { cn } from "@/lib/utils";
import {
  aiApi,
  aiSuggestions,
  objectKindsApi,
  type AIExecuteResult,
  type MethodologyStage,
  type ObjectField,
  type WorkshopDetail,
  type WriteObjectInput,
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
  // index -> how it was accepted, so the row can say whether it was edited.
  const [accepted, setAccepted] = useState<Map<number, "accepted" | "edited">>(new Map());
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const statusQuery = useQuery({
    queryKey: ["ai-status", workshop.id, stage.key],
    queryFn: () => aiApi.status(workshop.id, stage.key),
  });

  // Which object kind this stage produces, so an edited suggestion can offer
  // that kind's own fields (a recommendation's priority, an insight's
  // strategic significance) rather than a fixed form. Cached indefinitely —
  // the registry is a platform constant.
  const kindsQuery = useQuery({
    queryKey: ["object-kinds"],
    queryFn: () => objectKindsApi.list(),
    staleTime: Infinity,
  });
  const editableFields: ObjectField[] = useMemo(
    () => kindsQuery.data?.find((k) => k.stage_type === stage.stage_type)?.fields ?? [],
    [kindsQuery.data, stage.stage_type],
  );

  const execute = useMutation({
    mutationFn: (functionKey: string) =>
      aiApi.execute(workshop.id, { stage_key: stage.key, function_key: functionKey }),
    onSuccess: (data) => {
      setResult(data);
      setAccepted(new Map());
      setEditingIndex(null);
      queryClient.invalidateQueries({ queryKey: ["ai-status", workshop.id] });
    },
    // The API returns the spec's fixed failure message; show it as-is so the
    // user knows they can simply carry on without AI.
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: (v: { action: "accept" | "reject"; index?: number; overrides?: WriteObjectInput }) =>
      aiApi.review(workshop.id, result!.output_id, {
        action: v.action,
        ...(v.index !== undefined ? { index: v.index, stage_key: stage.key } : {}),
        // Sending overrides is what makes the server record this as "edited"
        // rather than "accepted" (App Spec §12.19).
        ...(v.overrides ? { overrides: v.overrides } : {}),
      }),
    onMutate: (v) => setBusyIndex(v.index ?? null),
    onSettled: () => setBusyIndex(null),
    onSuccess: (_d, v) => {
      if (v.action === "accept" && v.index !== undefined) {
        const how = v.overrides ? "edited" : "accepted";
        setAccepted((prev) => new Map(prev).set(v.index!, how));
        setEditingIndex(null);
        toast.success(how === "edited" ? "Added with your changes" : "Added for review");
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
                fields={editableFields}
                acceptedAs={accepted.get(i)}
                busy={busyIndex === i}
                canAccept={contributor}
                editing={editingIndex === i}
                onStartEdit={() => setEditingIndex(i)}
                onCancelEdit={() => setEditingIndex(null)}
                onAccept={() => review.mutate({ action: "accept", index: i })}
                onAcceptEdited={(overrides) => review.mutate({ action: "accept", index: i, overrides })}
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
  fields,
  acceptedAs,
  busy,
  canAccept,
  editing,
  onStartEdit,
  onCancelEdit,
  onAccept,
  onAcceptEdited,
}: {
  suggestion: Record<string, unknown>;
  /** The producing kind's own fields, so editing offers them too. */
  fields: ObjectField[];
  acceptedAs: "accepted" | "edited" | undefined;
  busy: boolean;
  canAccept: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onAccept: () => void;
  onAcceptEdited: (overrides: WriteObjectInput) => void;
}) {
  const title = typeof suggestion["title"] === "string" ? suggestion["title"] : "(untitled)";
  const description =
    typeof suggestion["description"] === "string" ? suggestion["description"] : undefined;
  const rationale = typeof suggestion["rationale"] === "string" ? suggestion["rationale"] : undefined;
  const confidence =
    typeof suggestion["confidence_score"] === "number" ? suggestion["confidence_score"] : undefined;

  if (editing) {
    return (
      <SuggestionEditor
        initialTitle={title === "(untitled)" ? "" : title}
        initialDescription={description ?? ""}
        fields={fields}
        suggestion={suggestion}
        busy={busy}
        onCancel={onCancelEdit}
        onSubmit={onAcceptEdited}
      />
    );
  }

  return (
    <div className={cn("px-3.5 py-3", acceptedAs && "opacity-60")}>
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

      <div className="mt-2 flex justify-end gap-1.5">
        {acceptedAs ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            <Check className="size-3" />
            {acceptedAs === "edited" ? "Added (edited) — awaiting review" : "Added — awaiting review"}
          </span>
        ) : canAccept ? (
          <>
            <Button size="sm" variant="ghost" onClick={onStartEdit} disabled={busy}>
              <Pencil className="size-3.5" />
              Edit
            </Button>
            <Button size="sm" variant="outline" onClick={onAccept} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Add for review
            </Button>
          </>
        ) : (
          <X className="size-3.5 text-muted-foreground" aria-label="You cannot add this" />
        )}
      </div>
    </div>
  );
}

// Editing a suggestion before accepting it. Sending any change makes the
// server record the decision as "edited" rather than "accepted", which is the
// distinction App Spec §12.19 draws between the two.
function SuggestionEditor({
  initialTitle,
  initialDescription,
  fields,
  suggestion,
  busy,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  initialDescription: string;
  fields: ObjectField[];
  suggestion: Record<string, unknown>;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (overrides: WriteObjectInput) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of fields) {
      const raw = suggestion[f.name];
      v[f.name] = raw === null || raw === undefined ? "" : String(raw);
    }
    return v;
  });

  function submit() {
    const overrides: WriteObjectInput = {
      title: title.trim(),
      description: description.trim() || null,
    };
    if (fields.length > 0) {
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const s = (values[f.name] ?? "").trim();
        out[f.name] = s === "" ? null : f.type === "int" ? Number(s) : s;
      }
      overrides.fields = out;
    }
    onSubmit(overrides);
  }

  return (
    <div className="space-y-2 bg-elevated/40 px-3.5 py-3">
      <p className="label-caps">Edit before adding</p>

      <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="Description"
      />

      {fields.map((f) =>
        f.type === "enum" ? (
          <select
            key={f.name}
            aria-label={f.label}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
          >
            <option value="">{f.label}…</option>
            {f.options?.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : (
          <Textarea
            key={f.name}
            aria-label={f.label}
            rows={2}
            placeholder={f.label}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
          />
        ),
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy || !title.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Add with changes
        </Button>
      </div>
    </div>
  );
}
