// Upload handler — accepts base64 JPEG pages, runs OCR via Google Cloud Vision, stores result.
import type { Env } from '../types';
import { ok, err, uid } from '../types';
import { ocrPages } from '../services/documentAi';

export async function handleUpload(req: Request, env: Env, bucketId: string): Promise<Response> {
  if (!env.GCP_SA_KEY || !env.GCP_PROJECT_ID) {
    return err(503, 'NOT_CONFIGURED', 'Google Cloud Vision is not configured. Add GCP_SA_KEY and GCP_PROJECT_ID to your .dev.vars file.');
  }

  const bucket = await env.DB.prepare('SELECT id FROM buckets WHERE id = ?').bind(bucketId).first();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const body = (await req.json()) as { filename: string; pages: string[] };

  if (!body.filename || !body.pages?.length) {
    return err(400, 'VALIDATION', 'filename and pages[] (base64 JPEG) are required');
  }

  const jobId = uid();
  await env.DB.prepare('INSERT INTO jobs (id, bucket_id, filename, status, page_count) VALUES (?, ?, ?, ?, ?)')
    .bind(jobId, bucketId, body.filename, 'ocr', body.pages.length)
    .run();

  try {
    const { text } = await ocrPages(body.pages, env);

    await env.DB.prepare('UPDATE jobs SET status = ?, ocr_text = ? WHERE id = ?')
      .bind('pending', text, jobId)
      .run();

    return ok({ job_id: jobId, page_count: body.pages.length, ocr_length: text.length });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'OCR failed';
    const status = (e as { status?: number }).status ?? 502;

    await env.DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('error', jobId).run();

    return err(status, 'OCR_FAILED', msg);
  }
}
