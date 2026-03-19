// Job extraction — runs OCR text through OpenAI to fill a template's fields.
import type { Env, Job, Template, TemplateField } from '../types';
import { ok, err, uid } from '../types';
import { extract } from '../services/openai';

async function ensureJobPreviewTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS job_previews (
      job_id TEXT PRIMARY KEY,
      preview_page TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`,
  ).run();
}

export async function handleExtract(req: Request, env: Env, jobId: string): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return err(503, 'NOT_CONFIGURED', 'OpenAI is not configured. Add OPENAI_API_KEY with Wrangler secrets.');
  }

  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<Job>();
  if (!job) return err(404, 'NOT_FOUND', 'Job not found');
  if (!job.ocr_text) return err(400, 'NO_OCR_TEXT', 'Job has no OCR text yet — upload pages first');

  const body = (await req.json().catch(() => ({}))) as { template_id?: string };

  // Use explicit template_id or fall back to the bucket's template
  let templateId = body.template_id;
  if (!templateId) {
    const bucket = await env.DB.prepare('SELECT template_id FROM buckets WHERE id = ?').bind(job.bucket_id).first<{ template_id: string }>();
    templateId = bucket?.template_id;
  }
  if (!templateId) return err(400, 'VALIDATION', 'No template_id provided and bucket has none');

  const template = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first<Template>();
  if (!template) return err(404, 'NOT_FOUND', 'Template not found');

  const { results: fields } = await env.DB.prepare(
    'SELECT * FROM template_fields WHERE template_id = ? ORDER BY sort_order',
  )
    .bind(templateId)
    .all<TemplateField>();

  if (!fields.length) return err(400, 'NO_FIELDS', 'Template has no fields defined');

  const runId = uid();
  await env.DB.prepare('INSERT INTO runs (id, job_id, template_id, status) VALUES (?, ?, ?, ?)')
    .bind(runId, jobId, templateId, 'running')
    .run();

  await env.DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('extracting', jobId).run();

  const promptSetting = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind('extraction_prompt').first<{ value: string }>();

  try {
    const result = await extract(job.ocr_text, fields, env.OPENAI_API_KEY, template.doc_type_hint, promptSetting?.value);

    await env.DB.prepare('UPDATE runs SET status = ?, result = ? WHERE id = ?')
      .bind('done', JSON.stringify(result), runId)
      .run();
    await env.DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('done', jobId).run();

    return ok({ run_id: runId, result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Extraction failed';
    await env.DB.prepare('UPDATE runs SET status = ?, error = ? WHERE id = ?')
      .bind('error', msg, runId)
      .run();
    await env.DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('error', jobId).run();

    return err(502, 'EXTRACTION_FAILED', msg);
  }
}

export async function handleGetJob(env: Env, jobId: string): Promise<Response> {
  await ensureJobPreviewTable(env);

  const job = await env.DB.prepare(
    `SELECT j.*, b.name as bucket_name, b.template_id as bucket_template_id,
            t.name as bucket_template_name, p.preview_page
     FROM jobs j
     LEFT JOIN buckets b ON j.bucket_id = b.id
     LEFT JOIN templates t ON b.template_id = t.id
     LEFT JOIN job_previews p ON p.job_id = j.id
     WHERE j.id = ?`,
  ).bind(jobId).first<Job & Record<string, unknown>>();
  if (!job) return err(404, 'NOT_FOUND', 'Job not found');

  const { results: runs } = await env.DB.prepare(
    `SELECT r.*, t.name as template_name
     FROM runs r LEFT JOIN templates t ON r.template_id = t.id
     WHERE r.job_id = ? ORDER BY r.created_at DESC`,
  )
    .bind(jobId)
    .all();

  const parsed = runs.map((r: Record<string, unknown>) => ({
    ...r,
    result: r.result ? JSON.parse(r.result as string) : null,
  }));

  return ok({ ...job, runs: parsed });
}

/** List all jobs across buckets — supports ?status= and ?search= filters. */
export async function handleListJobs(env: Env, url: URL): Promise<Response> {
  await ensureJobPreviewTable(env);

  const status = url.searchParams.get('status');
  const search = url.searchParams.get('search');
  const bucketId = url.searchParams.get('bucket_id');
  const templateId = url.searchParams.get('template_id');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let sql = [
    'SELECT j.*, b.name as bucket_name, b.template_id as template_id, t.name as template_name,',
    'CASE WHEN p.job_id IS NULL THEN 0 ELSE 1 END AS has_preview',
    'FROM jobs j',
    'LEFT JOIN buckets b ON j.bucket_id = b.id',
    'LEFT JOIN templates t ON b.template_id = t.id',
    'LEFT JOIN job_previews p ON p.job_id = j.id',
  ].join(' ');
  const conditions: string[] = [];
  const binds: string[] = [];

  if (status) { conditions.push('j.status = ?'); binds.push(status); }
  if (search) { conditions.push('j.filename LIKE ?'); binds.push(`%${search}%`); }
  if (bucketId) { conditions.push('j.bucket_id = ?'); binds.push(bucketId); }
  if (templateId) { conditions.push('b.template_id = ?'); binds.push(templateId); }
  if (from) { conditions.push('j.created_at >= ?'); binds.push(from); }
  if (to) { conditions.push('j.created_at <= ?'); binds.push(to); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY j.created_at DESC LIMIT 200';

  let stmt = env.DB.prepare(sql);
  for (const b of binds) stmt = stmt.bind(b);
  const { results } = await stmt.all();

  return ok(results);
}

export async function handleDeleteJob(env: Env, jobId: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(jobId).run();
  return ok({ deleted: true });
}
