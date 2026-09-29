import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface CurrentPerson {
  user_id: string;
  name: string;
}

/**
 * The signed-in person's id and a name to show, for presence on the capture
 * board.
 *
 * Read from the Supabase session rather than the Go API because that is where
 * the identity already is — `request()` in src/lib/api.ts pulls the same
 * session for its Authorization header on every call. Null until the session
 * resolves, and the board simply does not announce presence until then.
 */
export function useCurrentPerson(): CurrentPerson | null {
  const [person, setPerson] = useState<CurrentPerson | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (!user || cancelled) return;

      const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
      const first = typeof meta["first_name"] === "string" ? meta["first_name"] : "";
      const last = typeof meta["last_name"] === "string" ? meta["last_name"] : "";
      const full = `${first} ${last}`.trim();

      setPerson({
        user_id: user.id,
        // Falls back to the local part of the email so a note always carries
        // initials, rather than showing "?" for anyone without a name set.
        name: full || (user.email ?? "").split("@")[0] || "Unknown",
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return person;
}
