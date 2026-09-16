import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { StageShell } from "@/components/methodology/StageShell";
import { CaptureCanvas } from "@/components/methodology/CaptureCanvas";
import { workshopsApi } from "@/lib/api";

export const Route = createFileRoute("/w/$workshopId/stage/$stageKey")({
  component: StagePage,
});

function StagePage() {
  const { workshopId, stageKey } = Route.useParams();

  const workshopQuery = useQuery({
    queryKey: ["workshop", workshopId],
    queryFn: () => workshopsApi.get(workshopId),
  });
  const activitiesQuery = useQuery({
    queryKey: ["activities", workshopId],
    queryFn: () => workshopsApi.activities(workshopId),
  });

  if (workshopQuery.isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (workshopQuery.isError || !workshopQuery.data) {
    return <p className="p-6 text-sm text-destructive">Could not load this workshop.</p>;
  }

  const workshop = workshopQuery.data;
  const stage = workshop.methodology.stages.find((s) => s.key === stageKey);
  if (!stage) {
    throw notFound();
  }

  if (stage.stage_type === "capture") {
    const categoryKey = stage.config["factor_category_key"] as string | undefined;
    const category = categoryKey ? workshop.methodology.factor_categories.find((c) => c.key === categoryKey) : undefined;
    if (!category) {
      return <p className="p-6 text-sm text-destructive">This capture stage has no factor category configured.</p>;
    }
    return (
      <StageShell workshop={workshop} stage={stage} category={category} guidance={category.guidance_text}>
        <CaptureCanvas workshopId={workshop.id} category={category} />
      </StageShell>
    );
  }

  return (
    <StageShell workshop={workshop} stage={stage}>
      <section className="console-panel p-4">
        <p className="text-sm text-muted-foreground">
          The generic renderer for "{stage.stage_type}" stages isn't built yet — coming in a later phase.
        </p>
      </section>
    </StageShell>
  );
}
