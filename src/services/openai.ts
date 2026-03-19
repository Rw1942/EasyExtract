// OpenAI extraction service — converts OCR text into structured data using the Responses API.
import type { TemplateField } from '../types';
import { EXTRACTION_PROMPT_DEFAULT } from '../prompts';
import { type ResponsesApiResponse, extractOutputText } from './openaiTypes';

const EXTRACTION_TIMEOUT_MS = 95_000;

function mapScalarType(type: string): string {
  return type === 'number' ? 'number' : 'string';
}

const CURRENCY_OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    amount:   { type: 'number' },
    currency: { type: 'string' },
  },
  required: ['amount', 'currency'],
  additionalProperties: false,
} as const;

/**
 * Build an OpenAI json_schema block for the given fields.
 *
 * object/array fields are typed as proper JSON types (not string), which
 * requires strict mode to be disabled — strict: true only supports schemas
 * with additionalProperties: false throughout, incompatible with free-form
 * nested objects.  When all fields are scalars/currency we keep strict: true.
 */
function buildJsonSchema(fields: TemplateField[]): { schema: Record<string, unknown>; strict: boolean } {
  const hasComplexType = fields.some(f => f.type === 'object' || f.type === 'array');
  const properties: Record<string, unknown> = {};

  for (const f of fields) {
    const desc = f.description ? { description: f.description } : {};

    if (f.type === 'currency') {
      properties[f.title] = f.required
        ? { ...CURRENCY_OBJECT_SCHEMA, ...desc }
        : { anyOf: [{ type: 'null' }, CURRENCY_OBJECT_SCHEMA], ...desc };
    } else if (f.type === 'object') {
      properties[f.title] = f.required
        ? { type: 'object', ...desc }
        : { anyOf: [{ type: 'null' }, { type: 'object' }], ...desc };
    } else if (f.type === 'array') {
      properties[f.title] = f.required
        ? { type: 'array', items: {}, ...desc }
        : { anyOf: [{ type: 'null' }, { type: 'array', items: {} }], ...desc };
    } else {
      const baseType = mapScalarType(f.type);
      properties[f.title] = {
        type: f.required ? baseType : [baseType, 'null'],
        ...desc,
      };
    }
  }

  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    required: fields.map(f => f.title),
  };

  if (!hasComplexType) {
    // strict mode requires additionalProperties: false everywhere
    schema.additionalProperties = false;
  }

  return { schema, strict: !hasComplexType };
}

function buildSystemPrompt(
  fields: TemplateField[],
  docTypeHint?: string | null,
  promptTemplate?: string | null,
): string {
  const fieldSpecs = fields.map((f) => {
    let line = `- "${f.title}" (type: ${f.type}${f.required ? ', required' : ''})`;
    if (f.description) line += `: ${f.description}`;
    if (f.format_hint) line += ` [format: ${f.format_hint}]`;
    return line;
  }).join('\n');

  const template = promptTemplate || EXTRACTION_PROMPT_DEFAULT;
  const fieldsBlock = `Fields:\n${fieldSpecs}`;

  let prompt = template.includes('{{fields}}')
    ? template.replace('{{fields}}', fieldsBlock)
    : `${template}\n\n${fieldsBlock}`;

  if (docTypeHint) {
    prompt = `The document is likely: ${docTypeHint}.\n\n${prompt}`;
  }

  return prompt;
}

export async function extract(
  ocrText: string,
  fields: TemplateField[],
  apiKey: string,
  docTypeHint?: string | null,
  promptOverride?: string | null,
): Promise<Record<string, unknown>> {
  const systemPrompt = buildSystemPrompt(fields, docTypeHint, promptOverride);
  const { schema, strict } = buildJsonSchema(fields);

  const controller = new AbortController();
  // Financial templates with many array/object fields can exceed 60s on Responses API.
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        instructions: systemPrompt,
        input: ocrText,
        text: {
          format: {
            type: 'json_schema',
            name: 'extraction_result',
            strict,
            schema,
          },
        },
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`OpenAI error (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as ResponsesApiResponse;
    const raw = extractOutputText(data);
    if (!raw) throw new Error('Responses API returned no output text');
    return JSON.parse(raw);
  } finally {
    clearTimeout(timeout);
  }
}
