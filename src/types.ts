export interface Env {
  DB: D1Database;
  GCP_SA_KEY: string;
  GCP_PROJECT_ID: string;
  OPENAI_API_KEY: string;
}

export interface Template {
  id: string;
  name: string;
  doc_type_hint: string | null;
  created_at: string;
}

export interface TemplateField {
  id: string;
  template_id: string;
  group_name: string | null;
  title: string;
  description: string | null;
  type: string;
  format_hint: string | null;
  required: number;
  sort_order: number;
}

export interface Bucket {
  id: string;
  name: string;
  settings: string | null;
  auto_route_rules: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  bucket_id: string;
  filename: string;
  status: string;
  ocr_text: string | null;
  page_count: number | null;
  created_at: string;
}

export interface Run {
  id: string;
  job_id: string;
  template_id: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: Record<string, unknown>;
}

export function ok<T>(data: T, meta?: Record<string, unknown>): Response {
  const body: ApiResponse<T> = { ok: true, data, meta };
  return Response.json(body);
}

export function err(status: number, code: string, message: string, details?: unknown): Response {
  const body: ApiResponse = { ok: false, error: { code, message, details } };
  return Response.json(body, { status });
}

export function uid(): string {
  return crypto.randomUUID();
}
