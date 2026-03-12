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

  return ok({ ...template, fields });
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
  await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  return ok({ deleted: true });
}
