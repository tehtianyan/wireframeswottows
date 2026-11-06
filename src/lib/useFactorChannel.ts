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

// CHANGE NOTIFICATIONS ONLY, AS THE NAME SAYS (narrowed 2026-11-06).
//
// This channel also used to announce presence, and that was half of why the
// Participants panel never showed anybody: the board announced on
// `workshop:{id}` while the roster listened on `workshop:{id}:presence`. Two
// channels for one question, so the two surfaces could not agree by
// construction. Presence now lives in exactly one place — the workshop's layout
// route, via src/lib/workshop-presence.tsx — and this hook went back to doing
// the one thing it is named for.
//
// It also removes a smaller latent bug: presence was keyed on
// `me?.user_id ?? "anonymous"`, so two clients with no session yet collided on
// one presence key and displaced each other.

export type ChannelStatus = "connecting" | "live" | "unavailable";

/**
 * Subscribes to factor changes in one workshop and invalidates the cache.
 *
 * Returns `unavailable` rather than throwing if the channel cannot be
 * established — a workshop must stay usable when a socket fails, so the board
 * falls back to polling and says so instead of appearing to be live.
 */
export function useFactorChannel(workshopId: string) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ChannelStatus>("connecting");

  useEffect(() => {
    if (!workshopId) return;
    let cancelled = false;

    const channel = supabase.channel(`workshop:${workshopId}`);

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
      .subscribe((s) => {
        if (cancelled) return;
        if (s === "SUBSCRIBED") {
          setStatus("live");
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [workshopId, queryClient]);

  return { status };
}
