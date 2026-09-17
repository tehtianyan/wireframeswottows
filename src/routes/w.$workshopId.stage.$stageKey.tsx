import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { StageShell } from "@/components/methodology/StageShell";
import { CaptureCanvas } from "@/components/methodology/CaptureCanvas";
import { PrioritizationGrid } from "@/components/methodology/PrioritizationGrid";
import { ReviewBoard } from "@/components/methodology/ReviewBoard";
import { EvidenceBoard } from "@/components/methodology/EvidenceBoard";
import { RelationshipMatrix } from "@/components/methodology/RelationshipMatrix";
import { workshopsApi } from "@/lib/api";

// Search params are the stage's own view mode. `validateSearch` must return a
// key only when it is set — returning `{ mode: undefined }` widens the type
// and breaks every other <Link> in the app.
type StageSearch = { mode?: "review" };

// Guidance is per stage TYPE, not per methodology — it describes what the
// step is for in methodology-neutral terms. Anything methodology-specific
// belongs in config (a category's guidance_text, a relationship type's).
const GUIDANCE: Record<string, string> = {
  synthesize:
    "Group related factors into a smaller number of themes. Every theme must cite the factors it rests on, so the analysis stays traceable back to what the workshop actually captured.",
  relate:
    "Pair factors across categories to find strategic moves. Each cell only offers the factor categories its relationship type allows.",
  interpret:
    "State what the analysis means. An insight must cite the themes or relationships that support it — an insight with no evidence is an opinion.",
  recommend:
    "Turn insights into things to do. Each recommendation cites the insights behind it, so a reader can follow any action back to the evidence.",
};

// Returns `{}` rather than `{ guidance: undefined }`, which
// exactOptionalPropertyTypes rejects.
function guidanceFor(stageType: string): { guidance?: string } {
  const g = GUIDANCE[stageType];
  return g ? { guidance: g } : {};
}

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

    // Every stage whose objects cite a list of earlier objects shares one
    // board; what it collects and what it may cite are stage config.
    case "synthesize":
    case "interpret":
    case "recommend":
      return (
        <StageShell workshop={workshop} stage={stage} {...guidanceFor(stage.stage_type)}>
          <EvidenceBoard workshop={workshop} stage={stage} />
        </StageShell>
      );

    case "relate":
      return (
        <StageShell workshop={workshop} stage={stage} {...guidanceFor("relate")}>
          <RelationshipMatrix workshop={workshop} stage={stage} />
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
