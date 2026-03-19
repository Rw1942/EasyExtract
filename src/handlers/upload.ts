// Upload handler — accepts base64 JPEG pages, runs OCR via Google Cloud Vision, stores result.
import type { Env } from '../types';
import { ok, err, uid } from '../types';
import { ocrPages } from '../services/documentAi';

const OCR_BATCH_SIZE_DEFAULT = 16;
const OCR_BATCH_SIZE_MAX = 16;

function normalizeBatchSize(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return OCR_BATCH_SIZE_DEFAULT;
  return Math.min(OCR_BATCH_SIZE_MAX, parsed);
}

async function getOcrBatchSize(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind('ocr_batch_size')
    .first<{ value: string }>();
  return normalizeBatchSize(row?.value);
}

async function processOcrInBackground(
  env: Env,
  jobId: string,
  pages: string[],
  batchSize: number,
): Promise<void> {
  try {
    const { text } = await ocrPages(pages, env, batchSize);

    await env.DB.prepare('UPDATE jobs SET status = ?, ocr_text = ? WHERE id = ?')
      .bind('pending', text, jobId)
      .run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'OCR failed';
    console.error(`OCR job failed: ${jobId}: ${msg}`);
    await env.DB.prepare('UPDATE jobs SET status = ? WHERE id = ?').bind('error', jobId).run();
  }
}

export async function handleUpload(
  req: Request,
  env: Env,
  bucketId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.GCP_SA_KEY || !env.GCP_PROJECT_ID) {
    return err(503, 'NOT_CONFIGURED', 'Google Cloud Vision is not configured. Add GCP_SA_KEY and GCP_PROJECT_ID to your .dev.vars file.');
  }

  const bucket = await env.DB.prepare('SELECT id FROM buckets WHERE id = ?').bind(bucketId).first();
  if (!bucket) return err(404, 'NOT_FOUND', 'Bucket not found');

  const body = (await req.json()) as { filename: string; pages: string[] };

  if (!body.filename || !body.pages?.length || !Array.isArray(body.pages)) {
    return err(400, 'VALIDATION', 'filename and pages[] (base64 JPEG) are required');
  }

  const jobId = uid();
  const batchSize = await getOcrBatchSize(env);
  await env.DB.prepare('INSERT INTO jobs (id, bucket_id, filename, status, page_count) VALUES (?, ?, ?, ?, ?)')
    .bind(jobId, bucketId, body.filename, 'ocr', body.pages.length)
    .run();

  ctx.waitUntil(
    processOcrInBackground(env, jobId, body.pages, batchSize),
  );

  return ok({
    job_id: jobId,
    page_count: body.pages.length,
    status: 'ocr',
    queued: true,
    ocr_batch_size: batchSize,
  });
}
