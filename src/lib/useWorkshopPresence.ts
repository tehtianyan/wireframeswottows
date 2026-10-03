import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Who is in the workshop RIGHT NOW.
//
// WHY THIS EXISTS. The Participants panel showed a green dot next to a "joined"
// status, and reported every person on the roster as joined at all times. Two
// separate reasons:
//
//   * `joined_at` was written by the client and by the seed, so it was set for
//     everyone whether they had ever signed in or not. That is fixed
//     server-side (pkg/handlers/participants.go MarkJoined), so "joined" now
//     means "has opened this workshop at least once".
//   * Even correct, "joined" is not what a green dot means to a reader. A dot
//     reads as "here now". There was previously no way to know that — the
//     earlier fix deliberately relabelled the dot "joined" and said so, because
//     the product had no realtime at the time.
//
// It does now. The capture board already announces presence on its own channel,
// so this generalises that to a workshop-wide channel anybody in the workshop
// joins, which is what lets the roster show genuine online status.
//
// SAME CAVEAT AS THE CAPTURE BOARD: this is a Realtime channel, authorised by
// RLS alone rather than by Go. It carries no workshop DATA — only a list of
// user ids who claim to be present — so the worst a bad actor could do is
// appear in a list of names they are already entitled to see via the roster.

export interface PresentMember {
  user_id: string;
  name: string;
  /** When this browser announced itself; used to show "active just now". */
  online_at: string;
}

export type PresenceStatus = "connecting" | "live" | "unavailable";

/**
 * Announces the caller and reports everyone else present in the same workshop.
 *
 * Returns `unavailable` rather than throwing when the socket cannot be
 * established, so a roster stays usable and can say that live status is not
 * available instead of showing everyone as offline — which would be a
 * different lie from the one this replaces.
 */
export function useWorkshopPresence(
  workshopId: string,
  me: { user_id: string; name: string } | null,
) {
  const [status, setStatus] = useState<PresenceStatus>("connecting");
  const [present, setPresent] = useState<PresentMember[]>([]);

  // Held in a ref so a new object identity for `me` on re-render does not tear
  // the subscription down and rebuild it — the same trap useFactorChannel hit.
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!workshopId || !me?.user_id) return;

    let cancelled = false;
    const channel = supabase.channel(`workshop:${workshopId}:presence`, {
      config: { presence: { key: me.user_id } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        if (cancelled) return;
        const state = channel.presenceState<PresentMember>();
        // One entry per user id: a person with two tabs open is one person
        // present, not two.
        const unique = new Map<string, PresentMember>();
        for (const entries of Object.values(state)) {
          for (const entry of entries) {
            if (entry?.user_id) unique.set(entry.user_id, entry);
          }
        }
        setPresent([...unique.values()]);
      })
      .subscribe((s) => {
        if (cancelled) return;
        if (s === "SUBSCRIBED") {
          setStatus("live");
          const m = meRef.current;
          if (m) {
            void channel.track({
              user_id: m.user_id,
              name: m.name,
              online_at: new Date().toISOString(),
            });
          }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
    // me.user_id rather than me: the identity is what the channel keys on, and
    // the display name is read through the ref.
  }, [workshopId, me?.user_id]);

  return { status, present, onlineIds: new Set(present.map((p) => p.user_id)) };
}
