import { createFileRoute, redirect } from "@tanstack/react-router";
import { workshopsApi } from "@/lib/api";
import { firstStageFor } from "@/lib/stages";

// CLICKING A WORKSHOP PUTS YOU IN IT (2026-11-06).
//
// UAT: "the Facilitator clicks on the Workshop of choice and should land into
// Stage 1, skip the workshop page two directories above it." Eight places in
// the app link to `/w/{id}` — the nav menu's dropdown, the workshop list, the
// dashboard's cards and attention list, notifications, knowledge and the
// executive dashboard. Rewriting all eight would have left the next new link to
// get it wrong, and the ones pointing here from a notification genuinely mean
// "this workshop" rather than "this step of it".
//
// So the REDIRECT lives here, at the one address they all share, and the
// overview moved to `/w/{id}/overview`. One statement of the rule, and every
// existing and future link to a workshop lands in the work.
//
// IT IS A LOADER, NOT AN EFFECT. Redirecting from a rendered component means
// painting a screen and then leaving it, which reads as a flash of the wrong
// page — and on the server there is no window to navigate with at all. Throwing
// from the loader means the stage is what the browser is ever asked to draw.

export const Route = createFileRoute("/w/$workshopId/")({
  loader: async ({ params, context }) => {
    // Served from cache when the caller arrived from a screen that already
    // loaded this workshop, which is most of them.
    const workshop = await context.queryClient.ensureQueryData({
      queryKey: ["workshop", params.workshopId],
      queryFn: () => workshopsApi.get(params.workshopId),
    });

    const target = firstStageFor(workshop);
    if (!target) {
      // NO STAGE TO LAND ON, so show the page that can explain why. A draft
      // workshop is still being set up, an archived one is finished, and
      // somebody whose role sees no stages at all has nothing to be dropped
      // into. In each case the overview carries the status badge, the objective
      // and the archive notice — the redirect would have hidden all of it
      // behind an empty stage.
      throw redirect({
        to: "/w/$workshopId/overview",
        params: { workshopId: params.workshopId },
      });
    }

    throw redirect({
      to: "/w/$workshopId/stage/$stageKey",
      params: { workshopId: params.workshopId, stageKey: target.key },
      search: {},
    });
  },
});
