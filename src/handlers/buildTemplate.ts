// AI-assisted template builder — generates extraction field schemas from a plain-text description.
import type { Env } from '../types';
import { ok, err } from '../types';
import { BUILDER_PROMPT_DEFAULT } from '../prompts';
import { type ResponsesApiResponse, extractOutputText } from '../services/openaiTypes';

interface BuildRequest {
  description: string;
  pages?: string[];
}

interface GeneratedTemplate {
  name: string;
  doc_type_hint: string;
  fields: Array<{
    title: string;
    description: string;
    type: string;
    required: boolean;
  }>;
}

const TEMPLATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short template name (3–5 words)' },
    doc_type_hint: { type: 'string', description: 'One-line description of the document type' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise field name (2–4 words)' },
          description: { type: 'string', description: 'What this field represents and where to find it' },
          type: {
            type: 'string',
            enum: ['string', 'number', 'currency', 'date', 'object', 'array'],
            description: 'Use "currency" for ANY monetary value (revenue, income, profit, cost, balance, fee, price, total, tax, payment, salary, asset, liability, etc.). Use "number" only for non-monetary numerics (count, percentage, quantity, ratio). When unsure, prefer "currency" over "number".',
          },
          required: { type: 'boolean' },
        },
        required: ['title', 'description', 'type', 'required'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'doc_type_hint', 'fields'],
  additionalProperties: false,
};

export async function handleBuildTemplate(req: Request, env: Env): Promise<Response> {
  if (!env.OPENAI_API_KEY) {
    return err(503, 'NOT_CONFIGURED', 'OpenAI is not configured. Add OPENAI_API_KEY with Wrangler secrets.');
  }

  const body = (await req.json()) as BuildRequest;
  if (!body.description?.trim()) {
    return err(400, 'VALIDATION', 'description is required');
  }

  const pages = (body.pages ?? []).slice(0, 3);

  const promptSetting = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind('template_builder_prompt').first<{ value: string }>();

  const instructions = promptSetting?.value || BUILDER_PROMPT_DEFAULT;

  const messageContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: pages.length > 0
        ? `Description: ${body.description.trim()}\n\nI've also attached ${pages.length} sample page(s) from a document of this type to help you understand its layout and content.`
        : `Description: ${body.description.trim()}`,
    },
    ...pages.map(page => ({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${page}`,
    })),
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        instructions,
        input: [{ type: 'message', role: 'user', content: messageContent }],
        text: {
          format: {
            type: 'json_schema',
            name: 'template_schema',
            strict: true,
            schema: TEMPLATE_SCHEMA,
          },
        },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      return err(502, 'OPENAI_ERROR', `OpenAI error (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as ResponsesApiResponse;
    const raw = extractOutputText(data);

    if (!raw) {
      return err(502, 'EMPTY_RESPONSE', 'AI returned no output — the model may not support this request format');
    }

    const template = JSON.parse(raw) as GeneratedTemplate;

    if (!template.name || !Array.isArray(template.fields)) {
      return err(502, 'INVALID_RESPONSE', 'AI returned an unexpected response structure');
    }

    return ok(template);
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      return err(502, 'INVALID_JSON', 'AI returned malformed JSON');
    }
    const msg = e instanceof Error ? e.message : 'Template generation failed';
    return err(502, 'BUILD_FAILED', msg);
  } finally {
    clearTimeout(timeout);
  }
}
