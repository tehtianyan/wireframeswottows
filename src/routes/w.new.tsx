import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { methodologiesApi, workshopsApi, workspacesApi, type MethodologySummary } from "@/lib/api";

// Workshop Creation Wizard (App Spec screen 03).
//
// Step 1 is the methodology picker, and it lists whatever the API reports as
// active — SWOT-TOWS is not privileged here in any way. Activating PESTLE
// makes it appear in this list with no change to this file.

export const Route = createFileRoute("/w/new")({
  component: NewWorkshopPage,
});

const STEPS = ["Methodology", "Details", "Confirm"] as const;

function NewWorkshopPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [methodologyKey, setMethodologyKey] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [description, setDescription] = useState("");

  const methodologiesQuery = useQuery({
    queryKey: ["methodologies"],
    queryFn: () => methodologiesApi.list(),
  });
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => workspacesApi.list(),
  });

  const eligibleWorkspaces = (workspacesQuery.data ?? []).filter((w) => w.can_create_workshops);

  // Preselect when there is only one sensible choice, so the common case is
  // a two-field form rather than a ceremony.
  useEffect(() => {
    if (!workspaceId && eligibleWorkspaces.length === 1) {
      setWorkspaceId(eligibleWorkspaces[0]!.id);
    }
  }, [eligibleWorkspaces, workspaceId]);

  const create = useMutation({
    mutationFn: async () => {
      const created = await workshopsApi.create({
        workspace_id: workspaceId!,
        name: name.trim(),
        methodology_key: methodologyKey!,
        ...(objective.trim() ? { objective: objective.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      // Read the workshop back so we land on whatever its methodology says
      // stage 1 is, rather than assuming a stage key here.
      const detail = await workshopsApi.get(created.id);
      return { id: created.id, firstStageKey: detail.methodology.stages[0]?.key ?? null };
    },
    onSuccess: ({ id, firstStageKey }) => {
      toast.success("Workshop created");
      if (firstStageKey) {
        navigate({ to: "/w/$workshopId/stage/$stageKey", params: { workshopId: id, stageKey: firstStageKey } });
      } else {
        navigate({ to: "/" });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const selected: MethodologySummary | undefined = methodologiesQuery.data?.find((m) => m.key === methodologyKey);

  const canAdvance = step === 0 ? Boolean(methodologyKey) : step === 1 ? Boolean(name.trim() && workspaceId) : true;

  return (
    <div className="grid-backdrop min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto max-w-3xl space-y-4 p-3 md:p-5">
        <section className="console-panel p-4 md:p-5" data-build="live">
          <h1 className="text-xl font-semibold md:text-2xl">New workshop</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick a methodology, describe what you are trying to decide, and the workshop's stages are created for you.
          </p>

          <ol className="mt-4 flex flex-wrap gap-1.5">
            {STEPS.map((label, i) => (
              <li
                key={label}
                className={cn(
                  "rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
                  i === step
                    ? "border-foreground/30 bg-foreground/10 text-foreground"
                    : i < step
                      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                      : "border-border text-muted-foreground",
                )}
              >
                {i + 1}. {label}
              </li>
            ))}
          </ol>
        </section>

        {step === 0 && (
          <section className="console-panel p-4" data-build="live">
            <p className="label-caps">Choose a methodology</p>
            {methodologiesQuery.isLoading && (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            )}
            {methodologiesQuery.isError && (
              <p className="mt-3 text-xs text-destructive">Could not load the methodology catalogue.</p>
            )}
            <div className="mt-3 space-y-2">
              {methodologiesQuery.data?.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMethodologyKey(m.key)}
                  className={cn(
                    "w-full rounded-md border p-3.5 text-left transition-colors",
                    methodologyKey === m.key
                      ? "border-foreground/40 bg-foreground/5"
                      : "border-border hover:border-foreground/20",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{m.name}</span>
                    {methodologyKey === m.key && <Check className="size-4 shrink-0" />}
                  </div>
                  {m.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{m.description}</p>
                  )}
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    v{m.version} · {m.category_count} factor categories · {m.stage_count} stages
                  </p>
                </button>
              ))}
              {methodologiesQuery.data?.length === 0 && (
                <p className="text-xs text-muted-foreground">No methodologies are active.</p>
              )}
            </div>
          </section>
        )}

        {step === 1 && (
          <section className="console-panel space-y-3 p-4" data-build="live">
            <div>
              <label className="label-caps" htmlFor="ws-workspace">
                Workspace
              </label>
              {workspacesQuery.isLoading ? (
                <p className="mt-1.5 text-xs text-muted-foreground">Loading workspaces…</p>
              ) : eligibleWorkspaces.length === 0 ? (
                <p className="mt-1.5 text-xs text-destructive">
                  You are not a facilitator in any workspace, so you cannot create a workshop.
                </p>
              ) : (
                <select
                  id="ws-workspace"
                  value={workspaceId ?? ""}
                  onChange={(e) => setWorkspaceId(e.target.value || null)}
                  className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select a workspace…</option>
                  {eligibleWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="label-caps" htmlFor="ws-name">
                Workshop name
              </label>
              <Input
                id="ws-name"
                className="mt-1.5"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. FY27 Growth Strategy"
                maxLength={200}
              />
            </div>

            <div>
              <label className="label-caps" htmlFor="ws-objective">
                Objective
              </label>
              <Textarea
                id="ws-objective"
                className="mt-1.5"
                rows={2}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="What decision should this workshop produce? The AI assistant uses this throughout."
              />
            </div>

            <div>
              <label className="label-caps" htmlFor="ws-description">
                Description (optional)
              </label>
              <Textarea
                id="ws-description"
                className="mt-1.5"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="console-panel p-4" data-build="live">
            <p className="label-caps">Confirm</p>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Methodology" value={selected?.name ?? "—"} />
              <Row
                label="Workspace"
                value={eligibleWorkspaces.find((w) => w.id === workspaceId)?.name ?? "—"}
              />
              <Row label="Name" value={name.trim() || "—"} />
              <Row label="Objective" value={objective.trim() || "—"} />
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              Creating this workshop sets up its {selected?.stage_count ?? 0} stages and adds you as facilitator.
            </p>
          </section>
        )}

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (step === 0 ? navigate({ to: "/" }) : setStep((s) => s - 1))}
          >
            <ArrowLeft className="size-3.5" />
            {step === 0 ? "Cancel" : "Back"}
          </Button>

          {step < 2 ? (
            <Button size="sm" disabled={!canAdvance} onClick={() => setStep((s) => s + 1)}>
              Next
              <ArrowRight className="size-3.5" />
            </Button>
          ) : (
            <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Create workshop
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{value}</dd>
    </div>
  );
}
