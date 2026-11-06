import { createContext, useContext, type ReactNode } from "react";
import {
  useWorkshopPresence,
  type WorkshopPresence,
} from "@/lib/useWorkshopPresence";

// ONE presence announcement per workshop, shared by every surface that shows it.
//
// The two faults this replaces are described in useWorkshopPresence.ts. The
// short version: presence used to be announced by the Participants panel, which
// lives in a drawer that unmounts when closed, on a DIFFERENT channel from the
// one the capture board announced on. So the roster could only ever show people
// who happened to be reading the roster.
//
// Mounting it at the layout route means the answer to "am I announced?" is "yes,
// because I am in the workshop" — which is what a green dot claims. Every
// consumer reads the same list, so the board's avatars and the roster's dots can
// no longer disagree.

const PresenceContext = createContext<WorkshopPresence | null>(null);

export function WorkshopPresenceProvider({
  workshopId,
  me,
  children,
}: {
  workshopId: string;
  /** Null until the session and the workshop role resolve; nothing is announced until then. */
  me: { user_id: string; name: string; role: string } | null;
  children: ReactNode;
}) {
  const presence = useWorkshopPresence(workshopId, me);
  return <PresenceContext.Provider value={presence}>{children}</PresenceContext.Provider>;
}

/**
 * The shared presence for the workshop this component is inside.
 *
 * Outside a provider it reports `unavailable` with nobody present rather than
 * throwing. That is deliberate and it is the honest answer: a surface that
 * cannot know who is here must OMIT the dot, never draw a grey one, because a
 * grey dot is a guess and an absent dot is a fact. A component rendered outside
 * a workshop therefore degrades to "live status not available" instead of
 * taking the page down.
 */
export function useWorkshopPresenceContext(): WorkshopPresence {
  return (
    useContext(PresenceContext) ?? {
      status: "unavailable",
      present: [],
      onlineIds: new Set<string>(),
    }
  );
}
