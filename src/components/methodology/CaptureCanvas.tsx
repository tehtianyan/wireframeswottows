import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PanelHeading } from "@/components/workshop-ui";
import { workshopsApi, type FactorCategory } from "@/lib/api";

// Generic replacement for the four SWOT Discovery screens (wireframe §2,
// app spec screens 09-12) — parameterized entirely by which factor category
// it's capturing. A PESTLE "Political Discovery" screen is this exact same
// component with a different category passed in.
export function CaptureCanvas({ workshopId, category }: { workshopId: string; category: FactorCategory }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const factorsQuery = useQuery({
    queryKey: ["factors", workshopId, category.key],
    queryFn: () => workshopsApi.factors(workshopId, category.key),
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
      queryClient.invalidateQueries({ queryKey: ["factors", workshopId, category.key] });
      toast.success(`${category.name} added`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

      <div className="divide-y divide-border">
        {factorsQuery.isLoading && (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {factorsQuery.isError && (
          <p className="p-4 text-xs text-destructive">Could not load factors.</p>
        )}
        {factorsQuery.data?.length === 0 && (
          <p className="p-4 text-xs text-muted-foreground">
            Nothing captured yet. {category.guidance_text}
          </p>
        )}
        {factorsQuery.data?.map((f) => (
          <div key={f.id} className="px-4 py-3">
            <p className="text-sm font-medium">{f.title}</p>
            {f.description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.description}</p>}
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              {new Date(f.created_at).toLocaleDateString()} · {f.votes} votes
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
