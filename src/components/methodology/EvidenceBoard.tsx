import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { ObjectCard } from "./ObjectCard";
import { ObjectForm } from "./ObjectForm";
import { useStageObjects } from "./useStageObjects";
import {
  canReview as roleCanReview,
  objectsApi,
  type MethodologyStage,
  type WorkObject,
  type WorkshopDetail,
  type WriteObjectInput,
} from "@/lib/api";

// One board for every stage whose objects cite a LIST of earlier objects:
//   synthesize  themes citing factors
//   interpret   insights citing themes and relationships
//   recommend   recommendations citing insights
//
// The plan called for a separate SynthesisBoard and EvidenceBoard, but a
// synthesize stage that groups factors and an interpret stage that cites
// themes are the same shape with different config, so they are the same
// component. Splitting them would have meant two copies of this file.

export function EvidenceBoard({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WorkObject | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const { kind, cites, pools, allCitable, objects, isLoading, isError } = useStageObjects(workshop, stage);

  const reviewer = roleCanReview(workshop.my_role);
  // Shaping factors into themes and insights is analytical work; App Spec
  // §3.17 keeps it with facilitators and analysts.
  const contributor = workshop.my_role === "facilitator" || workshop.my_role === "analyst";

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["objects", workshop.id] });
    queryClient.invalidateQueries({ queryKey: ["citable", workshop.id] });
  }

  const create = useMutation({
    mutationFn: (input: WriteObjectInput) => objectsApi.create(workshop.id, kind!.route, input),
    onSuccess: () => {
      setAdding(false);
      invalidate();
      toast.success(`${kind!.label} added`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; input: WriteObjectInput }) =>
      objectsApi.update(workshop.id, kind!.route, v.id, v.input),
    onSuccess: () => {
      setEditing(null);
      invalidate();
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => objectsApi.remove(workshop.id, kind!.route, id),
    onSuccess: () => {
      invalidate();
      toast.success("Removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const review = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject"; note?: string }) =>
      objectsApi.review(workshop.id, kind!.route, v.id, {
        action: v.action,
        ...(v.note ? { note: v.note } : {}),
      }),
    onSuccess: (_d, v) => {
      setRejecting(null);
      setNote("");
      invalidate();
      toast.success(v.action === "approve" ? "Approved" : "Rejected");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <section className="console-panel p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      </section>
    );
  }
  if (isError || !kind) {
    return (
      <section className="console-panel p-4">
        <p className="text-sm text-destructive">Could not load this stage.</p>
      </section>
    );
  }

  const nothingToCite = cites.length > 0 && cites.every((c) => (pools.get(c) ?? []).length === 0);

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title={`${kind.label}s`}
        hint={`${objects.length} total`}
        {...(contributor && !adding && !nothingToCite
          ? {
              action: (
                <Button size="sm" onClick={() => setAdding(true)}>
                  <Plus className="size-3.5" />
                  Add {kind.label.toLowerCase()}
                </Button>
              ),
            }
          : {})}
      />

      {nothingToCite && (
        <p className="border-b border-border bg-elevated/40 p-4 text-xs text-muted-foreground">
          There is nothing to build on yet. Complete the earlier stages first — a {kind.label.toLowerCase()} has
          to cite its supporting evidence.
        </p>
      )}

      {!contributor && (
        <p className="border-b border-border bg-elevated/40 p-4 text-xs text-muted-foreground">
          Your role in this workshop is view-only for this stage.
        </p>
      )}

      {adding && (
        <ObjectForm
          kind={kind}
          cites={cites}
          pools={pools}
          onSubmit={(input) => create.mutate(input)}
          onCancel={() => setAdding(false)}
          isPending={create.isPending}
        />
      )}

      <div className="divide-y divide-border">
        {objects.length === 0 && !adding && (
          <p className="p-4 text-xs text-muted-foreground">
            No {kind.label.toLowerCase()}s yet.
          </p>
        )}

        {objects.map((o) =>
          editing?.id === o.id ? (
            <ObjectForm
              key={o.id}
              kind={kind}
              cites={cites}
              pools={pools}
              initial={o}
              onSubmit={(input) => update.mutate({ id: o.id, input })}
              onCancel={() => setEditing(null)}
              isPending={update.isPending}
            />
          ) : (
            <div key={o.id}>
              <ObjectCard
                object={o}
                kind={kind}
                citable={allCitable}
                canEdit={contributor}
                canReview={reviewer}
                onEdit={() => setEditing(o)}
                onDelete={() => remove.mutate(o.id)}
                onReview={(action) => {
                  if (action === "approve") review.mutate({ id: o.id, action });
                  else {
                    setRejecting(rejecting === o.id ? null : o.id);
                    setNote("");
                  }
                }}
                isBusy={remove.isPending || review.isPending}
              />
              {rejecting === o.id && (
                <div className="space-y-2 border-t border-border bg-elevated/40 px-4 py-3">
                  <label className="label-caps" htmlFor={`reject-${o.id}`}>
                    Reason for rejection
                  </label>
                  <Textarea
                    id={`reject-${o.id}`}
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!note.trim() || review.isPending}
                      onClick={() => review.mutate({ id: o.id, action: "reject", note: note.trim() })}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
