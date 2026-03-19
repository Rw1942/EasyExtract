// Settings CRUD — stores per-user overrides for prompts and OCR tuning.
import type { Env } from '../types';
import { ok, err } from '../types';
import { EXTRACTION_PROMPT_DEFAULT, BUILDER_PROMPT_DEFAULT } from '../prompts';

export const DEFAULT_SETTINGS: Record<string, string> = {
  extraction_prompt: EXTRACTION_PROMPT_DEFAULT,
  template_builder_prompt: BUILDER_PROMPT_DEFAULT,
  ocr_batch_size: '16',
  classification_mode: 'hybrid',
  classification_auto_run_threshold: '0.86',
  classification_openai_escalation_score: '0.78',
  classification_openai_escalation_margin: '0.08',
};

export async function handleSettings(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT key, value FROM settings',
    ).all<{ key: string; value: string }>();
    const stored = Object.fromEntries(results.map(r => [r.key, r.value]));
    return ok({ ...DEFAULT_SETTINGS, ...stored });
  }

  if (req.method === 'PUT') {
    const body = (await req.json()) as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      if (key in DEFAULT_SETTINGS && typeof value === 'string') {
        await env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).bind(key, value).run();
      }
    }
    return ok({ saved: true });
  }

  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}
