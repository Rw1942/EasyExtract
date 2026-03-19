import { state, ensureTemplatesLoaded } from './state.js';
import { api, toast, esc, debugLog, STATUS_LABELS, renderSingleRun, switchRunTab } from './shared.js';
import { showView, updateBreadcrumb } from './navigation.js';
import { seedStarterTemplates } from './templates.js';

let pdfjsLibPromise;
async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';
      return mod;
    });
  }
  return pdfjsLibPromise;
}

function getDashboardEmptyMarkup() {
  return `
    <h3>Welcome to EasyExtract</h3>
    <p>Turn any PDF into structured, usable data — in seconds, not hours. Here's how:</p>
    <div class="onboarding-steps">
      <div class="onboarding-step"><div class="step-num">1</div><h4>Create a Template</h4><p>Tell AI what data you need — revenue, dates, account numbers, line items — anything.</p></div>
      <div class="onboarding-step"><div class="step-num">2</div><h4>Create a Bucket</h4><p>Group similar documents together, like "Q4 Reports" or "Loan Applications."</p></div>
      <div class="onboarding-step"><div class="step-num">3</div><h4>Upload &amp; Extract</h4><p>Drop your PDFs in and AI instantly reads and extracts your data — ready to export.</p></div>
    </div>
    <button class="primary" onclick="showTemplateList()">Get Started</button>
  `;
}

export async function showDashboard() {
  showView('viewDashboard');
  updateBreadcrumb([{ label: 'Buckets' }]);

  try {
    const buckets = await api('/buckets');
    const grid = document.getElementById('bucketGrid');
    const empty = document.getElementById('noBuckets');

    if (!buckets.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = getDashboardEmptyMarkup();
      await seedStarterTemplates();
      return;
    }

    empty.hidden = true;
    grid.innerHTML = buckets.map((b) => {
      const count = b.job_count || 0;
      return `<div class="card" onclick="openBucket('${b.id}')"><h3>${esc(b.name)}</h3><div style="margin-bottom:10px"><span class="template-tag">${esc(b.template_name || 'No template')}</span></div><div class="card-stat-row"><span class="card-stat-label">Documents</span><span class="card-stat-value">${count}</span></div><div class="card-actions"><button class="small primary" onclick="event.stopPropagation(); quickUpload('${b.id}')">Upload</button><button class="small" onclick="event.stopPropagation(); openBucket('${b.id}')">Open</button><button class="small danger" onclick="event.stopPropagation(); deleteBucket('${b.id}')">Delete</button></div></div>`;
    }).join('');
  } catch (e) {
    toast('Failed to load buckets: ' + e.message);
  }
}

export async function openBucket(id, isBack) {
  if (!isBack) state.navStack.push('bucket:' + id);
  showView('viewBucket');

  try {
    const data = await api(`/buckets/${id}`);
    state.currentBucket = data;
    document.getElementById('bucketName').textContent = data.name;
    document.getElementById('uploadZone').hidden = true;
    updateBreadcrumb([{ label: 'Buckets', action: 'goHome()' }, { label: data.name }]);

    renderBucketInfoBar(data);
    document.getElementById('reExtractPanel').hidden = true;

    await renderJobsTable(data.jobs || []);

    const inProgress = (data.jobs || []).some((j) => j.status === 'ocr' || j.status === 'extracting');
    state.pollingBucketId = inProgress ? data.id : null;
    if (inProgress) schedulePolling(data.id);
  } catch (e) {
    toast('Failed to load bucket: ' + e.message);
  }
}

function schedulePolling(bucketId) {
  setTimeout(async () => {
    if (state.pollingBucketId !== bucketId) return;
    await openBucket(bucketId, true);
  }, 4000);
}

export function renderBucketInfoBar(data) {
  const infoBar = document.getElementById('bucketInfoBar');
  if (!data.template_name && !data.template_id) { infoBar.hidden = true; return; }
  infoBar.hidden = false;

  const s = data.stats || {};
  const statParts = [];
  if (s.done_count) statParts.push(`<span class="stat-done">${s.done_count} extracted</span>`);
  if (s.pending_count) statParts.push(`<span class="stat-pending">${s.pending_count} ready</span>`);
  if (s.ocr_count) statParts.push(`<span class="stat-ocr">${s.ocr_count} processing</span>`);
  if (s.error_count) statParts.push(`<span class="stat-error">${s.error_count} failed</span>`);
  const statsHtml = statParts.length ? `<div class="bucket-stats">${s.total || 0} document${s.total !== 1 ? 's' : ''}: ${statParts.join(' · ')}</div>` : '';

  infoBar.innerHTML = `<div style="flex:1"><span>Template: <strong>${esc(data.template_name || data.template_id)}</strong></span>${statsHtml}</div><div class="info-bar-actions"><a onclick="editTemplate('${data.template_id}')">Edit Fields</a><button class="small" onclick="changeBucketTemplate()">Change</button></div>`;

  const reBtn = document.getElementById('btnReExtractAll');
  if (reBtn) reBtn.hidden = !(s.done_count || s.error_count);
}

export async function changeBucketTemplate() {
  const infoBar = document.getElementById('bucketInfoBar');
  infoBar.innerHTML = `<span class="info-bar-loading">Loading templates…</span>`;

  let templates;
  try {
    templates = await ensureTemplatesLoaded(api);
  } catch (e) {
    toast('Failed to load templates: ' + e.message);
    renderBucketInfoBar(state.currentBucket);
    return;
  }

  if (!templates.length) {
    toast('No templates yet — create one to get started.');
    renderBucketInfoBar(state.currentBucket);
    return;
  }

  const options = templates.map((t) => `<option value="${t.id}"${t.id === state.currentBucket.template_id ? ' selected' : ''}>${esc(t.name)}</option>`).join('');

  infoBar.innerHTML = `<span>Template:</span><select id="bucketTemplateChanger">${options}</select><div class="info-bar-actions"><button class="small ai-btn" onclick="openBuilderFromBucket()">+ New template</button><button class="small primary" onclick="applyBucketTemplate()">Apply</button><button class="small" onclick="cancelBucketTemplateChange()">Cancel</button></div>`;
}

export async function applyBucketTemplate() {
  const select = document.getElementById('bucketTemplateChanger');
  const newTemplateId = select.value;
  const newTemplateName = select.options[select.selectedIndex].text;

  if (newTemplateId === state.currentBucket.template_id) {
    renderBucketInfoBar(state.currentBucket);
    return;
  }

  const applyBtn = select.closest('.bucket-info-bar').querySelector('button.primary');
  applyBtn.disabled = true;
  applyBtn.textContent = 'Saving…';

  try {
    await api(`/buckets/${state.currentBucket.id}`, { method: 'PATCH', body: JSON.stringify({ template_id: newTemplateId }) });
    state.currentBucket.template_id = newTemplateId;
    state.currentBucket.template_name = newTemplateName;
    renderBucketInfoBar(state.currentBucket);
    toast(`Template updated to "${newTemplateName}" — new extractions will use this template`, 5000, 'success');
  } catch (e) {
    toast('Failed to update template: ' + e.message);
    renderBucketInfoBar(state.currentBucket);
  }
}

export function cancelBucketTemplateChange() {
  renderBucketInfoBar(state.currentBucket);
}

export function openBuilderFromBucket() {
  const savedBucketId = state.currentBucket.id;
  state.afterTemplateSaved = async (templateId) => {
    await openBucket(savedBucketId, true);
    await changeBucketTemplate();
    const sel = document.getElementById('bucketTemplateChanger');
    if (sel) sel.value = templateId;
  };
  window.showTemplateBuilder();
}

async function renderJobsTable(jobs) {
  state.expandedJobId = null;
  const tbody = document.getElementById('jobsBody');
  const empty = document.getElementById('noJobs');
  const exportBtn = document.getElementById('btnExportCsv');
  if (!jobs.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    document.getElementById('uploadZone').hidden = false;
    if (exportBtn) exportBtn.hidden = true;
    return;
  }
  empty.hidden = true;
  const hasDone = jobs.some((j) => j.status === 'done');
  if (exportBtn) exportBtn.hidden = !hasDone;

  const templates = await ensureTemplatesLoaded(api);
  const defaultTmplId = state.currentBucket?.template_id;

  tbody.innerHTML = jobs.map((j) => {
    const expandable = j.status === 'done' || j.status === 'error';
    const canExtract = j.status === 'pending' || j.status === 'done' || j.status === 'error';
    let actions = '';
    if (canExtract) {
      const opts = templates.map((t) => `<option value="${t.id}"${t.id === defaultTmplId ? ' selected' : ''}>${esc(t.name)}${t.id === defaultTmplId ? ' (default)' : ''}</option>`).join('');
      const selectHtml = `<select class="template-select" id="tmpl-select-${j.id}" onclick="event.stopPropagation()" title="Choose extraction template">${opts}</select>`;
      if (j.status === 'pending') actions = `${selectHtml}<button class="small primary" onclick="event.stopPropagation(); runExtraction('${j.id}', this)">Extract</button>`;
      else actions = `${selectHtml}<button class="small" onclick="event.stopPropagation(); reRunExtraction('${j.id}', this)">Re-extract</button><button class="small" onclick="event.stopPropagation(); openReview('${j.id}')">Review</button><button class="small danger" onclick="event.stopPropagation(); deleteJob('${j.id}')">Delete</button>`;
    }
    return `<tr class="job-row${expandable ? ' expandable' : ''}" ${expandable ? `onclick="toggleJobDetail('${j.id}')" data-job-id="${j.id}"` : ''}><td class="filename-cell" title="${esc(j.filename)}"><span class="job-chevron" id="chevron-${j.id}">${expandable ? '▸' : ''}</span>${esc(j.filename)}</td><td>${j.page_count ?? '—'}</td><td><span class="status-badge status-${j.status}">${STATUS_LABELS[j.status] || j.status}</span></td><td class="actions-cell">${actions}</td></tr><tr class="job-detail-row" id="detail-${j.id}"><td colspan="4" class="job-detail-cell"><div class="job-detail-wrap" id="wrap-${j.id}"><div class="job-detail-inner" id="inner-${j.id}"></div></div></td></tr>`;
  }).join('');
}

export async function toggleJobDetail(jobId) {
  const wrap = document.getElementById(`wrap-${jobId}`);
  const inner = document.getElementById(`inner-${jobId}`);
  const chevron = document.getElementById(`chevron-${jobId}`);
  if (!wrap) return;

  const isOpen = wrap.classList.contains('open');

  if (state.expandedJobId && state.expandedJobId !== jobId) {
    document.getElementById(`wrap-${state.expandedJobId}`)?.classList.remove('open');
    const prevChevron = document.getElementById(`chevron-${state.expandedJobId}`);
    if (prevChevron) prevChevron.textContent = '▸';
  }

  if (isOpen) {
    wrap.classList.remove('open');
    chevron.textContent = '▸';
    state.expandedJobId = null;
    return;
  }

  inner.innerHTML = `<div class="detail-loading"><span class="detail-spinner"></span> Loading results…</div>`;
  wrap.classList.add('open');
  chevron.textContent = '▾';
  state.expandedJobId = jobId;

  if (!state.jobDetailCache[jobId]) {
    try {
      state.jobDetailCache[jobId] = await api(`/jobs/${jobId}`);
    } catch (e) {
      inner.innerHTML = `<div class="detail-error-box"><strong>Couldn't load results</strong><p>${esc(e.message)}</p></div>`;
      return;
    }
  }

  inner.innerHTML = renderJobDetail(state.jobDetailCache[jobId]);
}

function renderJobDetail(jobData) {
  const runs = jobData.runs || [];
  if (!runs.length) return `<div class="detail-empty">No data extracted yet — click Extract to get started.</div>`;
  if (runs.length === 1) return renderSingleRun(runs[0]);

  const tabs = runs.map((run, i) => {
    const label = run.template_name || 'Unknown template';
    const date = new Date(run.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<button class="run-tab${i === 0 ? ' active' : ''}" onclick="switchRunTab(this, ${i})" data-run-idx="${i}">${esc(label)} (${date})</button>`;
  }).join('');

  const panels = runs.map((run, i) => `<div class="run-panel${i === 0 ? ' active' : ''}" data-run-idx="${i}"><div class="run-meta"><span>Template: <strong>${esc(run.template_name || 'Unknown')}</strong></span><span>${new Date(run.created_at).toLocaleString()}</span><span class="status-badge status-${run.status}">${STATUS_LABELS[run.status] || run.status}</span></div>${renderSingleRun(run)}</div>`).join('');
  return `<div class="run-tabs">${tabs}</div>${panels}`;
}

export function openUploadZone() {
  const zone = document.getElementById('uploadZone');
  zone.hidden = !zone.hidden;
}

export async function handleFiles(files) {
  if (!state.currentBucket) return;
  if (state.healthStatus && !state.healthStatus.services.gcp_sa) {
    toast('Document reading is not configured yet.');
    return;
  }

  const pdfFiles = Array.from(files).filter((f) => f.type === 'application/pdf');
  if (!pdfFiles.length) { toast('Please upload PDF files (.pdf format).'); return; }

  document.getElementById('uploadZone').hidden = true;
  const fileCount = pdfFiles.length;

  for (let i = 0; i < fileCount; i += 1) {
    const file = pdfFiles[i];
    const label = fileCount > 1 ? `${file.name} (${i + 1} of ${fileCount})` : file.name;
    const base = (i / fileCount) * 100;
    const slot = 100 / fileCount;

    pcShow(label, state.currentBucket.name);
    pcStep(0, 'active', 'Starting…');
    pcProgress(base + slot * 0.02);

    try {
      const pages = await rasterizePdf(file, (pg, total) => {
        pcStep(0, 'active', `Page ${pg} of ${total}`);
        pcProgress(base + (pg / total) * slot * 0.5);
      });

      pcStep(0, 'done', `${pages.length} page${pages.length !== 1 ? 's' : ''}`);
      pcStep(1, 'active', `${(JSON.stringify({ filename: file.name, pages }).length / 1024 / 1024).toFixed(1)} MB`);
      pcProgress(base + slot * 0.6);

      debugLog(`Uploading ${pages.length} page(s) for ${file.name}`);
      const ocrTimer = setTimeout(() => {
        pcStep(1, 'done');
        pcStep(2, 'active', 'Reading text — this happens in the background');
        document.getElementById('pcBar').style.transition = 'width 8s ease-out';
        pcProgress(base + slot * 0.9);
      }, 800);

      let result;
      try {
        result = await api(`/buckets/${state.currentBucket.id}/upload`, { method: 'POST', body: JSON.stringify({ filename: file.name, pages }) });
      } finally {
        clearTimeout(ocrTimer);
        document.getElementById('pcBar').style.transition = 'width 0.3s ease';
      }

      debugLog(`OCR started in background — job ${result.job_id} (${result.page_count} pages)`, 'success');
      pcStep(1, 'done');
      pcStep(2, 'done', `${result.page_count} pages queued`);
      pcProgress(base + slot);
    } catch (e) {
      pcStep(0, 'error'); pcStep(1, 'error'); pcStep(2, 'error', e.message);
      toast(`${file.name}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  pcDone();
  await new Promise((r) => setTimeout(r, 1200));

  const fileInput = document.getElementById('fileInput');
  fileInput.value = '';
  pcHide();
  await openBucket(state.currentBucket.id, true);
}

export async function rasterizePdf(file, onProgress) {
  const pdfjsLib = await getPdfJs();
  debugLog(`Loading: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  const arrayBuf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  const pages = [];
  const DPI = 180;
  const SCALE = DPI / 72;
  const MAX_DIMENSION = 2000;
  const JPEG_QUALITY = 0.72;

  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const baseViewport = page.getViewport({ scale: SCALE });
    const dimensionScale = Math.min(1, MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale: SCALE * dimensionScale });
    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const b64 = await blobToBase64(blob);
    pages.push(b64);
    onProgress?.(i, pdf.numPages);
  }

  return pages;
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function pcShow(filename, bucketName) {
  document.getElementById('pcFilename').textContent = filename;
  document.getElementById('pcDest').textContent = bucketName ? `→ ${bucketName}` : '';
  document.getElementById('pcSpinner').className = 'pc-spinner';
  document.getElementById('pcPct').textContent = '';
  document.getElementById('pcBar').style.transition = 'width 0.3s ease';
  document.getElementById('pcBar').style.width = '0%';
  [0, 1, 2].forEach((i) => pcStep(i, 'pending', ''));
  document.getElementById('processingCard').hidden = false;
}
function pcStep(index, stateVal, extra = '') {
  const el = document.getElementById(`pcStep${index}`);
  el.dataset.state = stateVal;
  document.getElementById(`pcExtra${index}`).textContent = extra;
}
function pcProgress(pct) {
  document.getElementById('pcBar').style.width = `${pct}%`;
  document.getElementById('pcPct').textContent = `${Math.round(pct)}%`;
}
function pcDone() {
  const spinner = document.getElementById('pcSpinner');
  spinner.className = 'pc-spinner done';
  spinner.textContent = '✓';
  document.getElementById('pcPct').textContent = '✓ Done';
  document.getElementById('pcPct').style.color = 'var(--success)';
}
function pcHide() { document.getElementById('processingCard').hidden = true; }

export async function runExtraction(jobId, btn) {
  if (state.healthStatus && !state.healthStatus.services.openai) {
    toast('AI extraction is not configured yet.');
    return;
  }

  const originalBtnText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }

  const select = document.getElementById(`tmpl-select-${jobId}`);
  const templateId = select?.value || undefined;
  const body = templateId ? JSON.stringify({ template_id: templateId }) : undefined;

  try {
    await api(`/jobs/${jobId}/extract`, { method: 'POST', ...(body && { body }) });
    delete state.jobDetailCache[jobId];
    const activeView = document.querySelector('.view:not([hidden])')?.id;
    if (activeView === 'viewBucket' && state.currentBucket?.id) {
      await openBucket(state.currentBucket.id, true);
      await toggleJobDetail(jobId);
    } else if (activeView === 'viewJobs') {
      await window.showJobs();
    } else if (activeView === 'viewReview') {
      await window.openReview(jobId, true);
    }
  } catch (e) {
    toast('Extraction failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = originalBtnText || 'Run'; }
  }
}

export async function runAllPending() {
  if (!state.currentBucket) return;
  const data = await api(`/buckets/${state.currentBucket.id}`);
  const pending = (data.jobs || []).filter((j) => j.status === 'pending');
  if (!pending.length) { toast('All documents have already been extracted.'); return; }
  for (const job of pending) {
    try { await runExtraction(job.id); } catch {
      // no-op
    }
  }
}

export async function deleteJob(jobId) {
  try {
    delete state.jobDetailCache[jobId];
    await api(`/jobs/${jobId}`, { method: 'DELETE' });
    if (state.currentBucket?.id) await openBucket(state.currentBucket.id, true);
  } catch (e) {
    toast('Could not delete document: ' + e.message);
  }
}

export async function reRunExtraction(jobId, btn) {
  delete state.jobDetailCache[jobId];
  await runExtraction(jobId, btn);
}

export async function exportBucketCSV() {
  let data;
  try {
    data = await api(`/buckets/${state.currentBucket.id}`);
  } catch (e) {
    toast('Failed to load bucket: ' + e.message);
    return;
  }
  const doneJobs = (data.jobs || []).filter((j) => j.status === 'done');
  if (!doneJobs.length) { toast('Nothing to export yet — extract some documents first.'); return; }

  const details = await Promise.all(doneJobs.map(async (j) => {
    if (!state.jobDetailCache[j.id]) {
      try { state.jobDetailCache[j.id] = await api(`/jobs/${j.id}`); } catch { return null; }
    }
    return state.jobDetailCache[j.id];
  }));

  const allKeys = new Set();
  details.forEach((d) => {
    if (!d) return;
    const result = d.runs?.[0]?.result;
    if (result && typeof result === 'object') Object.keys(result).forEach((k) => allKeys.add(k));
  });

  const keys = [...allKeys];
  const csvRows = [['filename', 'pages', ...keys]];
  doneJobs.forEach((j, i) => {
    const result = details[i]?.runs?.[0]?.result || {};
    csvRows.push([j.filename, j.page_count ?? '', ...keys.map((k) => {
      const val = result[k];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val);
      return String(val);
    })]);
  });

  const csv = csvRows.map((r) => r.map((cell) => {
    const s = String(cell);
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.currentBucket.name.replace(/[^a-z0-9]/gi, '_')}_export.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function showReExtractPanel() {
  const panel = document.getElementById('reExtractPanel');
  if (!panel.hidden) { panel.hidden = true; return; }

  const templates = await ensureTemplatesLoaded(api);
  const defaultTmplId = state.currentBucket?.template_id;
  const opts = templates.map((t) => `<option value="${t.id}"${t.id === defaultTmplId ? ' selected' : ''}>${esc(t.name)}</option>`).join('');

  const s = state.currentBucket?.stats || {};
  const count = (s.done_count || 0) + (s.error_count || 0);

  panel.hidden = false;
  panel.innerHTML = `<span class="re-extract-label">Re-extract ${count} document${count !== 1 ? 's' : ''} using:</span><select id="reExtractTemplateSelect">${opts}</select><button class="small primary" onclick="runBatchReExtract()">Run</button><button class="small" onclick="document.getElementById('reExtractPanel').hidden = true">Cancel</button>`;
}

export async function runBatchReExtract() {
  if (!state.currentBucket) return;
  const templateId = document.getElementById('reExtractTemplateSelect').value;
  const panel = document.getElementById('reExtractPanel');

  const data = await api(`/buckets/${state.currentBucket.id}`);
  const eligible = (data.jobs || []).filter((j) => j.status === 'done' || j.status === 'error');
  if (!eligible.length) { toast('No documents available for re-extraction.'); return; }

  panel.innerHTML = `<span class="re-extract-label">Re-extracting ${eligible.length} document${eligible.length !== 1 ? 's' : ''}… please wait</span>`;

  let success = 0;
  for (const job of eligible) {
    try {
      await api(`/jobs/${job.id}/extract`, { method: 'POST', body: JSON.stringify({ template_id: templateId }) });
      delete state.jobDetailCache[job.id];
      success += 1;
    } catch {
      // no-op
    }
  }

  panel.hidden = true;
  toast(`Done — ${success} of ${eligible.length} documents re-extracted.`, 4000, 'success');
  await openBucket(state.currentBucket.id, true);
}

export function startRenameBucket() {
  const h2 = document.getElementById('bucketName');
  if (!h2 || !state.currentBucket) return;
  const current = state.currentBucket.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'bucket-rename-input';
  h2.replaceWith(input);
  document.getElementById('btnRenameBucket').hidden = true;
  input.focus();
  input.select();

  let done = false;
  async function finishRename() {
    if (done) return;
    done = true;
    const newName = input.value.trim() || current;
    if (newName !== current) {
      try {
        await api(`/buckets/${state.currentBucket.id}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
        state.currentBucket.name = newName;
      } catch (e) {
        toast('Failed to rename: ' + e.message);
      }
    }
    const newH2 = document.createElement('h2');
    newH2.id = 'bucketName';
    newH2.textContent = state.currentBucket.name;
    input.replaceWith(newH2);
    document.getElementById('btnRenameBucket').hidden = false;
    updateBreadcrumb([{ label: 'Buckets', action: 'goHome()' }, { label: state.currentBucket.name }]);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(); }
    if (e.key === 'Escape') {
      done = true;
      const newH2 = document.createElement('h2');
      newH2.id = 'bucketName';
      newH2.textContent = current;
      input.replaceWith(newH2);
      document.getElementById('btnRenameBucket').hidden = false;
    }
  });
  input.addEventListener('blur', finishRename);
}

export function quickUpload(bucketId) {
  openBucket(bucketId).then(() => {
    document.getElementById('uploadZone').hidden = false;
  });
}

export function initBucketDomHandlers() {
  const dropArea = document.getElementById('dropArea');
  const fileInput = document.getElementById('fileInput');
  if (dropArea) {
    dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('dragover'); });
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
    dropArea.addEventListener('drop', (e) => {
      e.preventDefault();
      dropArea.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });
  }
  if (fileInput) fileInput.addEventListener('change', () => handleFiles(fileInput.files));
}

export function exposeBucketActions() {
  return {
    showDashboard,
    openBucket,
    renderBucketInfoBar,
    changeBucketTemplate,
    applyBucketTemplate,
    cancelBucketTemplateChange,
    openBuilderFromBucket,
    openUploadZone,
    runExtraction,
    reRunExtraction,
    runAllPending,
    deleteJob,
    toggleJobDetail,
    exportBucketCSV,
    showReExtractPanel,
    runBatchReExtract,
    startRenameBucket,
    quickUpload,
    rasterizePdf,
    switchRunTab,
  };
}
