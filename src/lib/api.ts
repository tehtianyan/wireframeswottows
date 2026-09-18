// Client for the Go backend's /api/v1 REST surface. Separate from the
// Supabase client used for auth/participants — this is Go's API, which is
// its own trust boundary and does its own authorization.
import { supabase } from "@/integrations/supabase/client";

interface Envelope<T> {
  success: boolean;
  data: T | null;
  message: string | null;
  error?: { code: string; message: string };
}

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  };
  if (init?.body !== undefined) {
    requestInit.body = init.body;
  }

  const res = await fetch(`/api/v1${path}`, requestInit);

  const envelope: Envelope<T> = await res.json();
  if (!envelope.success) {
    throw new ApiError(envelope.error?.code ?? "SERVER_ERROR", envelope.error?.message ?? "Request failed");
  }
  return envelope.data as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

// Built imperatively rather than with a spread: `exactOptionalPropertyTypes`
// rejects an explicit `body: undefined` on RequestInit.
function withBody(method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return init;
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, withBody("POST", body));
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, withBody("PATCH", body));
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, withBody("PUT", body));
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

// ---- Types matching the Go JSON shapes ----

export interface FactorCategory {
  id: string;
  key: string;
  name: string;
  color_token: string;
  sort_order: number;
  guidance_text: string;
}

export interface RelationshipType {
  id: string;
  key: string;
  name: string;
  source_category_id: string;
  target_category_id: string;
  guidance_text: string;
}

export interface MethodologyStage {
  id: string;
  key: string;
  name: string;
  sequence_number: number;
  stage_type: "capture" | "prioritize" | "synthesize" | "relate" | "interpret" | "recommend" | "report" | "knowledge";
  config: Record<string, unknown>;
}

export interface Methodology {
  id: string;
  key: string;
  name: string;
  factor_categories: FactorCategory[];
  stages: MethodologyStage[];
  relationship_types: RelationshipType[];
}

export interface Workshop {
  id: string;
  workspace_id: string;
  methodology_id: string;
  name: string;
  description: string | null;
  objective: string | null;
  facilitator_id: string | null;
  status: string;
  votes_per_participant: number;
  created_at: string;
}

export interface WorkshopDetail extends Workshop {
  methodology: Methodology;
  /** The caller's own workshop role. Go re-checks every action regardless. */
  my_role: WorkshopRole;
}

export type WorkshopRole = "facilitator" | "participant" | "analyst" | "executive_viewer" | "observer";

/** Mirrors `reviewerRoles` in pkg/handlers/factors.go. */
export const REVIEWER_ROLES: WorkshopRole[] = ["facilitator", "analyst"];
/** Mirrors `votingRoles` in pkg/handlers/votes.go. */
export const VOTING_ROLES: WorkshopRole[] = ["facilitator", "participant", "analyst"];

export const canReview = (role: WorkshopRole) => REVIEWER_ROLES.includes(role);
export const canVote = (role: WorkshopRole) => VOTING_ROLES.includes(role);

/** The governance lifecycle every object type shares (App Spec §8). */
export type FactorState = "draft" | "submitted" | "approved" | "rejected";

export interface MethodologySummary {
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  category_count: number;
  stage_count: number;
}

export interface VoteAllocation {
  factor_id: string;
  vote_value: number;
}

export interface VoteSummary {
  budget: number;
  used: number;
  remaining: number;
  allocations: VoteAllocation[];
}

export interface Activity {
  id: string;
  stage_key: string;
  title: string;
  status: string;
}

export interface Factor {
  id: string;
  workshop_id: string;
  category_key: string;
  title: string;
  description: string | null;
  created_by: string | null;
  state: FactorState;
  votes: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
  can_create_workshops: boolean;
}

// ---- Reviewable analysis objects (Phase 2) ----
//
// Syntheses, relationships, insights and recommendations share one wire shape
// and one set of endpoints, driven by the server-side registry. The UI reads
// field definitions from /object-kinds rather than hardcoding them.

export type ObjectKindKey = "synthesis" | "factor_relationship" | "insight" | "recommendation";

/** What a stage's objects may cite, read from methodology stage config. */
export type CitableKind = "factor" | "synthesis" | "factor_relationship" | "insight";

export interface ObjectField {
  name: string;
  label: string;
  type: "text" | "textarea" | "enum" | "int";
  required: boolean;
  options?: string[];
  help?: string;
}

export interface ObjectKind {
  key: ObjectKindKey;
  route: string;
  label: string;
  stage_type: string;
  title_required: boolean;
  description_label: string;
  fields: ObjectField[];
  evidence: { cites_kind: CitableKind }[];
  pairing?: { pairs_kind: CitableKind };
}

export interface WorkObject {
  id: string;
  workshop_id: string;
  kind: ObjectKindKey;
  title: string | null;
  description: string | null;
  state: FactorState;
  generated_by: "human" | "ai" | "hybrid";
  confidence_score: number | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  fields: Record<string, unknown>;
  evidence: Partial<Record<CitableKind, string[]>>;
  source_id?: string;
  target_id?: string;
  relationship_type_id?: string;
}

export interface WriteObjectInput {
  title?: string | null;
  description?: string | null;
  fields?: Record<string, unknown>;
  evidence?: Partial<Record<CitableKind, string[]>>;
  source_id?: string;
  target_id?: string;
  relationship_type_key?: string;
}

export const objectKindsApi = {
  list: () => apiGet<ObjectKind[]>("/object-kinds"),
};

export const objectsApi = {
  list: (workshopId: string, route: string, state?: FactorState) =>
    apiGet<WorkObject[]>(`/workshops/${workshopId}/${route}${state ? `?state=${state}` : ""}`),
  create: (workshopId: string, route: string, input: WriteObjectInput) =>
    apiPost<{ id: string }>(`/workshops/${workshopId}/${route}`, input),
  update: (workshopId: string, route: string, objectId: string, input: WriteObjectInput) =>
    apiPatch<{ id: string }>(`/workshops/${workshopId}/${route}/${objectId}`, input),
  remove: (workshopId: string, route: string, objectId: string) =>
    apiDelete<{ id: string }>(`/workshops/${workshopId}/${route}/${objectId}`),
  review: (workshopId: string, route: string, objectId: string, input: { action: "approve" | "reject"; note?: string }) =>
    apiPost<{ id: string; state: FactorState }>(`/workshops/${workshopId}/${route}/${objectId}/review`, input),
};

// ---- AI Strategy Assistant (Phase 3) ----
//
// Prompt templates are deliberately absent from every type here: they live on
// the server and the API never returns them.

export interface AIFunction {
  function_key: string;
  name: string;
  /** Empty for functions available anywhere in the workshop. */
  stage_type: string;
}

export interface AIStatus {
  configured: boolean;
  limit_per_hour: number;
  used_this_hour: number;
  functions: AIFunction[];
}

export type AIReviewStatus = "pending" | "accepted" | "edited" | "rejected";

export interface AIOutput {
  id: string;
  session_id: string;
  output_type: string;
  content: Record<string, unknown>;
  human_review_status: AIReviewStatus;
  prompt_version: string | null;
  stage_key: string | null;
  created_at: string;
  converted_object_type: string | null;
  converted_object_id: string | null;
}

export interface AIExecuteResult {
  session_id: string;
  output_id: string;
  output_type: string;
  content: Record<string, unknown>;
  human_review_status: AIReviewStatus;
}

/** Pulls the suggestion list out of an output, whatever key it is under. */
export function aiSuggestions(content: Record<string, unknown>): Record<string, unknown>[] {
  for (const v of Object.values(content ?? {})) {
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

export const aiApi = {
  status: (workshopId: string, stageKey?: string) =>
    apiGet<AIStatus>(`/workshops/${workshopId}/ai${stageKey ? `?stage_key=${stageKey}` : ""}`),
  execute: (workshopId: string, input: { stage_key: string; function_key: string }) =>
    apiPost<AIExecuteResult>(`/workshops/${workshopId}/ai/execute`, input),
  outputs: (workshopId: string, filters?: { status?: AIReviewStatus; stage_key?: string }) => {
    const qs = new URLSearchParams();
    if (filters?.status) qs.set("status", filters.status);
    if (filters?.stage_key) qs.set("stage_key", filters.stage_key);
    return apiGet<AIOutput[]>(`/workshops/${workshopId}/ai/outputs${qs.toString() ? `?${qs}` : ""}`);
  },
  review: (
    workshopId: string,
    outputId: string,
    input: { action: "accept" | "reject"; index?: number; stage_key?: string; overrides?: WriteObjectInput },
  ) => apiPost<{ id: string; human_review_status: AIReviewStatus; converted_object_id?: string }>(
    `/workshops/${workshopId}/ai/outputs/${outputId}/review`, input),
};

// ---- Reporting (Phase 4) ----

export type ReportState = "draft" | "submitted" | "approved" | "published" | "rejected" | "archived";

export type SectionType =
  | "narrative" | "bullet_list" | "table" | "object_list"
  | "category_matrix" | "pair_matrix" | "evidence_chain" | "appendix";

export interface ReportTypeOption {
  key: string;
  name: string;
  description: string;
  default: boolean;
  section_count: number;
  can_generate: boolean;
  /** Why it cannot be generated yet (App Spec §14.12). */
  missing: string[];
}

export interface ReportSectionItem {
  id: string;
  kind: CitableKind;
  title: string;
  body?: string;
  state: string;
  included: boolean;
  fields?: Record<string, unknown>;
}

export interface ReportSectionGroup {
  key: string;
  name: string;
  color_token?: string;
  source_name?: string;
  target_name?: string;
  items: ReportSectionItem[];
}

export interface ReportEvidenceChain {
  root: ReportSectionItem;
  supports: Record<string, ReportSectionItem[]>;
}

export interface ReportSection {
  id: string;
  section_key: string;
  name: string;
  section_type: SectionType;
  sort_order: number;
  included: boolean;
  selectable: boolean;
  body: string | null;
  generated_by: "human" | "ai" | "hybrid";
  source: Record<string, unknown>;
  groups?: ReportSectionGroup[];
  items?: ReportSectionItem[];
  chains?: ReportEvidenceChain[];
}

export interface Report {
  id: string;
  workshop_id: string;
  title: string;
  report_type: string;
  state: ReportState;
  version: string;
  root_id: string;
  created_at: string;
  published_at: string | null;
  review_note: string | null;
}

export interface ReportDetail extends Report {
  sections: ReportSection[];
  /** True when content came from the publish-time snapshot, not live data. */
  from_snapshot: boolean;
}

export const reportsApi = {
  types: (workshopId: string) => apiGet<ReportTypeOption[]>(`/workshops/${workshopId}/report-types`),
  list: (workshopId: string) => apiGet<Report[]>(`/workshops/${workshopId}/reports`),
  get: (workshopId: string, reportId: string) =>
    apiGet<ReportDetail>(`/workshops/${workshopId}/reports/${reportId}`),
  create: (workshopId: string, input: { report_type: string; title?: string }) =>
    apiPost<{ id: string; state: ReportState }>(`/workshops/${workshopId}/reports`, input),
  updateSections: (workshopId: string, reportId: string,
    sections: { id: string; sort_order: number; included: boolean }[]) =>
    apiPut<{ id: string }>(`/workshops/${workshopId}/reports/${reportId}/sections`, { sections }),
  updateSection: (workshopId: string, reportId: string, sectionId: string, body: string | null) =>
    apiPatch<{ id: string; generated_by: string }>(
      `/workshops/${workshopId}/reports/${reportId}/sections/${sectionId}`, { body }),
  review: (workshopId: string, reportId: string, input: { action: "submit" | "approve" | "reject"; note?: string }) =>
    apiPost<{ id: string; state: ReportState }>(`/workshops/${workshopId}/reports/${reportId}/review`, input),
  publish: (workshopId: string, reportId: string) =>
    apiPost<{ id: string; state: ReportState; version: string }>(
      `/workshops/${workshopId}/reports/${reportId}/publish`),
  newVersion: (workshopId: string, reportId: string, bump: "minor" | "major") =>
    apiPost<{ id: string; version: string }>(
      `/workshops/${workshopId}/reports/${reportId}/versions`, { bump }),
  /** Server-rendered, self-contained HTML — the second export format. */
  exportHtmlUrl: (workshopId: string, reportId: string) =>
    `/api/v1/workshops/${workshopId}/reports/${reportId}/export.html`,
};

// ---- Dashboard ----

export interface KindCount {
  kind: string;
  label: string;
  total: number;
  approved: number;
  awaiting_review: number;
}

export interface ActivityEvent {
  action: string;
  object_type: string;
  actor_name: string;
  new_state: string | null;
  created_at: string;
}

export interface DashboardWorkshop {
  id: string;
  name: string;
  status: string;
  methodology_name: string;
  my_role: WorkshopRole;
  stages_total: number;
  stages_complete: number;
  counts: KindCount[];
  awaiting_review: number;
  first_stage_key: string;
}

export interface Dashboard {
  workshops: DashboardWorkshop[];
  awaiting_my_review: number;
  recent_activity: ActivityEvent[];
}

export interface HealthSignal {
  key: string;
  label: string;
  value: number;
  target: number;
  message: string;
}

export interface StageProgressItem {
  key: string;
  name: string;
  stage_type: string;
  sequence_number: number;
  status: string;
  item_count: number;
}

export interface CategoryCount {
  key: string;
  name: string;
  color_token: string;
  count: number;
}

export interface WorkshopSummary {
  counts: KindCount[];
  factors_by_category: CategoryCount[];
  stages: StageProgressItem[];
  awaiting_review: number;
  participants: number;
  health_score: number;
  health_signals: HealthSignal[];
  recent_activity: ActivityEvent[];
}

export const dashboardApi = {
  get: () => apiGet<Dashboard>("/dashboard"),
  workshopSummary: (workshopId: string) =>
    apiGet<WorkshopSummary>(`/workshops/${workshopId}/summary`),
};

/** Turns an audit action into something a person can read. */
export function describeActivity(e: ActivityEvent): string {
  const [object, verb] = e.action.split(".");
  const readable: Record<string, string> = {
    created: "added", updated: "edited", deleted: "removed",
    approved: "approved", rejected: "rejected", voted: "voted on",
    published: "published", versioned: "created a new version of",
    executed: "ran the assistant for", accepted: "accepted an AI suggestion for",
    edited: "accepted an edited AI suggestion for", failed: "had an AI request fail for",
    sections_updated: "reordered", section_edited: "edited a section of",
  };
  const label = (object ?? "item").replace(/_/g, " ");
  return `${readable[verb ?? ""] ?? verb ?? "changed"} ${label}`;
}

export const methodologiesApi = {
  list: () => apiGet<MethodologySummary[]>("/methodologies"),
};

export const workspacesApi = {
  list: () => apiGet<Workspace[]>("/workspaces"),
};

export const workshopsApi = {
  list: () => apiGet<Workshop[]>("/workshops"),
  get: (id: string) => apiGet<WorkshopDetail>(`/workshops/${id}`),
  activities: (id: string) => apiGet<Activity[]>(`/workshops/${id}/activities`),

  create: (input: {
    workspace_id: string;
    name: string;
    methodology_key: string;
    description?: string;
    objective?: string;
  }) => apiPost<{ id: string; status: string }>("/workshops", input),

  factors: (id: string, filters?: { category?: string; state?: FactorState }) => {
    const qs = new URLSearchParams();
    if (filters?.category) qs.set("category", filters.category);
    if (filters?.state) qs.set("state", filters.state);
    const suffix = qs.toString() ? `?${qs}` : "";
    return apiGet<Factor[]>(`/workshops/${id}/factors${suffix}`);
  },
  createFactor: (id: string, input: { category_key: string; title: string; description?: string }) =>
    apiPost<{ id: string }>(`/workshops/${id}/factors`, input),
  updateFactor: (id: string, factorId: string, input: { title?: string; description?: string }) =>
    apiPatch<{ id: string }>(`/workshops/${id}/factors/${factorId}`, input),
  deleteFactor: (id: string, factorId: string) =>
    apiDelete<{ id: string }>(`/workshops/${id}/factors/${factorId}`),
  reviewFactor: (id: string, factorId: string, input: { action: "approve" | "reject"; note?: string }) =>
    apiPost<{ id: string; state: FactorState }>(`/workshops/${id}/factors/${factorId}/review`, input),

  votes: (id: string) => apiGet<VoteSummary>(`/workshops/${id}/votes`),
  setVote: (id: string, factorId: string, value: number) =>
    apiPut<VoteSummary>(`/workshops/${id}/factors/${factorId}/vote`, { value }),
};
