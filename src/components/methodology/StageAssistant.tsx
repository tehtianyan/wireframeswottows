import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AiActionPanel } from "./AiActionPanel";
import { aiApi, type MethodologyStage, type WorkshopDetail } from "@/lib/api";

// THE ASSISTANT IS A BUTTON, NOT A COLUMN (DECIDED 2026-11-07)
//
// UAT: "integrate the AI Assistant function into the panels on the left so that
// we can remove the AI Assistant panel altogether and free up the screen space
// at the right." The capture board made this move on 2026-11-05 and it stopped
// there, so the other six stage types each still gave a permanent 340px of a
// 1192px screen to a panel holding one or two buttons. On the TOWS matrix that
// column rendered EMPTY beside the matrix at 1440 — noticed in a screenshot the
// day before this was reported, which is how a reserved column reads when the
// stage it sits beside has nothing stage-scoped to offer.
//
// So the trigger goes in the stage header, next to Review mode: the one surface
// every stage type already shares, directly above the content. One
// implementation, every stage, and the content column gets the whole width.
//
// THE PANEL IS REUSED, NOT REIMPLEMENTED — the same rule the board's composer
// ✨ follows. A header-sized copy of it would be a second implementation of the
// rate limit, the per-suggestion review, the renderer chosen from the declared
// `output_kind` and the "only a facilitator or analyst may add these" refusal,
// and a second place for all four to drift away from the server.
//
// IT RENDERS NOTHING WHEN THERE IS NOTHING BEHIND IT. `AiActionPanel` already
// returns null when the server has no key configured or the stage has no
// `scope='stage'` prompt — correct for a column, which simply did not appear,
// and NOT enough for a trigger, which would have sat in the header and opened
// an empty popover. That is the shape this codebase keeps finding: a control
// rendered and wired to nothing. So the availability question is asked here,
// before the button exists.
//
// It asks through the SAME query key the panel uses, so the answer is shared
// from the cache and the gate costs no extra request.

export function useStageAssistantAvailable(workshopId: string, stageKey: string): boolean {
  const { data } = useQuery({
    queryKey: ["ai-status", workshopId, stageKey],
    queryFn: () => aiApi.status(workshopId, stageKey),
  });
  if (!data?.configured) return false;
  // The same filter the panel applies. Object- and workshop-scoped actions are
  // offered on the card and the overview they act on (App Spec §13.10-13.12),
  // so they must not light up a stage button that could not run them.
  return data.functions.some((f) => f.scope === "stage");
}

export function StageAssistant({
  workshop,
  stage,
}: {
  workshop: WorkshopDetail;
  stage: MethodologyStage;
}) {
  const available = useStageAssistantAvailable(workshop.id, stage.key);
  if (!available) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Ask the assistant about this stage"
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkles className="size-3.5" />
          AI assistant
        </button>
      </PopoverTrigger>
      {/* The panel is a console panel: its own border, radius and shadow. Inside
          a popover that is a second frame around the first, so its chrome is
          suppressed here rather than made conditional in the panel — the same
          treatment the board's composer popover gives it. */}
      <PopoverContent
        align="end"
        side="bottom"
        className="max-h-[70vh] w-[24rem] overflow-y-auto p-0 [&>section]:rounded-none [&>section]:border-0 [&>section]:shadow-none"
      >
        <AiActionPanel workshop={workshop} stage={stage} />
      </PopoverContent>
    </Popover>
  );
}
