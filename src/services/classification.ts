import type { Env, TemplateField } from '../types';
import { type ResponsesApiResponse, extractOutputText } from './openaiTypes';

const CLASSIFICATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS job_classifications (
  job_id TEXT PRIMARY KEY,
  suggested_template_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  auto_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (suggested_template_id) REFERENCES templates(id)
)`;

const SETTINGS_DEFAULTS = {
  mode: 'hybrid' as ParsedSettings['mode'],
  autoRunThreshold: 0.86,
  escalationScore: 0.78,
  escalationMargin: 0.08,
};

const NANO_MODEL_PRIMARY = 'gpt-5.4-nano';
const NANO_MODEL_FALLBACK = 'gpt-5-nano';
const OCR_SNIPPET_LIMIT = 20000;

interface TemplateCandidate {
  id: string;
  name: string;
  doc_type_hint: string | null;
  summary: string;
}

interface ClassificationDecision {
  suggestedTemplateId: string;
  confidence: number;
  source: 'local' | 'openai';
  reason: string | null;
  autoRun: boolean;
}

interface ParsedSettings {
  mode: 'hybrid' | 'local_only' | 'openai_only';
  autoRunThreshold: number;
  escalationScore: number;
  escalationMargin: number;
}

interface LocalScore {
  templateId: string;
  score: number;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 2);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseSettingNumber(value: string | null | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadSettings(env: Env): Promise<ParsedSettings> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings
     WHERE key IN (?, ?, ?, ?)`,
  )
    .bind(
      'classification_mode',
      'classification_auto_run_threshold',
      'classification_openai_escalation_score',
      'classification_openai_escalation_margin',
    )
    .all<{ key: string; value: string }>();

  const settings = Object.fromEntries(results.map((row) => [row.key, row.value]));
  const modeRaw = (settings.classification_mode || SETTINGS_DEFAULTS.mode).toLowerCase();
  const mode = modeRaw === 'local_only' || modeRaw === 'openai_only' || modeRaw === 'hybrid'
    ? modeRaw
    : SETTINGS_DEFAULTS.mode;

  return {
    mode,
    autoRunThreshold: parseSettingNumber(settings.classification_auto_run_threshold, SETTINGS_DEFAULTS.autoRunThreshold),
    escalationScore: parseSettingNumber(settings.classification_openai_escalation_score, SETTINGS_DEFAULTS.escalationScore),
    escalationMargin: parseSettingNumber(settings.classification_openai_escalation_margin, SETTINGS_DEFAULTS.escalationMargin),
  };
}

async function loadCandidates(env: Env, bucketId: string): Promise<TemplateCandidate[]> {
  const bucketTemplate = await env.DB.prepare(
    `SELECT t.id, t.name, t.doc_type_hint
     FROM buckets b
     JOIN templates t ON t.id = b.template_id
     WHERE b.id = ?`,
  ).bind(bucketId).first<{ id: string; name: string; doc_type_hint: string | null }>();

  const { results: recentRuns } = await env.DB.prepare(
    `SELECT t.id, t.name, t.doc_type_hint, MAX(r.created_at) AS last_used_at
     FROM runs r
     JOIN templates t ON t.id = r.template_id
     GROUP BY t.id
     ORDER BY last_used_at DESC
     LIMIT 40`,
  ).all<{ id: string; name: string; doc_type_hint: string | null }>();

  const selected: Array<{ id: string; name: string; doc_type_hint: string | null }> = [];
  const seen = new Set<string>();

  if (bucketTemplate) {
    selected.push(bucketTemplate);
    seen.add(bucketTemplate.id);
  }

  for (const row of recentRuns) {
    if (seen.has(row.id)) continue;
    if (selected.length >= 11) break;
    selected.push(row);
    seen.add(row.id);
  }

  if (!selected.length) return [];

  const placeholders = selected.map(() => '?').join(', ');
  const fieldStmt = env.DB.prepare(
    `SELECT template_id, title, description
     FROM template_fields
     WHERE template_id IN (${placeholders})
     ORDER BY sort_order ASC`,
  ).bind(...selected.map((row) => row.id));

  const { results: fields } = await fieldStmt.all<Pick<TemplateField, 'template_id' | 'title' | 'description'>>();
  const fieldsByTemplate = new Map<string, string[]>();

  for (const field of fields) {
    const chunk = [field.title, field.description || ''].filter(Boolean).join(' - ');
    if (!chunk) continue;
    const list = fieldsByTemplate.get(field.template_id) ?? [];
    list.push(chunk);
    fieldsByTemplate.set(field.template_id, list);
  }

  return selected.map((tmpl) => {
    const summary = [
      tmpl.name,
      tmpl.doc_type_hint || '',
      ...(fieldsByTemplate.get(tmpl.id) ?? []),
    ].filter(Boolean).join(' | ');

    return {
      id: tmpl.id,
      name: tmpl.name,
      doc_type_hint: tmpl.doc_type_hint,
      summary,
    };
  });
}

function scoreLocal(docText: string, candidates: TemplateCandidate[]): LocalScore[] {
  const normalizedDoc = normalizeText(docText);
  const docTokens = tokenize(normalizedDoc);
  const docTokenSet = new Set(docTokens);

  const scores = candidates.map((candidate) => {
    const summaryNormalized = normalizeText(candidate.summary);
    const summaryTokens = tokenize(summaryNormalized);
    const summarySet = new Set(summaryTokens);

    let overlapCount = 0;
    for (const token of summarySet) {
      if (docTokenSet.has(token)) overlapCount += 1;
    }

    const precision = summarySet.size ? overlapCount / summarySet.size : 0;
    const recall = docTokenSet.size ? overlapCount / docTokenSet.size : 0;
    const nameHit = normalizedDoc.includes(normalizeText(candidate.name)) ? 1 : 0;
    const hintHit = candidate.doc_type_hint && normalizedDoc.includes(normalizeText(candidate.doc_type_hint)) ? 1 : 0;

    const score = clamp01((precision * 0.65) + (recall * 0.2) + (nameHit * 0.1) + (hintHit ? 0.05 : 0));
    return { templateId: candidate.id, score };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function buildOpenAIInstruction(candidates: TemplateCandidate[]): string {
  const lines = candidates.map((candidate, index) => {
    const summary = candidate.summary.slice(0, 500);
    return `${index + 1}. id=${candidate.id}; name=${candidate.name}; summary=${summary}`;
  }).join('\n');

  return [
    'Classify the document text to the best matching template id.',
    'Return exactly one template_id from the candidate list, plus confidence and brief reason.',
    'Use confidence in [0,1]. Choose higher confidence only if document evidence is strong.',
    '',
    'Candidates:',
    lines,
  ].join('\n');
}

async function selectModel(
  apiKey: string,
  instructions: string,
  input: string,
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const attempt = async (model: string): Promise<Response> => fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'template_classification',
          strict: true,
          schema,
        },
      },
      temperature: 0,
    }),
    signal,
  });

  const primary = await attempt(NANO_MODEL_PRIMARY);
  if (primary.ok) return primary;

  const fallback = await attempt(NANO_MODEL_FALLBACK);
  if (fallback.ok) return fallback;
  return primary;
}

async function classifyWithOpenAI(
  env: Env,
  filename: string,
  docText: string,
  candidates: TemplateCandidate[],
): Promise<{ templateId: string; confidence: number; reason: string | null } | null> {
  if (!env.OPENAI_API_KEY || !candidates.length) return null;

  const schema = {
    type: 'object',
    properties: {
      template_id: { type: 'string', enum: candidates.map((candidate) => candidate.id) },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['template_id', 'confidence', 'reason'],
    additionalProperties: false,
  };

  const instructions = buildOpenAIInstruction(candidates);
  const input = `Filename: ${filename}\n\nOCR Text:\n${docText.slice(0, OCR_SNIPPET_LIMIT)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await selectModel(env.OPENAI_API_KEY, instructions, input, schema, controller.signal);
    if (!res.ok) return null;

    const data = (await res.json()) as ResponsesApiResponse;
    const raw = extractOutputText(data);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { template_id?: string; confidence?: number; reason?: string };
    if (!parsed.template_id || !candidates.some((candidate) => candidate.id === parsed.template_id)) return null;

    return {
      templateId: parsed.template_id,
      confidence: clamp01(parsed.confidence ?? 0),
      reason: parsed.reason?.slice(0, 240) || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function saveClassification(env: Env, jobId: string, decision: ClassificationDecision): Promise<void> {
  await env.DB.prepare(CLASSIFICATION_TABLE_SQL).run();
  await env.DB.prepare(
    `INSERT INTO job_classifications (job_id, suggested_template_id, confidence, source, reason, auto_run, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(job_id) DO UPDATE SET
       suggested_template_id = excluded.suggested_template_id,
       confidence = excluded.confidence,
       source = excluded.source,
       reason = excluded.reason,
       auto_run = excluded.auto_run,
       updated_at = excluded.updated_at`,
  )
    .bind(
      jobId,
      decision.suggestedTemplateId,
      decision.confidence,
      decision.source,
      decision.reason,
      decision.autoRun ? 1 : 0,
    )
    .run();
}

export async function classifyJob(
  env: Env,
  args: { jobId: string; bucketId: string; ocrText: string; filename: string },
): Promise<ClassificationDecision | null> {
  const settings = await loadSettings(env);
  const candidates = await loadCandidates(env, args.bucketId);
  if (!candidates.length) return null;

  const localScores = scoreLocal(args.ocrText, candidates);
  const top = localScores[0];
  if (!top) return null;

  const second = localScores[1];
  const localDecision: ClassificationDecision = {
    suggestedTemplateId: top.templateId,
    confidence: clamp01(top.score),
    source: 'local',
    reason: 'Local text overlap match',
    autoRun: top.score >= settings.autoRunThreshold,
  };

  const shouldEscalate = settings.mode !== 'local_only'
    && (settings.mode === 'openai_only'
      || top.score < settings.escalationScore
      || ((top.score - (second?.score ?? 0)) < settings.escalationMargin));

  let finalDecision = localDecision;

  if (shouldEscalate) {
    const openAiDecision = await classifyWithOpenAI(env, args.filename, args.ocrText, candidates);
    if (openAiDecision) {
      finalDecision = {
        suggestedTemplateId: openAiDecision.templateId,
        confidence: openAiDecision.confidence,
        source: 'openai',
        reason: openAiDecision.reason,
        autoRun: openAiDecision.confidence >= settings.autoRunThreshold,
      };
    }
  }

  await saveClassification(env, args.jobId, finalDecision);
  return finalDecision;
}

export async function ensureJobClassificationTable(env: Env): Promise<void> {
  await env.DB.prepare(CLASSIFICATION_TABLE_SQL).run();
}
