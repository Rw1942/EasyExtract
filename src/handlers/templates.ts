// Template CRUD — templates define the fields to extract from a document type.
import type { Env, Template, TemplateField } from '../types';
import { ok, err, uid } from '../types';

export async function handleTemplates(req: Request, env: Env, path: string): Promise<Response> {
  const segments = path.replace('/api/templates', '').split('/').filter(Boolean);
  const id = segments[0];

  if (req.method === 'GET' && !id) return listTemplates(env);
  if (req.method === 'GET' && id) return getTemplate(env, id);
  if (req.method === 'POST' && !id) return createTemplate(req, env);
  if (req.method === 'PUT' && id) return updateTemplate(req, env, id);
  if (req.method === 'DELETE' && id) return deleteTemplate(env, id);

  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}

async function listTemplates(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM templates ORDER BY created_at DESC').all<Template>();
  return ok(results);
}

async function getTemplate(env: Env, id: string): Promise<Response> {
  const template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first<Template>();
  if (!template) return err(404, 'NOT_FOUND', 'Template not found');

  const { results: fields } = await env.DB.prepare(
    'SELECT * FROM template_fields WHERE template_id = ? ORDER BY sort_order',
  )
    .bind(id)
    .all<TemplateField>();

  // Buckets that have historically used this template in extraction runs
  const { results: buckets_using } = await env.DB.prepare(
    `SELECT b.id, b.name, COUNT(*) as run_count, MAX(r.created_at) as last_used_at
     FROM runs r
     JOIN jobs j ON j.id = r.job_id
     JOIN buckets b ON b.id = j.bucket_id
     WHERE r.template_id = ?
     GROUP BY b.id, b.name
     ORDER BY run_count DESC, last_used_at DESC
     LIMIT 20`,
  ).bind(id).all();

  // Recent extraction runs using this template (last 20)
  const { results: recent_runs } = await env.DB.prepare(
    `SELECT r.id, r.status, r.created_at, j.filename, b.name as bucket_name
     FROM runs r
     LEFT JOIN jobs j ON r.job_id = j.id
     LEFT JOIN buckets b ON j.bucket_id = b.id
     WHERE r.template_id = ?
     ORDER BY r.created_at DESC LIMIT 20`,
  ).bind(id).all();

  return ok({ ...template, fields, buckets_using, recent_runs });
}

async function createTemplate(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    name: string;
    doc_type_hint?: string;
    fields?: Array<Omit<TemplateField, 'id' | 'template_id'>>;
  };

  if (!body.name) return err(400, 'VALIDATION', 'name is required');

  const id = uid();
  await env.DB.prepare('INSERT INTO templates (id, name, doc_type_hint) VALUES (?, ?, ?)')
    .bind(id, body.name, body.doc_type_hint ?? null)
    .run();

  if (body.fields?.length) {
    const stmt = env.DB.prepare(
      'INSERT INTO template_fields (id, template_id, group_name, title, description, type, format_hint, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const batch = body.fields.map((f, i) =>
      stmt.bind(uid(), id, f.group_name ?? null, f.title, f.description ?? null, f.type ?? 'string', f.format_hint ?? null, f.required ? 1 : 0, f.sort_order ?? i),
    );
    await env.DB.batch(batch);
  }

  return ok({ id });
}

async function updateTemplate(req: Request, env: Env, id: string): Promise<Response> {
  const body = (await req.json()) as {
    name?: string;
    doc_type_hint?: string;
    fields?: Array<Omit<TemplateField, 'id' | 'template_id'>>;
  };

  const existing = await env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(id).first();
  if (!existing) return err(404, 'NOT_FOUND', 'Template not found');

  if (body.name) {
    await env.DB.prepare('UPDATE templates SET name = ?, doc_type_hint = ? WHERE id = ?')
      .bind(body.name, body.doc_type_hint ?? null, id)
      .run();
  }

  if (body.fields) {
    await env.DB.prepare('DELETE FROM template_fields WHERE template_id = ?').bind(id).run();
    if (body.fields.length) {
      const stmt = env.DB.prepare(
        'INSERT INTO template_fields (id, template_id, group_name, title, description, type, format_hint, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const batch = body.fields.map((f, i) =>
        stmt.bind(uid(), id, f.group_name ?? null, f.title, f.description ?? null, f.type ?? 'string', f.format_hint ?? null, f.required ? 1 : 0, f.sort_order ?? i),
      );
      await env.DB.batch(batch);
    }
  }

  return ok({ id });
}

async function deleteTemplate(env: Env, id: string): Promise<Response> {
  try {
    await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
    return ok({ deleted: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.toLowerCase().includes('foreign key')) {
      return err(409, 'TEMPLATE_IN_USE', 'Template cannot be deleted because it is referenced by existing runs or classifications.');
    }
    throw e;
  }
}
