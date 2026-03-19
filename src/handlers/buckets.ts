// Bucket CRUD — each bucket groups documents of one type, processed with a shared template.
import type { Env, Bucket, Job } from '../types';
import { ok, err, uid } from '../types';

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
    `SELECT b.*, t.name as template_name,
      (SELECT COUNT(*) FROM jobs WHERE bucket_id = b.id) as job_count
     FROM buckets b LEFT JOIN templates t ON b.template_id = t.id
     ORDER BY b.created_at DESC`,
  ).all();
  return ok(results);
}

async function getBucket(env: Env, id: string): Promise<Response> {
  const bucket = await env.DB.prepare(
    `SELECT b.*, t.name as template_name
     FROM buckets b LEFT JOIN templates t ON b.template_id = t.id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first<Bucket & { template_name: string }>();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const { results: jobs } = await env.DB.prepare(
    'SELECT * FROM jobs WHERE bucket_id = ? ORDER BY created_at DESC',
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
    template_id: string;
    settings?: Record<string, unknown>;
    auto_route_rules?: Array<{ keyword: string; bucket_name: string }>;
  };

  if (!body.name || !body.template_id) return err(400, 'VALIDATION', 'name and template_id are required');

  const tmpl = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(body.template_id).first();
  if (!tmpl) return err(400, 'VALIDATION', 'Template not found');

  const id = uid();
  await env.DB.prepare('INSERT INTO buckets (id, name, template_id, settings, auto_route_rules) VALUES (?, ?, ?, ?, ?)')
    .bind(id, body.name, body.template_id, body.settings ? JSON.stringify(body.settings) : null, body.auto_route_rules ? JSON.stringify(body.auto_route_rules) : null)
    .run();

  return ok({ id });
}

async function updateBucket(req: Request, env: Env, id: string): Promise<Response> {
  const bucket = await env.DB.prepare('SELECT id FROM buckets WHERE id = ?').bind(id).first();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const body = (await req.json()) as { template_id?: string; name?: string };
  if (!body.template_id && !body.name) return err(400, 'VALIDATION', 'template_id or name is required');

  if (body.name) {
    await env.DB.prepare('UPDATE buckets SET name = ? WHERE id = ?').bind(body.name, id).run();
  }

  if (body.template_id) {
    const tmpl = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(body.template_id).first();
    if (!tmpl) return err(400, 'VALIDATION', 'Template not found');
    await env.DB.prepare('UPDATE buckets SET template_id = ? WHERE id = ?').bind(body.template_id, id).run();
  }

  return ok({ updated: true });
}

async function deleteBucket(env: Env, id: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM buckets WHERE id = ?').bind(id).run();
  return ok({ deleted: true });
}
