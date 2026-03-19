// Bucket CRUD — buckets group related documents for upload, review, and extraction workflows.
import type { Env, Bucket, Job } from '../types';
import { ok, err, uid } from '../types';
import { ensureJobClassificationTable } from '../services/classification';

export async function handleBuckets(req: Request, env: Env, path: string): Promise<Response> {
  const segments = path.replace('/api/buckets', '').split('/').filter(Boolean);
  const id = segments[0];

  if (req.method === 'GET' && !id) return listBuckets(env);
  if (req.method === 'GET' && id) return getBucket(env, id);
  if (req.method === 'POST' && !id) return createBucket(req, env);
  if (req.method === 'PATCH' && id) return updateBucket(req, env, id);
  if (req.method === 'DELETE' && id) return deleteBucket(env, id);

  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

async function listBuckets(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT b.*,
      (SELECT COUNT(*) FROM jobs WHERE bucket_id = b.id) as job_count
     FROM buckets b
     ORDER BY b.created_at DESC`,
  ).all();
  return ok(results);
}

async function getBucket(env: Env, id: string): Promise<Response> {
  await ensureJobClassificationTable(env);

  const bucket = await env.DB.prepare(
    `SELECT * FROM buckets WHERE id = ?`,
  )
    .bind(id)
    .first<Bucket>();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const { results: jobs } = await env.DB.prepare(
    `SELECT j.*,
       jc.suggested_template_id,
       st.name as suggested_template_name,
       jc.confidence as classification_confidence,
       jc.source as classification_source,
       jc.reason as classification_reason,
       jc.auto_run as classification_auto_run
     FROM jobs j
     LEFT JOIN job_classifications jc ON jc.job_id = j.id
     LEFT JOIN templates st ON st.id = jc.suggested_template_id
     WHERE j.bucket_id = ? ORDER BY j.created_at DESC`,
  )
    .bind(id)
    .all<Job>();

  // Aggregated job stats for the bucket header
  const stats = await env.DB.prepare(
    `SELECT COUNT(*) as total,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_count,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
       SUM(CASE WHEN status = 'ocr' THEN 1 ELSE 0 END) as ocr_count
     FROM jobs WHERE bucket_id = ?`,
  ).bind(id).first();

  return ok({ ...bucket, jobs, stats });
}

async function createBucket(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    name: string;
    template_id?: string;
    settings?: Record<string, unknown>;
    auto_route_rules?: Array<{ keyword: string; bucket_name: string }>;
  };

  if (!body.name || !body.name.trim()) return err(400, 'VALIDATION', 'name is required');
  if (body.template_id) return err(400, 'VALIDATION', 'template_id is no longer supported on buckets');

  const id = uid();
  await env.DB.prepare('INSERT INTO buckets (id, name, settings, auto_route_rules) VALUES (?, ?, ?, ?)')
    .bind(id, body.name.trim(), body.settings ? JSON.stringify(body.settings) : null, body.auto_route_rules ? JSON.stringify(body.auto_route_rules) : null)
    .run();

  return ok({ id });
}

async function updateBucket(req: Request, env: Env, id: string): Promise<Response> {
  const bucket = await env.DB.prepare('SELECT id FROM buckets WHERE id = ?').bind(id).first();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const body = (await req.json()) as {
    template_id?: string;
    name?: string;
    settings?: Record<string, unknown> | null;
    auto_route_rules?: Array<{ keyword: string; bucket_name: string }> | null;
  };
  if (Object.prototype.hasOwnProperty.call(body, 'template_id')) {
    return err(400, 'VALIDATION', 'template_id is no longer supported on buckets');
  }

  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasSettings = Object.prototype.hasOwnProperty.call(body, 'settings');
  const hasRules = Object.prototype.hasOwnProperty.call(body, 'auto_route_rules');
  if (!hasName && !hasSettings && !hasRules) {
    return err(400, 'VALIDATION', 'name, settings, or auto_route_rules is required');
  }
  if (hasName && (!body.name || !body.name.trim())) {
    return err(400, 'VALIDATION', 'name must be a non-empty string');
  }

  const updates: string[] = [];
  const binds: Array<string | null> = [];

  if (hasName) {
    updates.push('name = ?');
    binds.push(body.name!.trim());
  }
  if (hasSettings) {
    updates.push('settings = ?');
    binds.push(body.settings ? JSON.stringify(body.settings) : null);
  }
  if (hasRules) {
    updates.push('auto_route_rules = ?');
    binds.push(body.auto_route_rules ? JSON.stringify(body.auto_route_rules) : null);
  }

  await env.DB.prepare(`UPDATE buckets SET ${updates.join(', ')} WHERE id = ?`).bind(...binds, id).run();

  return ok({ updated: true });
}

async function deleteBucket(env: Env, id: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM buckets WHERE id = ?').bind(id).run();
  return ok({ deleted: true });
}
