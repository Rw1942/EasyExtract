import { state, ensureTemplatesLoaded } from './state.js';
import { api, toast, esc, STATUS_LABELS, renderSingleRun } from './shared.js';
import { showView, updateBreadcrumb } from './navigation.js';
import { classifyPagesInWorker } from './pageClassifierWorkerClient.js';

function classificationCacheKey(job, sourceText) {
  return `${job.id}:${sourceText.length}:${job.status}:${job.runs?.length || 0}`;
}

function renderClassificationProgress(stateView) {
  const total = Number(stateView.totalPages) || 0;
  const done = Number(stateView.donePages) || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const caption = stateView.caption || 'Preparing browser classifier...';

  return `<div class="page-class-progress"><div class="page-class-progress-top"><span class="page-class-label">${esc(caption)}</span><span class="page-class-pct">${pct}%</span></div><div class="page-class-bar"><div class="page-class-bar-fill" style="width:${pct}%"></div></div><div class="page-class-sub">${done}/${total || '?'} pages processed</div></div>`;
}

function renderCandidateHints(row) {
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  if (candidates.length < 2) return '';

  const alternatives = candidates
    .slice(1, 3)
    .map((candidate) => `${esc(candidate.template_name)} ${Math.round((candidate.confidence || 0) * 100)}%`)
    .join(' · ');

  if (!alternatives) return '';
  return `<div class="page-class-alts">Also considered: ${alternatives}</div>`;
}

function renderPageClassificationCard(report) {
  if (!report || !report.pages?.length) {
    return '<p class="page-class-empty">No page-level OCR content available for browser classification.</p>';
  }

  const summary = report.summary || {};
  const meta = report.meta || {};
  const byTemplate = Array.isArray(summary.by_template) ? summary.by_template : [];
  const avgPct = Math.round((Number(summary.average_confidence) || 0) * 100);

  const chips = byTemplate.length
    ? byTemplate.map((row) => `<span class="page-class-chip">${esc(row.template_name)}: ${row.count}</span>`).join('')
    : '<span class="page-class-chip">No confident labels yet</span>';

  const rows = report.pages.map((row) => {
    const pct = Math.round((Number(row.confidence) || 0) * 100);
    return `<tr><td>${row.page_number}</td><td><div>${esc(row.template_name || 'Uncertain')}</div>${renderCandidateHints(row)}</td><td>${pct}%</td><td><span class="page-class-status page-class-status-${row.status}">${esc(row.status)}</span></td></tr>`;
  }).join('');

  return `<div class="page-class-summary"><span>${summary.confident_pages || 0}/${summary.total_pages || 0} confident</span><span>${summary.uncertain_pages || 0} uncertain</span><span>${avgPct}% avg confidence</span><span>${summary.template_count || meta.scored_templates || 0} templates compared</span><span>${meta.duration_ms || 0}ms</span></div><div class="page-class-chip-row">${chips}</div><div class="page-class-table-wrap"><table class="page-class-table"><thead><tr><th>Page</th><th>Template</th><th>Confidence</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function loadTemplatesForPageClassification() {
  const templates = await ensureTemplatesLoaded(api);
  const detailed = await Promise.all(templates.map(async (template) => {
    if (!state.templateDetailCache[template.id]) {
      state.templateDetailCache[template.id] = await api(`/templates/${template.id}`);
    }
    return state.templateDetailCache[template.id];
  }));

  return detailed
    .filter((template) => Array.isArray(template.fields) && template.fields.length > 0)
    .map((template) => ({
      id: template.id,
      name: template.name,
      doc_type_hint: template.doc_type_hint,
      fields: template.fields.map((field) => ({
        title: field.title,
        description: field.description,
        type: field.type,
      })),
    }));
}

async function renderReviewPageClassification(job) {
  const panel = document.getElementById('reviewPageClassification');
  if (!panel) return;

  const sourceText = (job.ocr_text || '').trim();
  if (!sourceText) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;
  panel.innerHTML = renderClassificationProgress({
    caption: 'Loading templates for page classification...',
    donePages: 0,
    totalPages: 0,
  });

  try {
    const cacheKey = classificationCacheKey(job, sourceText);
    if (!state.pageClassificationCache[cacheKey]) {
      const templates = await loadTemplatesForPageClassification();
      panel.innerHTML = renderClassificationProgress({
        caption: `Classifying ${sourceText.split('\n\n--- Page Break ---\n\n').length} pages in browser...`,
        donePages: 0,
        totalPages: sourceText.split('\n\n--- Page Break ---\n\n').filter(Boolean).length,
      });

      state.pageClassificationCache[cacheKey] = await classifyPagesInWorker(
        {
          ocrText: sourceText,
          templates,
          options: {
            highThreshold: 0.78,
            marginThreshold: 0.08,
            candidateCount: 3,
          },
        },
        (progress) => {
          panel.innerHTML = renderClassificationProgress({
            caption: 'Classifying pages in browser...',
            donePages: progress.processed_pages || 0,
            totalPages: progress.total_pages || 0,
          });
        },
      );
    }

    panel.innerHTML = renderPageClassificationCard(state.pageClassificationCache[cacheKey]);
  } catch {
    panel.innerHTML = '<p class="page-class-empty">Could not classify pages in browser.</p>';
  }
}

export async function showJobs() {
  if (state.navStack[state.navStack.length - 1] !== 'jobs') state.navStack.push('jobs');
  showView('viewJobs');
  updateBreadcrumb([{ label: 'Jobs' }]);

  try {
    const [jobs, buckets, templates] = await Promise.all([
      api('/jobs'),
      api('/buckets'),
      ensureTemplatesLoaded(api),
    ]);
    state.jobsCache = jobs;
    state.selectedJobIds.clear();
    renderJobsFilters(buckets, templates);
    renderJobsIndex(state.jobsCache);
    const refreshBtn = document.getElementById('jobsRefreshToggle');
    if (refreshBtn) refreshBtn.textContent = state.jobsRefreshPaused ? 'Resume Refresh' : 'Pause Refresh';
    scheduleJobsRefresh();
  } catch (e) {
    toast('Failed to load jobs: ' + e.message);
  }
}

function scheduleJobsRefresh() {
  if (state.jobsRefreshTimer) clearTimeout(state.jobsRefreshTimer);
  if (state.jobsRefreshPaused) return;
  state.jobsRefreshTimer = setTimeout(async () => {
    const activeView = document.querySelector('.view:not([hidden])')?.id;
    if (activeView !== 'viewJobs' || state.jobsRefreshPaused) return;
    try {
      state.jobsCache = await api('/jobs');
      filterJobs();
      scheduleJobsRefresh();
    } catch {
      scheduleJobsRefresh();
    }
  }, 10000);
}

export function toggleJobsRefresh() {
  state.jobsRefreshPaused = !state.jobsRefreshPaused;
  const btn = document.getElementById('jobsRefreshToggle');
  if (btn) btn.textContent = state.jobsRefreshPaused ? 'Resume Refresh' : 'Pause Refresh';
  if (!state.jobsRefreshPaused) scheduleJobsRefresh();
}

function renderJobsFilters(buckets, templates) {
  const bucketFilter = document.getElementById('jobsBucketFilter');
  const templateFilter = document.getElementById('jobsTemplateFilter');
  bucketFilter.innerHTML = `<option value="">All buckets</option>${buckets.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}`;
  templateFilter.innerHTML = `<option value="">All templates</option>${templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}`;
  document.getElementById('jobsSearchInput').value = '';
  document.getElementById('jobsStatusFilter').value = '';
  document.getElementById('jobsFromDate').value = '';
  document.getElementById('jobsToDate').value = '';
}

export function filterJobs() {
  if (!state.jobsCache) return;
  const search = document.getElementById('jobsSearchInput').value.trim().toLowerCase();
  const status = document.getElementById('jobsStatusFilter').value;
  const bucketId = document.getElementById('jobsBucketFilter').value;
  const templateId = document.getElementById('jobsTemplateFilter').value;
  const fromDate = document.getElementById('jobsFromDate').value;
  const toDate = document.getElementById('jobsToDate').value;

  const filtered = state.jobsCache.filter((j) => {
    if (search && !j.filename.toLowerCase().includes(search)) return false;
    if (status && j.status !== status) return false;
    if (bucketId && j.bucket_id !== bucketId) return false;
    if (templateId && j.template_id !== templateId) return false;
    const created = new Date(j.created_at);
    if (fromDate && created < new Date(`${fromDate}T00:00:00`)) return false;
    if (toDate && created > new Date(`${toDate}T23:59:59`)) return false;
    return true;
  });

  renderJobsIndex(filtered);
}

function renderJobsIndex(jobs) {
  const tbody = document.getElementById('jobsIndexBody');
  const empty = document.getElementById('noJobsIndexMessage');
  const selectAll = document.getElementById('jobsSelectAll');

  if (!jobs.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    selectAll.checked = false;
    return;
  }
  empty.hidden = true;

  tbody.innerHTML = jobs.map((j) => {
    const date = new Date(j.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const isChecked = state.selectedJobIds.has(j.id);
    const suggested = j.suggested_template_name
      ? `<div class="template-suggestion">Suggested: ${esc(j.suggested_template_name)} (${Math.round((Number(j.classification_confidence) || 0) * 100)}%)</div>`
      : '';
    const autoExtractBadge = Number(j.classification_auto_run) && j.status === 'done'
      ? '<span class="meta-badge meta-badge-success">Auto-extracted</span>'
      : '';
    return `<tr><td><input type="checkbox" data-job-id="${j.id}" ${isChecked ? 'checked' : ''} onchange="toggleJobSelection('${j.id}', this.checked)"></td><td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td><td><a class="table-link" onclick="event.stopPropagation(); openBucket('${j.bucket_id}')">${esc(j.bucket_name || '—')}</a></td><td>${j.page_count ?? '—'}</td><td><span class="status-badge status-${j.status}">${STATUS_LABELS[j.status] || j.status}</span>${autoExtractBadge}</td><td>${esc(j.template_name || '—')}${suggested}</td><td class="date-cell">${date}</td><td class="actions-cell"><button class="small" onclick="openReview('${j.id}')">Review</button>${(j.status === 'error' || j.status === 'done' || j.status === 'pending') ? `<button class="small primary" onclick="runExtraction('${j.id}', this)">Run</button>` : ''}</td></tr>`;
  }).join('');

  selectAll.checked = jobs.every((j) => state.selectedJobIds.has(j.id));
}

export function toggleJobSelection(jobId, checked) {
  if (checked) state.selectedJobIds.add(jobId);
  else state.selectedJobIds.delete(jobId);
}

export function toggleAllJobsSelection(checked) {
  document.querySelectorAll('#jobsIndexBody input[type="checkbox"]').forEach((el) => {
    el.checked = checked;
    const jobId = el.dataset.jobId;
    if (!jobId) return;
    if (checked) state.selectedJobIds.add(jobId);
    else state.selectedJobIds.delete(jobId);
  });
}

export async function reExtractSelectedFailed() {
  if (!state.selectedJobIds.size) {
    toast('Select one or more jobs first.', 2500, 'info');
    return;
  }
  const selectedJobs = (state.jobsCache || []).filter((j) => state.selectedJobIds.has(j.id) && j.status === 'error');
  if (!selectedJobs.length) {
    toast('No failed jobs selected.', 2500, 'info');
    return;
  }

  let success = 0;
  for (const job of selectedJobs) {
    try {
      await api(`/jobs/${job.id}/extract`, { method: 'POST' });
      success += 1;
    } catch {
      // no-op
    }
  }
  toast(`Re-ran ${success} of ${selectedJobs.length} failed jobs.`, 3000, 'success');
  await showJobs();
}

export function exportSelectedJobsCsv() {
  if (!state.selectedJobIds.size) {
    toast('Select one or more jobs first.', 2500, 'info');
    return;
  }
  const rows = (state.jobsCache || []).filter((j) => state.selectedJobIds.has(j.id));
  const csv = [
    ['job_id', 'filename', 'bucket', 'status', 'template', 'pages', 'created_at'],
    ...rows.map((j) => [j.id, j.filename, j.bucket_name || '', j.status, j.template_name || '', String(j.page_count ?? ''), j.created_at]),
  ];
  const blob = new Blob([csv.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `easyextract-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function openReview(jobId, isBack = false) {
  if (!isBack) state.navStack.push(`review:${jobId}`);
  showView('viewReview');

  try {
    const job = await api(`/jobs/${jobId}`);
    document.getElementById('reviewTitle').textContent = job.filename || 'Review';
    const subtitleBits = [`${job.bucket_name || 'Unknown bucket'}`, `${STATUS_LABELS[job.status] || job.status}`];
    if (Number(job.classification_auto_run) && job.status === 'done') subtitleBits.push('Auto-extracted');
    document.getElementById('reviewSubtitle').textContent = subtitleBits.join(' · ');
    updateBreadcrumb([{ label: 'Jobs', action: 'showJobs()' }, { label: 'Review' }]);

    const previewWrap = document.getElementById('reviewPreviewWrap');
    const ocrText = document.getElementById('reviewOcrText');
    const runsWrap = document.getElementById('reviewRuns');
    const toggleBtn = document.getElementById('toggleOcrBtn');

    const preview = typeof job.preview_page === 'string' ? job.preview_page : '';
    previewWrap.innerHTML = preview ? `<img class="review-preview-image" alt="Document preview page" src="data:image/jpeg;base64,${preview}">` : '<div class="review-empty">No image preview available for this upload.</div>';

    const sourceText = (job.ocr_text || '').trim();
    ocrText.textContent = sourceText || 'No OCR text available.';
    ocrText.hidden = true;
    previewWrap.hidden = false;
    toggleBtn.textContent = 'Show OCR Text';
    await renderReviewPageClassification(job);

    const runs = job.runs || [];
    if (!runs.length) {
      runsWrap.innerHTML = '<div class="detail-empty">No extraction runs yet for this job.</div>';
      return;
    }

    if (runs.length === 1) {
      runsWrap.innerHTML = renderSingleRun(runs[0]);
      return;
    }

    const tabs = runs.map((run, i) => {
      const label = run.template_name || 'Template';
      const date = new Date(run.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<button class="run-tab${i === 0 ? ' active' : ''}" onclick="switchRunTab(this, ${i})" data-run-idx="${i}">${esc(label)} (${date})</button>`;
    }).join('');
    const panels = runs.map((run, i) => `<div class="run-panel${i === 0 ? ' active' : ''}" data-run-idx="${i}">${renderSingleRun(run)}</div>`).join('');
    runsWrap.innerHTML = `<div class="run-tabs">${tabs}</div>${panels}`;
  } catch (e) {
    toast('Failed to load review: ' + e.message);
  }
}

export function toggleReviewOcr() {
  const previewWrap = document.getElementById('reviewPreviewWrap');
  const ocrText = document.getElementById('reviewOcrText');
  const toggleBtn = document.getElementById('toggleOcrBtn');
  const showOcr = ocrText.hidden;
  ocrText.hidden = !showOcr;
  previewWrap.hidden = showOcr;
  toggleBtn.textContent = showOcr ? 'Show Preview' : 'Show OCR Text';
}

export function exposeJobsReviewActions() {
  return {
    showJobs,
    filterJobs,
    toggleJobSelection,
    toggleAllJobsSelection,
    reExtractSelectedFailed,
    exportSelectedJobsCsv,
    toggleJobsRefresh,
    openReview,
    toggleReviewOcr,
  };
}
