import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { workshopsApi } from "@/lib/api";
import { useCurrentPerson } from "@/lib/useCurrentPerson";
import { WorkshopPresenceProvider } from "@/lib/workshop-presence";

// The workshop layout: everything under /w/{id} renders inside this.
//
// IT EXISTS FOR ONE REASON — to be the place presence is announced from. Being
// present in a workshop is a property of being IN the workshop, so it has to be
// announced somewhere that stays mounted while you move between stages, the
// overview and review mode. Before this route existed the only announcer was
// the Participants panel, inside a drawer that unmounts when closed, which is
// why two people in the same workshop never saw each other.
//
// It deliberately renders no chrome. The stage header (StageShell) and the
// overview each own their own layout, and adding a shared wrapper here would
// put a second header above both.

export const Route = createFileRoute("/w/$workshopId")({
  component: WorkshopLayout,
});

function WorkshopLayout() {
  const { workshopId } = Route.useParams();
  const person = useCurrentPerson();

  // The same query key the overview and the stage route use, so this is served
  // from cache and costs no extra request. The role is read from it rather than
  // guessed: presence carries the role for display, and a participant announcing
  // themselves as a facilitator would be a lie the roster then repeats.
  const workshopQuery = useQuery({
    queryKey: ["workshop", workshopId],
    queryFn: () => workshopsApi.get(workshopId),
  });

  const me =
    person && workshopQuery.data
      ? { ...person, role: workshopQuery.data.my_role }
      : null;

  return (
    <WorkshopPresenceProvider workshopId={workshopId} me={me}>
      <Outlet />
    </WorkshopPresenceProvider>
  );
}
