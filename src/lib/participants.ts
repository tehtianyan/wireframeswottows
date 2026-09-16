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

// There is exactly one workshop in this prototype today, so the roster is
// scoped to whichever workshop row exists rather than a workshop-switcher.
async function getSeedWorkshopId(): Promise<string> {
  const { data, error } = await supabase.from("workshops").select("id").limit(1).single();
  if (error) throw error;
  return data.id;
}

export const participantsQueryOptions = queryOptions({
  queryKey: ["workshop-participants"],
  queryFn: async (): Promise<ParticipantRecord[]> => {
    const workshopId = await getSeedWorkshopId();
    const { data, error } = await supabase
      .from("workshop_roster")
      .select("*")
      .eq("workshop_id", workshopId)
      .order("name", { ascending: true });
    if (error) throw error;
    return (data ?? []) as ParticipantRecord[];
  },
});

export async function inviteParticipant(input: { name: string; email: string; role: ParticipantRole }) {
  const workshopId = await getSeedWorkshopId();
  await inviteParticipantFn({ data: { workshopId, ...input } });
}

export async function updateParticipantRole(id: string, role: ParticipantRole) {
  const workshopId = await getSeedWorkshopId();
  const { error } = await supabase
    .from("workshop_members")
    .update({ role })
    .eq("workshop_id", workshopId)
    .eq("user_id", id);
  if (error) throw error;
}

export async function activateParticipant(id: string) {
  const workshopId = await getSeedWorkshopId();
  const { error } = await supabase
    .from("workshop_members")
    .update({ joined_at: new Date().toISOString() })
    .eq("workshop_id", workshopId)
    .eq("user_id", id);
  if (error) throw error;
}

export async function removeParticipant(id: string) {
  const workshopId = await getSeedWorkshopId();
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
