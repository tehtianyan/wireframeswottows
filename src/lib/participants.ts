import { queryOptions } from "@tanstack/react-query";
import { participantsApi, type Participant, type WorkshopRoleKey } from "./api";

// Participant management, through the Go API.
//
// IT USED TO WRITE POSTGREST DIRECTLY, and that was a security hole rather than
// a style problem. The RLS policies on workshop_members authorised on
// MEMBERSHIP, not on role:
//
//   UPDATE ... USING is_workshop_member(workshop_id)
//
// so any participant could `update workshop_members set role='facilitator'`
// against themselves, and delete the facilitator. Both were confirmed
// exploitable on the development project before 20261003110000 removed the
// write policies. The UI only offered those controls to a facilitator, which is
// an affordance, not a boundary.
//
// Membership is a permission grant, so it now goes where every other permission
// decision is made: pkg/handlers/participants.go, which checks the role, keeps
// the last facilitator in place, grants workspace access alongside workshop
// access, and writes an audit row.
//
// An earlier bug worth not repeating: these functions once called a
// getSeedWorkshopId() helper that took the FIRST workshop row in the table, so
// a new workshop showed another workshop's roster and every change wrote to the
// wrong one. Every function here takes the workshop it operates on.

export type ParticipantRole = WorkshopRoleKey;
export type { Participant };

export function participantsQueryOptions(workshopId: string) {
  return queryOptions({
    queryKey: ["workshop-participants", workshopId],
    queryFn: () => participantsApi.list(workshopId),
    enabled: Boolean(workshopId),
  });
}

export function inviteParticipant(
  workshopId: string,
  input: { name?: string; email: string; role: ParticipantRole },
) {
  return participantsApi.invite(workshopId, input);
}

export function updateParticipantRole(
  workshopId: string,
  userId: string,
  role: ParticipantRole,
) {
  return participantsApi.setRole(workshopId, userId, role);
}

export function removeParticipant(workshopId: string, userId: string) {
  return participantsApi.revoke(workshopId, userId);
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((n) => n[0])
    .filter(Boolean)
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

/** Roles a facilitator may assign, in the order the picker shows them. */
export const assignableRoles: ParticipantRole[] = [
  "participant",
  "analyst",
  "facilitator",
  "executive_viewer",
  "observer",
];
