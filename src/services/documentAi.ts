// Google Cloud Vision OCR service — batches page images and returns concatenated document text.
import { getAccessToken } from './auth';
import type { Env } from '../types';

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const BATCH_LIMIT = 16;

interface VisionResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    error?: { code?: number; message?: string; status?: string };
  }>;
}

export async function ocrPages(
  pages: string[],
  env: Env,
): Promise<{ text: string; pageCount: number }> {
  const token = await getAccessToken(env.GCP_SA_KEY);
  const texts: string[] = [];

  for (let i = 0; i < pages.length; i += BATCH_LIMIT) {
    const batch = pages.slice(i, i + BATCH_LIMIT);
    const batchTexts = await ocrBatch(batch, token, env.GCP_PROJECT_ID);
    texts.push(...batchTexts);
  }

  return {
    text: texts.join('\n\n--- Page Break ---\n\n'),
    pageCount: pages.length,
  };
}

async function ocrBatch(
  pages: string[],
  token: string,
  projectId: string,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'x-goog-user-project': projectId,
      },
      body: JSON.stringify({
        requests: pages.map((b64) => ({
          image: { content: b64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        })),
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('UPSTREAM_AUTH_FAILED'), { status: 502 });
    }
    if (res.status === 400) {
      const detail = await res.text();
      throw Object.assign(new Error('INVALID_DOCUMENT: ' + detail), { status: 400 });
    }
    if (res.status === 429) {
      throw Object.assign(new Error('UPSTREAM_RATE_LIMITED'), { status: 503 });
    }
    if (!res.ok) {
      throw Object.assign(new Error('UPSTREAM_ERROR: ' + res.status), { status: 502 });
    }

    const body = (await res.json()) as VisionResponse;
    return (body.responses ?? []).map((r, i) => {
      if (r.error) {
        throw Object.assign(
          new Error(`Vision API error on page ${i + 1}: [${r.error.status ?? r.error.code}] ${r.error.message}`),
          { status: 502 },
        );
      }
      return r.fullTextAnnotation?.text ?? '';
    });
  } finally {
    clearTimeout(timeout);
  }
}
