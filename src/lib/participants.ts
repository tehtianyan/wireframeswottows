import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ParticipantRole = "participant" | "analyst" | "facilitator" | "executive";
export type ParticipantPresence = "online" | "idle" | "offline";
export type ParticipantStatus = "active" | "invited" | "removed";

export interface ParticipantRecord {
  id: string;
  name: string;
  email: string;
  role: ParticipantRole;
  presence: ParticipantPresence;
  status: ParticipantStatus;
  votes_used: number;
  artifacts_count: number;
  comments_count: number;
  joined_at: string;
  last_active: string;
}

const columns =
  "id,name,email,role,presence,status,votes_used,artifacts_count,comments_count,joined_at,last_active";

export const participantsQueryOptions = queryOptions({
  queryKey: ["workshop-participants"],
  queryFn: async (): Promise<ParticipantRecord[]> => {
    const { data, error } = await supabase
      .from("workshop_participants")
      .select(columns)
      .neq("status", "removed")
      .order("name", { ascending: true });
    if (error) throw error;
    return (data ?? []) as ParticipantRecord[];
  },
});

export async function inviteParticipant(input: { name: string; email: string; role: ParticipantRole }) {
  const { error } = await supabase.from("workshop_participants").insert({
    name: input.name,
    email: input.email,
    role: input.role,
    presence: "offline",
    status: "invited",
    last_active: "never",
  });
  if (error) throw error;
}

export async function updateParticipantRole(id: string, role: ParticipantRole) {
  const { error } = await supabase.from("workshop_participants").update({ role }).eq("id", id);
  if (error) throw error;
}

export async function activateParticipant(id: string) {
  const { error } = await supabase
    .from("workshop_participants")
    .update({ status: "active", last_active: "just now", presence: "online" })
    .eq("id", id);
  if (error) throw error;
}

export async function removeParticipant(id: string) {
  const { error } = await supabase
    .from("workshop_participants")
    .update({ status: "removed", presence: "offline" })
    .eq("id", id);
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
  executive: "Executive",
};
