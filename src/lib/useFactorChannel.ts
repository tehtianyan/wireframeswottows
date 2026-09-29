import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

// Live updates for the capture board.
//
// THIS IS THE ONLY CLIENT READ THAT DOES NOT PASS THROUGH GO. Everywhere else
// the Go API is the trust boundary and Postgres RLS is a secondary net that Go
// itself bypasses (it connects as `postgres`, which has rolbypassrls). A
// Realtime subscription goes straight from the browser to Postgres and is
// authorised by RLS ALONE — by public.is_workshop_member(), which had to be
// fixed to check workspace membership before this could ship. See
// 20260929100000_realtime_capture_board.sql and tests/suites/scoping.js.
//
// The socket carries CHANGE NOTIFICATIONS ONLY. It never becomes the source of
// truth: every event just invalidates the TanStack Query cache, which refetches
// through Go. So the data a person sees has always passed the full three-level
// check, and a compromised or stale socket can at worst cause an extra fetch.

export interface PresentPerson {
  user_id: string;
  name: string;
  role: string;
}

export type ChannelStatus = "connecting" | "live" | "unavailable";

/**
 * Subscribes to factor changes in one workshop and announces who is present.
 *
 * Returns `unavailable` rather than throwing if the channel cannot be
 * established — a workshop must stay usable when a socket fails, so the board
 * falls back to polling and says so instead of appearing to be live.
 */
export function useFactorChannel(
  workshopId: string,
  me: { user_id: string; name: string; role: string } | null,
) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ChannelStatus>("connecting");
  const [present, setPresent] = useState<PresentPerson[]>([]);
  // Kept in a ref so re-rendering with a new object identity does not tear the
  // subscription down and build it again.
  const meRef = useRef(me);
  meRef.current = me;

  useEffect(() => {
    if (!workshopId) return;
    let cancelled = false;

    const channel = supabase.channel(`workshop:${workshopId}`, {
      config: { presence: { key: meRef.current?.user_id ?? "anonymous" } },
    });

    channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "factors", filter: `workshop_id=eq.${workshopId}` },
        () => {
          // Deliberately not patching the cache from the payload: the row that
          // arrives here came from Postgres directly, and the board must only
          // ever render what Go returned. Invalidate and let the query refetch.
          queryClient.invalidateQueries({ queryKey: ["factors", workshopId] });
        },
      )
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<PresentPerson>();
        const people = Object.values(state)
          .flat()
          .filter((p): p is PresentPerson & { presence_ref: string } => Boolean(p?.user_id));
        // One entry per person, however many tabs they have open.
        const unique = new Map<string, PresentPerson>();
        for (const p of people) {
          unique.set(p.user_id, { user_id: p.user_id, name: p.name, role: p.role });
        }
        if (!cancelled) setPresent([...unique.values()]);
      })
      .subscribe((s) => {
        if (cancelled) return;
        if (s === "SUBSCRIBED") {
          setStatus("live");
          if (meRef.current) void channel.track(meRef.current);
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [workshopId, queryClient]);

  return { status, present };
}
