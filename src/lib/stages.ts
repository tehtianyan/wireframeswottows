import type { Methodology, MethodologyStage, WorkshopRole } from "@/lib/api";

/**
 * Stage types that have a renderer. `knowledge` is the one that does not —
 * the Knowledge Workspace is its own screen, deliberately deferred.
 *
 * Stated here rather than in a route file because two surfaces need the same
 * answer: the overview's stage list marks an unrenderable stage "later phase",
 * and the `/w/{id}` redirect must not drop somebody onto one.
 */
export const RENDERABLE_STAGE_TYPES = new Set([
  "capture",
  "prioritize",
  "synthesize",
  "relate",
  "interpret",
  "recommend",
  "report",
]);

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
 * True when a stage sits outside the participant flow — a TOOL, not a step.
 *
 * Used to split the stage list, and to mark a tool for the roles that can
 * still reach one, so a facilitator reading "9. Theme Analysis" in a list that
 * ends at 6 for everybody else is told why rather than left to infer it from a
 * gap in the numbering.
 *
 * IT ASKS WHETHER PARTICIPANTS ARE EXCLUDED, NOT WHETHER ROLES ARE DECLARED
 * (tightened 2026-11-14). The first version returned true for any present
 * list, which answers a different question: a stage declaring
 * `["participant","analyst"]` is still something the room walks through, and
 * calling it a tool would file a real step under Facilitator tools and drop it
 * out of the health score's denominator.
 *
 * Nothing configured today declares such a list, so this changes no screen —
 * it stops the two statements of the rule from disagreeing. `pkg/handlers/
 * stage_flow.go` holds the Go one, because the health panel and the break-time
 * summary need the same answer, and `tests/suites/participant-flow.js` pins
 * them against each other by reading both files.
 */
export function stageAsideFromFlow(stage: MethodologyStage): boolean {
  const roles = stageVisibleRoles(stage);
  if (roles === null || roles.length === 0) return false;
  return !roles.includes("participant");
}

/**
 * The flow, and the tools, as ONE partition of what this role can see.
 *
 * UAT 2026-11-14: "take the orphaned Stage 7 (Recommendations) to Stage 10
 * (Insight Generation) from the Stages panel and put it in the Overview page."
 * Marking those four in place was the previous answer and it was the smaller
 * half of the job. Dashing their border told a facilitator WHY the numbering
 * runs past everybody else's, which was the complaint it was written for —
 * but they still sat in the flow's own list and in the strip above every
 * stage, so the ten-stage wall the participant flow removed for participants
 * was still there for the one person who has to run the session.
 *
 * SO THEY ARE A SECOND LIST, NOT A STYLED MEMBER OF THE FIRST. The flow is the
 * sequence the room walks; a tool is something a facilitator reaches for
 * between steps, and the two answer different questions badly when mixed.
 *
 * ONE FUNCTION, ONE PASS, so a stage lands in exactly one list BY
 * CONSTRUCTION. Two filters over the same predicate would be two places for
 * the rule to drift, and the failure mode is a stage that appears in neither
 * list — reachable by URL, listed nowhere, which is the shape of every
 * "rendered and wired to nothing" defect in this project.
 *
 * NOTHING HERE NAMES A METHODOLOGY OR A STAGE KEY. `tools` is empty for the
 * other seven methodologies, because no stage of theirs declares
 * `visible_to_roles` — so they get one list, exactly as before, and
 * `tests/suites/genericity.js` asserts PESTLE still shows all of its stages.
 */
export function splitStages(
  stages: MethodologyStage[],
  role: WorkshopRole,
): { flow: MethodologyStage[]; tools: MethodologyStage[] } {
  const flow: MethodologyStage[] = [];
  const tools: MethodologyStage[] = [];
  for (const stage of visibleStages(stages, role)) {
    (stageAsideFromFlow(stage) ? tools : flow).push(stage);
  }
  return { flow, tools };
}

/**
 * The stage a person should land on when they open a workshop — "Stage 1" as
 * the room says it.
 *
 * Null when there is nowhere sensible to land, which the caller renders as the
 * overview instead of an empty screen. Three reasons it can be null, and each
 * is a real state rather than an error:
 *  - the workshop is archived, so the work has ended;
 *  - the caller's role sees no stages at all;
 *  - every stage this role can see is of a type with no renderer yet.
 *
 * `draft` IS NOT ONE OF THEM, and the first version had it wrong (2026-11-07).
 *
 * It read `draft` as "still being configured" and sent those workshops to the
 * overview. That is not what the status means here: §8.7's lifecycle is
 * `draft → configured → active`, two manual advances that NOTHING in capture,
 * theming, rating or review requires — so a workshop sits in `draft` because
 * nobody pressed Advance twice, not because it is unready. Production proved
 * it: five of seven workshops were drafts, one with seven members and a wall of
 * real notes, and every one of them landed on the overview. The rule meant to
 * fire on the exception fired on the normal case.
 *
 * `archived` stays, because that one is a real end state: writes are frozen by
 * a trigger on every workshop-scoped table, so a capture board there would
 * refuse everything a person tried. The overview is the page that says why, and
 * it still carries the reports.
 *
 * It reads `visibleStages`, so it is the SAME rule as the stage header and the
 * overview list — a redirect that landed somebody on a stage their navigation
 * then hid would be the worst of both. It takes the first visible stage in the
 * methodology's own order, which since 20261106100000 is the participant flow's
 * order: for SWOT-TOWS a participant's stage 1 is Strengths.
 */
export function firstStageFor(workshop: {
  status: string;
  my_role: WorkshopRole;
  methodology: Methodology;
}): MethodologyStage | null {
  if (workshop.status === "archived") return null;
  const visible = visibleStages(workshop.methodology.stages, workshop.my_role);
  return visible.find((s) => RENDERABLE_STAGE_TYPES.has(s.stage_type)) ?? null;
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
