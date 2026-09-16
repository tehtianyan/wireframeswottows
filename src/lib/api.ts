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

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return request<T>(path, init);
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
  state: string;
  votes: number;
  created_at: string;
}

export const workshopsApi = {
  list: () => apiGet<Workshop[]>("/workshops"),
  get: (id: string) => apiGet<WorkshopDetail>(`/workshops/${id}`),
  activities: (id: string) => apiGet<Activity[]>(`/workshops/${id}/activities`),
  factors: (id: string, categoryKey?: string) =>
    apiGet<Factor[]>(`/workshops/${id}/factors${categoryKey ? `?category=${categoryKey}` : ""}`),
  createFactor: (id: string, input: { category_key: string; title: string; description?: string }) =>
    apiPost<{ id: string }>(`/workshops/${id}/factors`, input),
};
