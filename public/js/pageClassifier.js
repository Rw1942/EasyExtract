// Browser-side page classifier for OCR text.
// Deterministic and dependency-free so it can run in the main thread or a Web Worker.

const PAGE_BREAK_MARKER = '\n\n--- Page Break ---\n\n';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'had',
  'into', 'onto', 'your', 'their', 'there', 'here', 'than', 'then', 'when', 'where', 'which', 'while',
  'will', 'shall', 'would', 'could', 'should', 'about', 'above', 'below', 'under', 'over', 'between',
  'after', 'before', 'during', 'each', 'every', 'other', 'some', 'such', 'also', 'only', 'more', 'most',
  'very', 'much', 'many', 'any', 'all', 'our', 'out', 'off', 'not', 'but', 'can', 'you', 'its', 'it',
]);

let templateCacheKey = null;
let templateCacheModel = null;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function toTermFreq(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

function charNgrams(text, n = 3) {
  const normalized = normalizeText(text).replace(/\s+/g, '');
  const grams = new Set();
  if (normalized.length < n) return grams;
  for (let i = 0; i <= normalized.length - n; i += 1) {
    grams.add(normalized.slice(i, i + n));
  }
  return grams;
}

function dotProduct(mapA, mapB) {
  let sum = 0;
  const [small, large] = mapA.size <= mapB.size ? [mapA, mapB] : [mapB, mapA];
  for (const [token, value] of small) {
    sum += value * (large.get(token) || 0);
  }
  return sum;
}

function vectorNorm(map) {
  let sumSquares = 0;
  for (const value of map.values()) sumSquares += value * value;
  return Math.sqrt(sumSquares);
}

function cosineSimilarity(mapA, mapB) {
  const denom = vectorNorm(mapA) * vectorNorm(mapB);
  if (!denom) return 0;
  return dotProduct(mapA, mapB) / denom;
}

function setIntersectionCount(setA, setB) {
  let count = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const item of small) {
    if (large.has(item)) count += 1;
  }
  return count;
}

function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  const intersection = setIntersectionCount(setA, setB);
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

function buildTemplateText(template) {
  const fields = Array.isArray(template.fields) ? template.fields : [];
  const fieldText = fields
    .map((field) => {
      const requirement = field.required ? 'required' : 'optional';
      return [
        field.group_name ? `group ${field.group_name}` : '',
        field.title,
        field.description,
        field.type ? `type ${field.type}` : '',
        field.format_hint ? `format ${field.format_hint}` : '',
        requirement,
      ].filter(Boolean).join(' ');
    })
    .join(' ');

  return [template.name, template.doc_type_hint, fieldText]
    .filter(Boolean)
    .join(' ');
}

function buildTemplateCacheKey(templates) {
  return templates
    .map((template) => {
      const fields = Array.isArray(template.fields) ? template.fields : [];
      const fieldSig = fields.map((f) => (
        [
          f.group_name || '',
          f.title || '',
          f.description || '',
          f.type || '',
          f.format_hint || '',
          Number(f.required) ? '1' : '0',
        ].join(':')
      )).join('|');
      return `${template.id}:${template.name || ''}:${template.doc_type_hint || ''}:${fieldSig}`;
    })
    .join('||');
}

function buildTemplateModel(templates) {
  const key = buildTemplateCacheKey(templates);
  if (templateCacheKey === key && templateCacheModel) return templateCacheModel;

  const drafts = templates.map((template) => {
    const text = buildTemplateText(template);
    const tokens = tokenize(text);
    return {
      id: template.id,
      name: template.name || 'Template',
      tokens,
      tokenSet: new Set(tokens),
      tf: toTermFreq(tokens),
      trigramSet: charNgrams(text),
    };
  });

  const docFreq = new Map();
  for (const draft of drafts) {
    for (const token of draft.tokenSet) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  const totalTemplates = Math.max(1, drafts.length);
  const idf = new Map();
  for (const [token, df] of docFreq) {
    idf.set(token, Math.log((1 + totalTemplates) / (1 + df)) + 1);
  }

  const model = drafts.map((draft) => {
    const tfidf = new Map();
    for (const [token, count] of draft.tf) {
      tfidf.set(token, count * (idf.get(token) || 0));
    }

    const anchorTerms = [...draft.tf.entries()]
      .filter(([token]) => token.length >= 5)
      .map(([token, count]) => ({ token, weight: count * (idf.get(token) || 0) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 8)
      .map((item) => item.token);

    return {
      id: draft.id,
      name: draft.name,
      tokenSet: draft.tokenSet,
      trigramSet: draft.trigramSet,
      tfidf,
      anchorTerms,
    };
  });

  templateCacheKey = key;
  templateCacheModel = { model, idf };
  return templateCacheModel;
}

function buildPageVector(tokens, idf) {
  const tf = toTermFreq(tokens);
  const vector = new Map();
  for (const [token, count] of tf) {
    vector.set(token, count * (idf.get(token) || 0));
  }
  return vector;
}

function scorePage(pageText, templateStats, idf) {
  const tokens = tokenize(pageText);
  const pageTokenSet = new Set(tokens);
  const pageVector = buildPageVector(tokens, idf);
  const pageTrigrams = charNgrams(pageText);

  const scored = templateStats.map((template) => {
    const overlapBase = template.tokenSet.size
      ? setIntersectionCount(pageTokenSet, template.tokenSet) / template.tokenSet.size
      : 0;
    const cosine = cosineSimilarity(pageVector, template.tfidf);
    const trigramScore = jaccard(pageTrigrams, template.trigramSet);

    const anchorHitCount = template.anchorTerms.reduce(
      (sum, term) => sum + (pageTokenSet.has(term) ? 1 : 0),
      0,
    );
    const anchorScore = template.anchorTerms.length ? anchorHitCount / template.anchorTerms.length : 0;

    const score = (overlapBase * 0.55) + (cosine * 0.25) + (trigramScore * 0.15) + (anchorScore * 0.05);
    return {
      templateId: template.id,
      templateName: template.name,
      score,
    };
  }).sort((a, b) => b.score - a.score);

  return scored;
}

function smoothPageLabels(results) {
  if (results.length < 2) return results;

  const smoothed = results.map((result) => ({ ...result }));

  for (let i = 0; i < smoothed.length; i += 1) {
    const current = smoothed[i];
    if (current.status === 'confident') continue;

    const prev = smoothed[i - 1] || null;
    const next = smoothed[i + 1] || null;

    if (prev && next && prev.status === 'confident' && next.status === 'confident' && prev.template_id === next.template_id) {
      current.template_id = prev.template_id;
      current.template_name = prev.template_name;
      current.status = 'smoothed';
      current.reason = 'Adjusted based on neighboring pages.';
      current.confidence = Math.max(current.confidence, Math.min(prev.confidence, next.confidence) * 0.9);
      continue;
    }

    if (!prev && next && next.status === 'confident') {
      current.template_id = next.template_id;
      current.template_name = next.template_name;
      current.status = 'smoothed';
      current.reason = 'Adjusted using next page context.';
      current.confidence = Math.max(current.confidence, next.confidence * 0.85);
      continue;
    }

    if (!next && prev && prev.status === 'confident') {
      current.template_id = prev.template_id;
      current.template_name = prev.template_name;
      current.status = 'smoothed';
      current.reason = 'Adjusted using previous page context.';
      current.confidence = Math.max(current.confidence, prev.confidence * 0.85);
    }
  }

  return smoothed;
}

function buildSummary(smoothed, templateCount) {
  const totals = new Map();
  let confidentPages = 0;
  let uncertainPages = 0;
  let confidenceSum = 0;

  for (const result of smoothed) {
    confidenceSum += result.confidence || 0;

    if (result.status === 'confident' || result.status === 'smoothed') {
      confidentPages += 1;
      const key = result.template_name || 'Unknown';
      totals.set(key, (totals.get(key) || 0) + 1);
    } else {
      uncertainPages += 1;
    }
  }

  return {
    total_pages: smoothed.length,
    confident_pages: confidentPages,
    uncertain_pages: uncertainPages,
    average_confidence: smoothed.length ? confidenceSum / smoothed.length : 0,
    template_count: templateCount,
    by_template: [...totals.entries()]
      .map(([template_name, count]) => ({ template_name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function splitOcrPages(ocrText) {
  return String(ocrText || '')
    .split(PAGE_BREAK_MARKER)
    .map((text) => text.trim())
    .filter(Boolean);
}

export function classifyOcrPagesDetailed(ocrText, templates, options = {}, onProgress) {
  const pages = splitOcrPages(ocrText);
  if (!pages.length || !Array.isArray(templates) || !templates.length) {
    return {
      pages: [],
      summary: { total_pages: 0, confident_pages: 0, uncertain_pages: 0, average_confidence: 0, template_count: 0, by_template: [] },
      meta: { scored_templates: Array.isArray(templates) ? templates.length : 0 },
    };
  }

  const highThreshold = Number.isFinite(options.highThreshold) ? options.highThreshold : 0.78;
  const marginThreshold = Number.isFinite(options.marginThreshold) ? options.marginThreshold : 0.08;
  const candidateCount = Number.isFinite(options.candidateCount) ? Math.max(1, Math.floor(options.candidateCount)) : 3;

  const { model, idf } = buildTemplateModel(templates);

  const rawResults = [];
  for (let index = 0; index < pages.length; index += 1) {
    const pageText = pages[index];
    const ranked = scorePage(pageText, model, idf);
    const best = ranked[0];
    const second = ranked[1] || { score: 0 };
    const margin = best ? (best.score - second.score) : 0;
    const confident = !!best && best.score >= highThreshold && margin >= marginThreshold;

    const topCandidates = ranked.slice(0, candidateCount).map((entry) => ({
      template_id: entry.templateId,
      template_name: entry.templateName,
      confidence: Math.max(0, Math.min(1, entry.score)),
    }));

    rawResults.push({
      page_number: index + 1,
      template_id: best?.templateId || null,
      template_name: best?.templateName || null,
      confidence: Math.max(0, Math.min(1, best?.score || 0)),
      margin: Math.max(0, margin),
      status: confident ? 'confident' : 'uncertain',
      reason: confident ? 'Strong match' : 'Low confidence or close tie',
      candidates: topCandidates,
    });

    onProgress?.({
      phase: 'classifying',
      processed_pages: index + 1,
      total_pages: pages.length,
    });
  }

  const smoothed = smoothPageLabels(rawResults);
  const summary = buildSummary(smoothed, templates.length);

  return {
    pages: smoothed,
    summary,
    meta: {
      scored_templates: templates.length,
      high_threshold: highThreshold,
      margin_threshold: marginThreshold,
      candidate_count: candidateCount,
    },
  };
}

export function classifyOcrPages(ocrText, templates, options = {}) {
  return classifyOcrPagesDetailed(ocrText, templates, options);
}
