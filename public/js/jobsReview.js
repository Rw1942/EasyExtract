import { state, ensureTemplatesLoaded } from './state.js';
import { api, toast, esc, STATUS_LABELS, renderSingleRun } from './shared.js';
import { showView, updateBreadcrumb } from './navigation.js';

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
    return `<tr><td><input type="checkbox" data-job-id="${j.id}" ${isChecked ? 'checked' : ''} onchange="toggleJobSelection('${j.id}', this.checked)"></td><td class="filename-cell" title="${esc(j.filename)}">${esc(j.filename)}</td><td><a onclick="event.stopPropagation(); openBucket('${j.bucket_id}')" style="color:var(--primary);cursor:pointer">${esc(j.bucket_name || '—')}</a></td><td>${j.page_count ?? '—'}</td><td><span class="status-badge status-${j.status}">${STATUS_LABELS[j.status] || j.status}</span></td><td>${esc(j.template_name || '—')}</td><td style="white-space:nowrap">${date}</td><td class="actions-cell"><button class="small" onclick="openReview('${j.id}')">Review</button>${(j.status === 'error' || j.status === 'done' || j.status === 'pending') ? `<button class="small primary" onclick="runExtraction('${j.id}', this)">Run</button>` : ''}</td></tr>`;
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
    document.getElementById('reviewSubtitle').textContent = `${job.bucket_name || 'Unknown bucket'} · ${STATUS_LABELS[job.status] || job.status}`;
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
