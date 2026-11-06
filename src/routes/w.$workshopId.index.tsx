import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
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
// So the redirect lives here, at the one address they all share, and the
// overview moved to `/w/{id}/overview`. One statement of the rule, and every
// existing and future link to a workshop lands in the work.
//
// IT IS A COMPONENT, NOT A LOADER, AND THAT DISTINCTION IS THE WHOLE BUG.
//
// The first version resolved the workshop in a `loader` and threw `redirect`,
// on the reasoning that redirecting from a rendered component paints a screen
// and then leaves it. Correct in general and WRONG IN THIS APP, because
// **authentication here is entirely client-side**: `request()` reads the
// Supabase session out of the browser, and AuthGate decides what renders. A
// loader runs on the SERVER for a hard navigation, where that session does not
// exist — so `workshopsApi.get` came back 401, the loader threw, and
// **pasting or bookmarking `/w/{id}` showed "This page didn't load"**.
//
// Nothing else caught it. Every suite passed, `tsc` and the build were clean,
// and clicking a workshop from inside the app worked perfectly, because that
// is a CLIENT-side navigation where the session is present. It took a real
// browser doing a hard `goto` on the deployed site — which is the standing
// reason for that check. Every other data route in this app loads in a
// component for exactly this reason; the loader was the odd one out.
//
// The cost is a spinner for one render instead of a server redirect. That is
// the right trade against an entry point that 500s on a pasted URL.

export const Route = createFileRoute("/w/$workshopId/")({
  component: WorkshopEntry,
});

function WorkshopEntry() {
  const { workshopId } = Route.useParams();
  const navigate = useNavigate();

  // The same query key the layout, the overview and the stage route use, so
  // arriving from a screen that already loaded this workshop costs no request.
  const { data, isError, error } = useQuery({
    queryKey: ["workshop", workshopId],
    queryFn: () => workshopsApi.get(workshopId),
  });

  useEffect(() => {
    if (!data) return;
    const target = firstStageFor(data);
    if (target) {
      void navigate({
        to: "/w/$workshopId/stage/$stageKey",
        params: { workshopId, stageKey: target.key },
        search: {},
        // Replace, so Back goes where the person came from rather than
        // bouncing off this address and forwards into the stage again.
        replace: true,
      });
      return;
    }
    // NO STAGE TO LAND ON, so show the page that can explain why. A draft
    // workshop is still being set up, an archived one is finished, and somebody
    // whose role sees no stages at all has nothing to be dropped into. In each
    // case the overview carries the status badge, the objective and the archive
    // notice — a redirect into an empty stage would have hidden all of it.
    void navigate({
      to: "/w/$workshopId/overview",
      params: { workshopId },
      replace: true,
    });
  }, [data, navigate, workshopId]);

  if (isError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-destructive">Could not open this workshop.</p>
        <p className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : "Please try again."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Opening workshop…</span>
    </div>
  );
}
