import type { MethodologyStage, WorkshopRole } from "@/lib/api";

/**
 * Which stages a role sees in navigation.
 *
 * SWOT-TOWS runs capture, theming and prioritisation together on each capture
 * stage, so Prioritization, Theme Analysis and Insight Generation are no
 * longer steps a participant walks through — they are tools a facilitator
 * reaches for. They declare `visible_to_roles: ["facilitator"]` and leave
 * everybody else's navigation.
 *
 * THIS IS AN AFFORDANCE, NOT A BOUNDARY, and the distinction is deliberate
 * rather than lazy. The data behind those stages is the participant's own
 * notes, their own themes and their own ratings — there is nothing to protect,
 * only clutter to remove. A pasted URL still opens, which is what lets a
 * facilitator send somebody to a stage when the room needs it. Compare
 * `workshop_members`, where the write path was REMOVED rather than narrowed,
 * because that one was a boundary.
 *
 * IT IS ALSO CONFIGURATION. `visible_to_roles` is read, never assumed: a stage
 * that does not declare it is visible to everyone, which is every stage of the
 * other seven methodologies. Nothing here names SWOT-TOWS or a stage key, so
 * a methodology that wants a different flow expresses it in its own config and
 * `tests/suites/genericity.js` asserts PESTLE still shows all of its stages.
 */
export function stageVisibleRoles(stage: MethodologyStage): WorkshopRole[] | null {
  const raw = stage.config["visible_to_roles"];
  // Absent, or not an array, means the stage declares no restriction. A
  // PRESENT array is honoured literally, including an empty one — a stage
  // nobody can see is at least loudly absent, where quietly showing it to
  // everyone would contradict what the config says.
  if (!Array.isArray(raw)) return null;
  return raw.filter((r): r is WorkshopRole => typeof r === "string");
}

/** True when this role may see the stage in navigation. */
export function stageVisibleTo(stage: MethodologyStage, role: WorkshopRole): boolean {
  const roles = stageVisibleRoles(stage);
  return roles === null || roles.includes(role);
}

/** The stages this role sees, in the methodology's own order. */
export function visibleStages(
  stages: MethodologyStage[],
  role: WorkshopRole,
): MethodologyStage[] {
  return stages.filter((s) => stageVisibleTo(s, role));
}

/**
 * True when a stage sits outside the participant flow.
 *
 * Used to MARK it for the roles that can still see it, so a facilitator
 * reading "9. Theme Analysis" in a list that ends at 7 for everybody else is
 * told why rather than left to infer it from a gap in the numbering.
 */
export function stageAsideFromFlow(stage: MethodologyStage): boolean {
  return stageVisibleRoles(stage) !== null;
}

/**
 * The weight keys a methodology attaches to the objects a `synthesize` stage
 * produces — the themes the capture board creates by stacking notes.
 *
 * Read from the SYNTHESIZE stage rather than from the capture stage, because
 * that is where Porter's Five Forces already declares the rating its force
 * assessments carry (`{"groups":"factor","weights":["intensity"]}`). Following
 * the existing convention means one question answers it for any methodology,
 * and that the same rating renders on the synthesize stage itself.
 *
 * Returns an empty array when the methodology declares none, which is how a
 * board with no theme rating stays a board with no theme rating.
 */
export function synthesisWeightKeys(stages: MethodologyStage[]): string[] {
  const stage = stages.find((s) => s.stage_type === "synthesize");
  const raw = stage?.config["weights"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string");
}
