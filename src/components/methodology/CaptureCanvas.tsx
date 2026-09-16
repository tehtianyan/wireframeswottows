import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { FactorCard } from "./FactorCard";
import { workshopsApi, type FactorCategory, type WorkshopRole } from "@/lib/api";

// Generic replacement for the four SWOT Discovery screens (wireframe §2,
// app spec screens 09-12) — parameterized entirely by which factor category
// it's capturing. A PESTLE "Political Discovery" screen is this exact same
// component with a different category passed in.
export function CaptureCanvas({
  workshopId,
  category,
  myRole,
}: {
  workshopId: string;
  category: FactorCategory;
  myRole: WorkshopRole;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const queryKey = ["factors", workshopId, category.key];
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    // The review board and prioritization grid read the same factors.
    queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
  };

  const factorsQuery = useQuery({
    queryKey,
    queryFn: () => workshopsApi.factors(workshopId, { category: category.key }),
  });

  const createFactor = useMutation({
    mutationFn: () =>
      workshopsApi.createFactor(workshopId, {
        category_key: category.key,
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: () => {
      setTitle("");
      setDescription("");
      invalidate();
      toast.success(`${category.name} added`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateFactor = useMutation({
    mutationFn: (v: { id: string; title: string; description: string }) =>
      workshopsApi.updateFactor(workshopId, v.id, { title: v.title, description: v.description }),
    onSuccess: () => {
      invalidate();
      toast.success("Factor updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteFactor = useMutation({
    mutationFn: (id: string) => workshopsApi.deleteFactor(workshopId, id),
    onMutate: (id: string) => setDeletingId(id),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      invalidate();
      toast.success("Factor removed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const readOnly = myRole === "observer" || myRole === "executive_viewer";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    createFactor.mutate();
  }

  return (
    <section className="console-panel" data-build="live">
      <PanelHeading
        build="live"
        title={`${category.name} factors`}
        {...(factorsQuery.data ? { hint: `${factorsQuery.data.length} captured` } : {})}
      />

      {readOnly ? (
        <p className="border-b border-border bg-elevated/40 p-4 text-xs text-muted-foreground">
          Your role in this workshop is view-only, so capture is disabled.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-2 border-b border-border bg-elevated/40 p-4">
          <Input
            placeholder={`e.g. ${category.guidance_text.split(",")[0] || category.name}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            disabled={createFactor.isPending}
          />
          <Textarea
            placeholder="Description (optional) — add evidence, a number, a date, or a source."
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={createFactor.isPending}
          />
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">{title.length}/120</p>
            <Button type="submit" size="sm" disabled={createFactor.isPending}>
              {createFactor.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add
            </Button>
          </div>
        </form>
      )}

      <div className="divide-y divide-border">
        {factorsQuery.isLoading && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {factorsQuery.isError && <p className="p-4 text-xs text-destructive">Could not load factors.</p>}
        {factorsQuery.data?.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">Nothing captured yet. {category.guidance_text}</p>
        )}
        {factorsQuery.data?.map((f) => (
          <FactorCard
            key={f.id}
            factor={f}
            category={category}
            canEdit={!readOnly}
            onSave={({ title: t, description: d }) => updateFactor.mutate({ id: f.id, title: t, description: d })}
            onDelete={() => deleteFactor.mutate(f.id)}
            isSaving={updateFactor.isPending}
            isDeleting={deletingId === f.id}
          />
        ))}
      </div>
    </section>
  );
}
