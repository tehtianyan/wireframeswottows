import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { inviteParticipantFn } from "./participants.functions";

export type ParticipantRole = "participant" | "analyst" | "facilitator" | "executive_viewer" | "observer";
export type ParticipantStatus = "active" | "invited";

export interface ParticipantRecord {
  id: string;
  name: string;
  email: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  votes_used: number;
  artifacts_count: number;
  comments_count: number;
  joined_at: string | null;
}

// Every function here takes the workshop it operates on.
//
// They used to call a getSeedWorkshopId() helper that did
// `from("workshops").select("id").limit(1).single()` — the FIRST workshop row
// in the table, whichever that happened to be — left over from when there was
// only one. The visible symptom was that a newly created workshop showed the
// demo workshop's roster: people who are not members of it and have no access
// to it. The unseen half was worse: changing a role, activating or removing a
// participant all wrote to that other workshop instead.
export function participantsQueryOptions(workshopId: string) {
  return queryOptions({
    queryKey: ["workshop-participants", workshopId],
    queryFn: async (): Promise<ParticipantRecord[]> => {
      const { data, error } = await supabase
        .from("workshop_roster")
        .select("*")
        .eq("workshop_id", workshopId)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ParticipantRecord[];
    },
    enabled: Boolean(workshopId),
  });
}

export async function inviteParticipant(
  workshopId: string,
  input: { name: string; email: string; role: ParticipantRole },
) {
  await inviteParticipantFn({ data: { workshopId, ...input } });
}

export async function updateParticipantRole(workshopId: string, id: string, role: ParticipantRole) {
  const { error } = await supabase
    .from("workshop_members")
    .update({ role })
    .eq("workshop_id", workshopId)
    .eq("user_id", id);
  if (error) throw error;
}

export async function activateParticipant(workshopId: string, id: string) {
  const { error } = await supabase
    .from("workshop_members")
    .update({ joined_at: new Date().toISOString() })
    .eq("workshop_id", workshopId)
    .eq("user_id", id);
  if (error) throw error;
}

export async function removeParticipant(workshopId: string, id: string) {
  const { error } = await supabase
    .from("workshop_members")
    .delete()
    .eq("workshop_id", workshopId)
    .eq("user_id", id);
  if (error) throw error;
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export const roleLabels: Record<ParticipantRole, string> = {
  participant: "Participant",
  analyst: "Analyst",
  facilitator: "Facilitator",
  executive_viewer: "Executive",
  observer: "Observer",
};
