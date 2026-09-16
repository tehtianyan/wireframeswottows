import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { StageShell } from "@/components/methodology/StageShell";
import { CaptureCanvas } from "@/components/methodology/CaptureCanvas";
import { PrioritizationGrid } from "@/components/methodology/PrioritizationGrid";
import { ReviewBoard } from "@/components/methodology/ReviewBoard";
import { workshopsApi } from "@/lib/api";

// Search params are the stage's own view mode. `validateSearch` must return a
// key only when it is set — returning `{ mode: undefined }` widens the type
// and breaks every other <Link> in the app.
type StageSearch = { mode?: "review" };

export const Route = createFileRoute("/w/$workshopId/stage/$stageKey")({
  validateSearch: (search: Record<string, unknown>): StageSearch =>
    search["mode"] === "review" ? { mode: "review" } : {},
  component: StagePage,
});

function StagePage() {
  const { workshopId, stageKey } = Route.useParams();
  const { mode } = Route.useSearch();

  const workshopQuery = useQuery({
    queryKey: ["workshop", workshopId],
    queryFn: () => workshopsApi.get(workshopId),
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

  const categoryKey = stage.config["factor_category_key"] as string | undefined;
  const category = categoryKey
    ? workshop.methodology.factor_categories.find((c) => c.key === categoryKey)
    : undefined;

  // Review Mode is a property of every workspace in the wireframe spec, not a
  // stage of its own — so it is a view mode here rather than a stage_type.
  if (mode === "review") {
    return (
      <StageShell
        workshop={workshop}
        stage={stage}
        {...(category ? { category } : {})}
        reviewMode
        guidance="Approve the factors that belong in the analysis and reject the ones that don't. A rejection must say why; the reason stays attached to the factor."
      >
        <ReviewBoard workshopId={workshop.id} methodology={workshop.methodology} myRole={workshop.my_role} />
      </StageShell>
    );
  }

  switch (stage.stage_type) {
    case "capture": {
      if (!category) {
        return <p className="p-6 text-sm text-destructive">This capture stage has no factor category configured.</p>;
      }
      return (
        <StageShell workshop={workshop} stage={stage} category={category} guidance={category.guidance_text}>
          <CaptureCanvas workshopId={workshop.id} category={category} myRole={workshop.my_role} />
        </StageShell>
      );
    }

    case "prioritize":
      return (
        <StageShell
          workshop={workshop}
          stage={stage}
          guidance="Spend your votes on the factors that matter most to the objective. Votes are visible to the facilitator in aggregate, and you can move them until the stage closes."
        >
          <PrioritizationGrid
            workshopId={workshop.id}
            methodology={workshop.methodology}
            stage={stage}
            myRole={workshop.my_role}
          />
        </StageShell>
      );

    default:
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
}
