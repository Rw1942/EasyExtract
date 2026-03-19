// ── PDF.js setup ──
const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';

const API = '/api';
let healthStatus = null;

// ── State ──
let currentBucket = null;
let editingTemplateId = null;
let navStack = ['dashboard'];
let afterTemplateSaved = null;    // callback after any template is created
let pendingTemplateSelect = null; // ID to auto-select in showNewBucket()
let pollingBucketId = null;       // tracks active polling target

// ── Processing card ──
function pcShow(filename, bucketName) {
  document.getElementById('pcFilename').textContent = filename;
  document.getElementById('pcDest').textContent = bucketName ? `→ ${bucketName}` : '';
  document.getElementById('pcSpinner').className = 'pc-spinner';
  document.getElementById('pcPct').textContent = '';
  document.getElementById('pcBar').style.transition = 'width 0.3s ease';
  document.getElementById('pcBar').style.width = '0%';
  [0, 1, 2].forEach(i => pcStep(i, 'pending', ''));
  document.getElementById('processingCard').hidden = false;
}

function pcStep(index, state, extra = '') {
  const el = document.getElementById(`pcStep${index}`);
  el.dataset.state = state;
  document.getElementById(`pcExtra${index}`).textContent = extra;
}

function pcProgress(pct) {
  const bar = document.getElementById('pcBar');
  bar.style.width = `${pct}%`;
  document.getElementById('pcPct').textContent = `${Math.round(pct)}%`;
}

function pcDone() {
  const spinner = document.getElementById('pcSpinner');
  spinner.className = 'pc-spinner done';
  spinner.textContent = '✓';
  document.getElementById('pcPct').textContent = '✓ Done';
  document.getElementById('pcPct').style.color = 'var(--success)';
}

function pcHide() {
  document.getElementById('processingCard').hidden = true;
}

// ── Debug log panel ──
let debugCollapsed = false;

function debugLog(msg, type = 'info') {
  const messages = document.getElementById('debugPanelMessages');
  const bar = document.getElementById('debugPanelBar');
  const el = document.createElement('div');
  el.className = `debug-log debug-log-${type}`;
  el.innerHTML = `<span>${msg}</span><button onclick="this.closest('.debug-log').remove(); updateDebugCount()" title="Dismiss">&times;</button>`;
  messages.appendChild(el);
  bar.hidden = false;
  updateDebugCount();
  if (!debugCollapsed) messages.scrollTop = messages.scrollHeight;
}

function updateDebugCount() {
  const count = document.getElementById('debugPanelMessages').children.length;
  document.getElementById('debugPanelLabel').textContent = count ? `Debug (${count})` : 'Debug';
  if (!count) document.getElementById('debugPanelBar').hidden = true;
}

function toggleDebugPanel() {
  debugCollapsed = !debugCollapsed;
  document.getElementById('debugPanelMessages').hidden = debugCollapsed;
  document.getElementById('debugCollapseBtn').innerHTML = debugCollapsed ? '&#9650;' : '&#9660;';
}

function clearDebugPanel() {
  document.getElementById('debugPanelMessages').innerHTML = '';
  updateDebugCount();
}

// ── API helpers ──
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    debugLog(`Server response (HTTP ${res.status}) — not valid JSON:\n${text.slice(0, 500)}`, 'error');
    throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${e.message}`);
  }
  if (!json.ok) throw new Error(json.error?.message || 'Request failed');
  return json.data;
}

// ── Toast notifications ──
function toast(msg, duration = 5000, type = 'error') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ── Health check & setup banner ──
async function checkHealth() {
  try {
    healthStatus = await api('/health');
  } catch {
    healthStatus = { ready: false, services: {} };
  }
  renderSetupBanner();
}

function renderSetupBanner() {
  const banner = document.getElementById('setupBanner');
  const checklist = document.getElementById('setupChecklist');
  if (!healthStatus || healthStatus.ready) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  const s = healthStatus.services;
  const items = [
    { key: 'openai', label: 'OpenAI API Key', ok: s.openai },
    { key: 'gcp_sa', label: 'GCP Service Account', ok: s.gcp_sa },
    { key: 'gcp_project', label: 'GCP Project ID', ok: s.gcp_project },
  ];

  checklist.innerHTML = items.map(i =>
    `<span class="setup-check ${i.ok ? 'ok' : 'missing'}">${i.ok ? '&#10003;' : '&#10007;'} ${i.label}</span>`
  ).join('');
}

// ── Navigation ──
function showView(id) {
  if (id !== 'viewBucket') pollingBucketId = null;
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.getElementById(id).hidden = false;
}

function goBack() {
  navStack.pop();
  const prev = navStack[navStack.length - 1] || 'dashboard';
  if (prev === 'dashboard') showDashboard();
  else if (prev === 'templateList') showTemplateList();
  else if (prev === 'templateBuilder') showTemplateBuilder();
  else if (prev.startsWith('bucket:')) openBucket(prev.split(':')[1], true);
}

function goHome() {
  navStack = ['dashboard'];
  showDashboard();
}

function goToTemplates() {
  navStack = ['templateList'];
  showTemplateList();
}

function setActiveTab(tab) {
  document.getElementById('navBuckets').classList.toggle('active', tab === 'buckets');
  document.getElementById('navTemplates').classList.toggle('active', tab === 'templates');
}

function updateBreadcrumb(parts) {
  const section = parts[0]?.label;
  const isSection = section === 'Buckets' || section === 'Templates';
  setActiveTab(section === 'Buckets' ? 'buckets' : section === 'Templates' ? 'templates' : '');

  const trail = isSection ? parts.slice(1) : parts;
  const bc = document.getElementById('breadcrumb');
  if (!trail.length) { bc.innerHTML = ''; return; }

  const prefix = isSection ? '/ ' : '';
  bc.innerHTML = prefix + trail.map((p, i) =>
    i < trail.length - 1
      ? `<a onclick="${p.action}">${p.label}</a> / `
      : `<span>${p.label}</span>`
  ).join('');
}

document.getElementById('headerTitle').onclick = goHome;

// ── Dashboard ──
async function showDashboard() {
  showView('viewDashboard');
  updateBreadcrumb([{ label: 'Buckets' }]);

  try {
    const buckets = await api('/buckets');
    const grid = document.getElementById('bucketGrid');
    const empty = document.getElementById('noBuckets');

    if (!buckets.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `
        <h3>Welcome to EasyExtract</h3>
        <p>Upload PDFs and pull out structured data automatically. Here's how it works:</p>
        <div class="onboarding-steps">
          <div class="onboarding-step">
            <div class="step-num">Step 1</div>
            <h4>Create a Template</h4>
            <p>Define the fields to extract — like Revenue, Date, or Account Number.</p>
          </div>
          <div class="onboarding-step">
            <div class="step-num">Step 2</div>
            <h4>Create a Bucket</h4>
            <p>A bucket groups similar documents, like "Q4 Decks" or "Loan Applications."</p>
          </div>
          <div class="onboarding-step">
            <div class="step-num">Step 3</div>
            <h4>Upload &amp; Extract</h4>
            <p>Upload PDFs and AI reads each one and fills in your template fields.</p>
          </div>
        </div>
        <button class="primary" onclick="showTemplateList()">Get started — create a template</button>
      `;
      await seedStarterTemplates();
      return;
    }

    empty.hidden = true;
    grid.innerHTML = buckets.map(b => `
      <div class="card" onclick="openBucket('${b.id}')">
        <h3>${esc(b.name)}</h3>
        <div><span class="template-tag">${esc(b.template_name || 'No template')}</span></div>
        <p class="card-doc-count">${b.job_count || 0} document${b.job_count !== 1 ? 's' : ''}</p>
        <div class="card-actions">
          <button class="small danger" onclick="event.stopPropagation(); deleteBucket('${b.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    toast('Failed to load buckets: ' + e.message);
  }
}

// ── Bucket detail ──
async function openBucket(id, isBack) {
  if (!isBack) navStack.push('bucket:' + id);
  showView('viewBucket');

  try {
    const data = await api(`/buckets/${id}`);
    currentBucket = data;
    document.getElementById('bucketName').textContent = data.name;
    document.getElementById('uploadZone').hidden = true;
    updateBreadcrumb([
      { label: 'Buckets', action: 'goHome()' },
      { label: data.name },
    ]);

    renderBucketInfoBar(data);

    renderJobs(data.jobs || []);

    const inProgress = (data.jobs || []).some(j => j.status === 'ocr' || j.status === 'extracting');
    pollingBucketId = inProgress ? data.id : null;
    if (inProgress) schedulePolling(data.id);
  } catch (e) {
    toast('Failed to load bucket: ' + e.message);
  }
}

function schedulePolling(bucketId) {
  setTimeout(async () => {
    if (pollingBucketId !== bucketId) return;
    await openBucket(bucketId, true);
  }, 4000);
}

function renderBucketInfoBar(data) {
  const infoBar = document.getElementById('bucketInfoBar');
  if (!data.template_name && !data.template_id) { infoBar.hidden = true; return; }
  infoBar.hidden = false;
  infoBar.innerHTML = `
    <span>Template: <strong>${esc(data.template_name || data.template_id)}</strong></span>
    <div class="info-bar-actions">
      <a onclick="editTemplate('${data.template_id}')">Edit fields</a>
      <button class="small" onclick="changeBucketTemplate()">Change</button>
    </div>
  `;
}

async function changeBucketTemplate() {
  const infoBar = document.getElementById('bucketInfoBar');
  infoBar.innerHTML = `<span class="info-bar-loading">Loading templates…</span>`;

  let templates;
  try {
    templates = await api('/templates');
  } catch (e) {
    toast('Failed to load templates: ' + e.message);
    renderBucketInfoBar(currentBucket);
    return;
  }

  if (!templates.length) {
    toast('No templates available. Create one first.');
    renderBucketInfoBar(currentBucket);
    return;
  }

  const options = templates.map(t =>
    `<option value="${t.id}"${t.id === currentBucket.template_id ? ' selected' : ''}>${esc(t.name)}</option>`
  ).join('');

  infoBar.innerHTML = `
    <span>Template:</span>
    <select id="bucketTemplateChanger">${options}</select>
    <div class="info-bar-actions">
      <button class="small ai-btn" onclick="openBuilderFromBucket()">+ New template</button>
      <button class="small primary" onclick="applyBucketTemplate()">Apply</button>
      <button class="small" onclick="cancelBucketTemplateChange()">Cancel</button>
    </div>
  `;
}

async function applyBucketTemplate() {
  const select = document.getElementById('bucketTemplateChanger');
  const newTemplateId = select.value;
  const newTemplateName = select.options[select.selectedIndex].text;

  if (newTemplateId === currentBucket.template_id) {
    renderBucketInfoBar(currentBucket);
    return;
  }

  const applyBtn = select.closest('.bucket-info-bar').querySelector('button.primary');
  applyBtn.disabled = true;
  applyBtn.textContent = 'Saving…';

  try {
    await api(`/buckets/${currentBucket.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ template_id: newTemplateId }),
    });
    currentBucket.template_id = newTemplateId;
    currentBucket.template_name = newTemplateName;
    renderBucketInfoBar(currentBucket);
    toast(`Template changed to "${newTemplateName}" — pending documents will use this template on next extraction`, 5000, 'success');
  } catch (e) {
    toast('Failed to update template: ' + e.message);
    renderBucketInfoBar(currentBucket);
  }
}

function cancelBucketTemplateChange() {
  renderBucketInfoBar(currentBucket);
}

function openBuilderFromBucket() {
  const savedBucketId = currentBucket.id;
  afterTemplateSaved = async (templateId) => {
    await openBucket(savedBucketId, true);
    await changeBucketTemplate();
    const sel = document.getElementById('bucketTemplateChanger');
    if (sel) sel.value = templateId;
  };
  showTemplateBuilder();
}

const STATUS_LABELS = {
  ocr:        'Reading text…',
  pending:    'Ready to extract',
  extracting: 'Extracting…',
  done:       'Complete',
  error:      'Failed',
};

let expandedJobId = null;
const jobDetailCache = {};

function renderJobs(jobs) {
  expandedJobId = null;
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
  const hasDone = jobs.some(j => j.status === 'done');
  if (exportBtn) exportBtn.hidden = !hasDone;
  tbody.innerHTML = jobs.map(j => {
    const expandable = j.status === 'done' || j.status === 'error';
    const actions = j.status === 'pending'
      ? `<button class="small primary" onclick="event.stopPropagation(); runExtraction('${j.id}', this)">Extract</button>`
      : (j.status === 'done' || j.status === 'error')
        ? `<button class="small" onclick="event.stopPropagation(); reRunExtraction('${j.id}', this)">Re-extract</button>
           <button class="small danger" onclick="event.stopPropagation(); deleteJob('${j.id}')">Delete</button>`
        : '';

    return `
      <tr class="job-row${expandable ? ' expandable' : ''}" ${expandable ? `onclick="toggleJobDetail('${j.id}')" data-job-id="${j.id}"` : ''}>
        <td class="filename-cell" title="${esc(j.filename)}">
          <span class="job-chevron" id="chevron-${j.id}">${expandable ? '▸' : ''}</span>${esc(j.filename)}
        </td>
        <td>${j.page_count ?? '—'}</td>
        <td><span class="status-badge status-${j.status}">${STATUS_LABELS[j.status] || j.status}</span></td>
        <td>${actions}</td>
      </tr>
      <tr class="job-detail-row" id="detail-${j.id}">
        <td colspan="4" class="job-detail-cell">
          <div class="job-detail-wrap" id="wrap-${j.id}">
            <div class="job-detail-inner" id="inner-${j.id}"></div>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function toggleJobDetail(jobId) {
  const wrap = document.getElementById(`wrap-${jobId}`);
  const inner = document.getElementById(`inner-${jobId}`);
  const chevron = document.getElementById(`chevron-${jobId}`);
  if (!wrap) return;

  const isOpen = wrap.classList.contains('open');

  // Close previously open row
  if (expandedJobId && expandedJobId !== jobId) {
    const prevWrap = document.getElementById(`wrap-${expandedJobId}`);
    const prevChevron = document.getElementById(`chevron-${expandedJobId}`);
    if (prevWrap) prevWrap.classList.remove('open');
    if (prevChevron) prevChevron.textContent = '▸';
  }

  if (isOpen) {
    wrap.classList.remove('open');
    chevron.textContent = '▸';
    expandedJobId = null;
    return;
  }

  // Open: show loading, expand, then populate
  inner.innerHTML = `<div class="detail-loading"><span class="detail-spinner"></span> Loading…</div>`;
  wrap.classList.add('open');
  chevron.textContent = '▾';
  expandedJobId = jobId;

  if (!jobDetailCache[jobId]) {
    try {
      jobDetailCache[jobId] = await api(`/jobs/${jobId}`);
    } catch (e) {
      inner.innerHTML = `<div class="detail-error-box"><strong>Failed to load</strong><p>${esc(e.message)}</p></div>`;
      return;
    }
  }

  inner.innerHTML = renderJobDetail(jobDetailCache[jobId]);
}

function renderJobDetail(jobData) {
  const run = jobData.runs?.[0];
  if (!run) return `<div class="detail-empty">No extraction run yet.</div>`;

  if (run.status === 'error') {
    return `<div class="detail-error-box"><strong>Extraction failed</strong><p>${esc(run.error || 'Unknown error')}</p></div>`;
  }

  let result = run.result;
  // Result may arrive as a JSON-encoded string from the server
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch {}
  }
  if (!result || typeof result !== 'object') return `<div class="detail-empty">No data extracted.</div>`;

  const entries = Object.entries(result);
  if (!entries.length) return `<div class="detail-empty">No fields were extracted.</div>`;

  return `<table class="result-fields">
    <tbody>
      ${entries.map(([key, val]) => `
        <tr>
          <td class="result-key">${esc(key)}</td>
          <td class="result-val">${formatResultVal(val)}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function formatCurrency(amount, currencyCode) {
  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
    return `<span class="rval-currency">${esc(formatted)}</span>`;
  } catch {
    return `<span class="rval-currency">${esc(currencyCode)} ${amount.toLocaleString()}</span>`;
  }
}

function formatResultVal(val, depth = 0) {
  if (val === null || val === undefined) return `<span class="rval-null">—</span>`;
  if (typeof val === 'boolean') return `<span class="rval-bool">${val}</span>`;
  if (typeof val === 'number') return `<span class="rval-number">${val.toLocaleString()}</span>`;

  // Try to parse JSON-encoded strings as structured data before treating as plain text
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length > 1 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) return formatResultVal(parsed, depth);
      } catch {}
    }
  }

  // Currency object: {amount: number, currency: string}
  if (
    typeof val === 'object' && !Array.isArray(val) &&
    typeof val.amount === 'number' && typeof val.currency === 'string'
  ) {
    return formatCurrency(val.amount, val.currency);
  }

  if (Array.isArray(val)) {
    if (!val.length) return `<span class="rval-null">—</span>`;

    // Array of objects → multi-column table (ignore null/undefined slots)
    const objectItems = val.filter(item => item && typeof item === 'object' && !Array.isArray(item));
    if (objectItems.length > 0) {
      const keys = [...new Set(objectItems.flatMap(item => Object.keys(item)))];
      return `<table class="rval-table">
        <thead><tr>${keys.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead>
        <tbody>${objectItems.map(row =>
          `<tr>${keys.map(k => `<td>${formatResultVal(row[k], depth + 1)}</td>`).join('')}</tr>`
        ).join('')}</tbody>
      </table>`;
    }

    // Array of primitives → comma-separated
    return val.map(item => formatResultVal(item, depth + 1)).join(', ');
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val);
    if (!entries.length) return `<span class="rval-null">—</span>`;

    // Nested object → two-column key/value table
    return `<table class="rval-table">
      <tbody>${entries.map(([k, v]) =>
        `<tr>
          <td class="rval-table-key">${esc(k)}</td>
          <td>${formatResultVal(v, depth + 1)}</td>
        </tr>`
      ).join('')}</tbody>
    </table>`;
  }

  // String: escape then render basic markdown
  return esc(String(val))
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

// ── Upload ──
function openUploadZone() {
  const zone = document.getElementById('uploadZone');
  zone.hidden = !zone.hidden;
}

const dropArea = document.getElementById('dropArea');
const fileInput = document.getElementById('fileInput');

dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('dragover'); });
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('dragover'));
dropArea.addEventListener('drop', e => {
  e.preventDefault();
  dropArea.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

async function handleFiles(files) {
  if (!currentBucket) return;

  if (healthStatus && !healthStatus.services.gcp_sa) {
    toast('Google Cloud Vision is not configured yet. Check the setup guide at the top of the page.');
    return;
  }

  const pdfFiles = Array.from(files).filter(f => f.type === 'application/pdf');
  if (!pdfFiles.length) { toast('No PDF files found — please upload .pdf files.'); return; }

  // Close the drop zone — the processing card takes over from here
  document.getElementById('uploadZone').hidden = true;

  const fileCount = pdfFiles.length;

  for (let i = 0; i < fileCount; i++) {
    const file = pdfFiles[i];
    const label = fileCount > 1 ? `${file.name} (${i + 1} of ${fileCount})` : file.name;
    const base = (i / fileCount) * 100;
    const slot = 100 / fileCount;

    pcShow(label, currentBucket.name);
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

      // Transition to OCR step after a brief moment so the user sees the upload step
      const ocrTimer = setTimeout(() => {
        pcStep(1, 'done');
        pcStep(2, 'active', 'Queued for OCR — processing in background…');
        document.getElementById('pcBar').style.transition = 'width 8s ease-out';
        pcProgress(base + slot * 0.9);
      }, 800);

      let result;
      try {
        result = await api(`/buckets/${currentBucket.id}/upload`, {
          method: 'POST',
          body: JSON.stringify({ filename: file.name, pages }),
        });
      } finally {
        clearTimeout(ocrTimer);
        document.getElementById('pcBar').style.transition = 'width 0.3s ease';
      }

      debugLog(`OCR started in background — job ${result.job_id} (${result.page_count} pages)`, 'success');

      pcStep(1, 'done');
      pcStep(2, 'done', `${result.page_count} pages queued`);
      pcProgress(base + slot);

    } catch (e) {
      console.error(`Failed to process ${file.name}:`, e);
      pcStep(0, 'error');
      pcStep(1, 'error');
      pcStep(2, 'error', e.message);
      toast(`${file.name}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Show done state briefly before refreshing the table
  pcDone();
  await new Promise(r => setTimeout(r, 1200));

  fileInput.value = '';
  pcHide();
  await openBucket(currentBucket.id, true);
}

async function rasterizePdf(file, onProgress) {
  debugLog(`Loading: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  const arrayBuf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
  } catch (e) {
    debugLog(`PDF.js failed to open file: ${e.message}`, 'error');
    throw e;
  }
  debugLog(`PDF opened — ${pdf.numPages} page(s)`);
  const pages = [];
  const DPI = 180;
  const SCALE = DPI / 72;
  const MAX_DIMENSION = 2000;
  const JPEG_QUALITY = 0.72;

  for (let i = 1; i <= pdf.numPages; i++) {
    let page;
    try {
      page = await pdf.getPage(i);
    } catch (e) {
      debugLog(`Failed to load page ${i}: ${e.message}`, 'error');
      throw e;
    }
    const baseViewport = page.getViewport({ scale: SCALE });
    const dimensionScale = Math.min(1, MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale: SCALE * dimensionScale });
    debugLog(`Page ${i}/${pdf.numPages}: ${Math.round(viewport.width)}×${Math.round(viewport.height)}px — rendering...`);
    let blob;
    try {
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    } catch (e) {
      debugLog(`Failed to rasterize page ${i}: ${e.message}`, 'error');
      throw e;
    }
    const b64 = await blobToBase64(blob);
    debugLog(`Page ${i} rasterized — JPEG ${(blob.size / 1024).toFixed(0)} KB → base64 ${(b64.length / 1024).toFixed(0)} KB`, 'success');
    pages.push(b64);
    onProgress?.(i, pdf.numPages);
  }

  return pages;
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      resolve(result.split(',')[1]);
    };
    reader.readAsDataURL(blob);
  });
}

// ── Extraction ──
async function runExtraction(jobId, btn) {
  if (healthStatus && !healthStatus.services.openai) {
    toast('OpenAI is not configured yet. Check the setup guide at the top of the page.');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }

  try {
    await api(`/jobs/${jobId}/extract`, { method: 'POST' });
    delete jobDetailCache[jobId];
    await openBucket(currentBucket.id, true);
    await toggleJobDetail(jobId);
  } catch (e) {
    toast('Extraction failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Extract'; }
  }
}

async function runAllPending() {
  if (!currentBucket) return;
  const data = await api(`/buckets/${currentBucket.id}`);
  const pending = (data.jobs || []).filter(j => j.status === 'pending');
  if (!pending.length) { toast('No pending jobs to run.'); return; }

  for (const job of pending) {
    try { await runExtraction(job.id); } catch (e) { console.error(e); }
  }
}

async function deleteJob(jobId) {
  try {
    delete jobDetailCache[jobId];
    await api(`/jobs/${jobId}`, { method: 'DELETE' });
    await openBucket(currentBucket.id, true);
  } catch (e) {
    toast('Failed to remove job: ' + e.message);
  }
}

async function reRunExtraction(jobId, btn) {
  delete jobDetailCache[jobId];
  await runExtraction(jobId, btn);
}

async function exportBucketCSV() {
  let data;
  try {
    data = await api(`/buckets/${currentBucket.id}`);
  } catch (e) {
    toast('Failed to load bucket: ' + e.message);
    return;
  }
  const doneJobs = (data.jobs || []).filter(j => j.status === 'done');
  if (!doneJobs.length) { toast('No completed extractions to export.'); return; }

  const details = await Promise.all(doneJobs.map(async j => {
    if (!jobDetailCache[j.id]) {
      try { jobDetailCache[j.id] = await api(`/jobs/${j.id}`); } catch { return null; }
    }
    return jobDetailCache[j.id];
  }));

  const allKeys = new Set();
  details.forEach(d => {
    if (!d) return;
    const result = d.runs?.[0]?.result;
    if (result && typeof result === 'object') Object.keys(result).forEach(k => allKeys.add(k));
  });

  const keys = [...allKeys];
  const csvRows = [['filename', 'pages', ...keys]];
  doneJobs.forEach((j, i) => {
    const result = details[i]?.runs?.[0]?.result || {};
    csvRows.push([
      j.filename,
      j.page_count ?? '',
      ...keys.map(k => {
        const val = result[k];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      }),
    ]);
  });

  const csv = csvRows.map(r => r.map(cell => {
    const s = String(cell);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }).join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentBucket.name.replace(/[^a-z0-9]/gi, '_')}_export.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Templates ──
async function showTemplateList() {
  if (navStack[navStack.length - 1] !== 'templateList') navStack.push('templateList');
  showView('viewTemplateList');
  updateBreadcrumb([{ label: 'Templates' }]);
  const templates = await api('/templates');
  const grid = document.getElementById('templateGrid');
  if (!templates.length) {
    grid.innerHTML = `<p class="empty-state">No templates yet — create one to get started.</p>`;
    return;
  }
  grid.innerHTML = templates.map(t => `
    <div class="card" onclick="editTemplate('${t.id}')">
      <h3>${esc(t.name)}</h3>
      <p>${esc(t.doc_type_hint || 'General document type')}</p>
      <div class="card-actions">
        <button class="small" onclick="event.stopPropagation(); editTemplate('${t.id}')">Edit fields</button>
        <button class="small" onclick="event.stopPropagation(); duplicateTemplate('${t.id}')">Duplicate</button>
        <button class="small danger" onclick="event.stopPropagation(); deleteTemplate('${t.id}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function showTemplateEditor(id) {
  editingTemplateId = id || null;
  navStack.push('templateEditor');
  showView('viewTemplateEditor');
  updateBreadcrumb([
    { label: 'Templates', action: 'goToTemplates()' },
    { label: id ? 'Edit Template' : 'New Template' },
  ]);
  document.getElementById('templateEditorTitle').textContent = id ? 'Edit Template' : 'New Template';
  document.getElementById('tmplName').value = '';
  document.getElementById('tmplDocType').value = '';
  document.getElementById('fieldsList').innerHTML = '';

  if (id) loadTemplateForEdit(id);
  else addFieldRow();
}

async function loadTemplateForEdit(id) {
  const t = await api(`/templates/${id}`);
  document.getElementById('tmplName').value = t.name;
  document.getElementById('tmplDocType').value = t.doc_type_hint || '';
  document.getElementById('fieldsList').innerHTML = '';
  (t.fields || []).forEach(f => addFieldRow(f));
}

function addFieldRow(f, containerId = 'fieldsList') {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.innerHTML = `
    <input type="text" placeholder="Field title" value="${esc(f?.title || '')}" class="f-title" required>
    <input type="text" placeholder="Description" value="${esc(f?.description || '')}" class="f-desc">
    <select class="f-type">
      ${['string','number','currency','date','object','array'].map(t =>
        `<option value="${t}" ${f?.type === t ? 'selected' : ''}>${t}</option>`
      ).join('')}
    </select>
    <label style="display:flex;align-items:center;gap:4px;margin:0;font-weight:normal">
      <input type="checkbox" class="f-req" ${f?.required ? 'checked' : ''}> Req
    </label>
    <button type="button" onclick="this.closest('.field-row').remove()">&times;</button>
  `;
  document.getElementById(containerId).appendChild(div);
}

async function saveTemplate(e) {
  e.preventDefault();
  const name = document.getElementById('tmplName').value.trim();
  const doc_type_hint = document.getElementById('tmplDocType').value.trim() || null;
  const rows = document.querySelectorAll('#fieldsList .field-row');
  const fields = Array.from(rows).map((row, i) => ({
    title: row.querySelector('.f-title').value.trim(),
    description: row.querySelector('.f-desc').value.trim() || null,
    type: row.querySelector('.f-type').value,
    required: row.querySelector('.f-req').checked ? 1 : 0,
    sort_order: i,
  })).filter(f => f.title);

  try {
    if (editingTemplateId) {
      await api(`/templates/${editingTemplateId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, doc_type_hint, fields }),
      });
      goBack();
    } else {
      const saved = await api('/templates', {
        method: 'POST',
        body: JSON.stringify({ name, doc_type_hint, fields }),
      });
      if (afterTemplateSaved) {
        const cb = afterTemplateSaved;
        afterTemplateSaved = null;
        cb(saved.id);
      } else {
        goBack();
      }
    }
  } catch (e) {
    toast('Failed to save template: ' + e.message);
  }
}

async function editTemplate(id) {
  showTemplateEditor(id);
}

async function deleteTemplate(id) {
  try {
    const buckets = await api('/buckets');
    const using = buckets.filter(b => b.template_id === id).map(b => b.name);
    if (using.length) {
      toast(`Can't delete — used by: ${using.join(', ')}`);
      return;
    }
  } catch (e) {
    toast('Failed to check template usage: ' + e.message);
    return;
  }
  if (!confirm('Delete this template?')) return;
  try {
    await api(`/templates/${id}`, { method: 'DELETE' });
    showTemplateList();
  } catch (e) {
    toast('Failed to delete template: ' + e.message);
  }
}

async function duplicateTemplate(id) {
  try {
    const t = await api(`/templates/${id}`);
    await api('/templates', { method: 'POST', body: JSON.stringify({
      name: `Copy of ${t.name}`,
      doc_type_hint: t.doc_type_hint,
      fields: t.fields,
    })});
    showTemplateList();
    toast('Template duplicated!', 3000, 'success');
  } catch (e) {
    toast('Failed to duplicate template: ' + e.message);
  }
}

// ── Buckets CRUD ──
async function showNewBucket() {
  navStack.push('newBucket');
  showView('viewNewBucket');
  updateBreadcrumb([
    { label: 'Buckets', action: 'goHome()' },
    { label: 'New Bucket' },
  ]);
  document.getElementById('templatePreview').hidden = true;
  const templates = await api('/templates');
  const sel = document.getElementById('bucketTemplateSelect');
  if (!templates.length) {
    sel.innerHTML = '<option value="" disabled>No templates yet — create one first</option>';
    return;
  }
  sel.innerHTML = `<option value="">— choose a template —</option>` + templates.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`
  ).join('');
  if (pendingTemplateSelect) {
    sel.value = pendingTemplateSelect;
    pendingTemplateSelect = null;
    await previewTemplate(sel.value);
  }
}

async function previewTemplate(templateId) {
  const box = document.getElementById('templatePreview');
  if (!templateId) { box.hidden = true; return; }
  try {
    const t = await api(`/templates/${templateId}`);
    const fields = t.fields || [];
    box.hidden = false;
    box.innerHTML = `
      <p>${fields.length} field${fields.length !== 1 ? 's' : ''} will be extracted:</p>
      <div class="field-pills">
        ${fields.map(f => `<span class="field-pill ${f.required ? 'required' : ''}" title="${esc(f.description || '')}">${esc(f.title)}</span>`).join('')}
      </div>
    `;
  } catch {
    box.hidden = true;
  }
}

async function saveBucket(e) {
  e.preventDefault();
  const name = document.getElementById('bucketNameInput').value.trim();
  const template_id = document.getElementById('bucketTemplateSelect').value;
  if (!template_id) { toast('Pick a template first.'); return; }
  await api('/buckets', { method: 'POST', body: JSON.stringify({ name, template_id }) });
  navStack.pop();
  showDashboard();
}

async function deleteBucket(id) {
  if (!confirm('Delete this bucket and all its documents?')) return;
  await api(`/buckets/${id}`, { method: 'DELETE' });
  showDashboard();
}

function openBuilderFromBucketForm() {
  afterTemplateSaved = returnToNewBucket;
  showTemplateBuilder();
}

function openManualEditorFromBucketForm() {
  afterTemplateSaved = returnToNewBucket;
  showTemplateEditor();
}

function returnToNewBucket(templateId) {
  pendingTemplateSelect = templateId;
  navStack = ['dashboard', 'newBucket'];
  showNewBucket();
}

// ── Template Builder ──
let builderPages = [];

function showTemplateBuilder() {
  if (navStack[navStack.length - 1] !== 'templateBuilder') navStack.push('templateBuilder');
  showView('viewTemplateBuilder');
  updateBreadcrumb([
    { label: 'Templates', action: 'goToTemplates()' },
    { label: 'Build with AI' },
  ]);
  showBuilderInput();
}

function showBuilderInput() {
  document.getElementById('builderInput').hidden = false;
  document.getElementById('builderGenerating').hidden = true;
  document.getElementById('builderReview').hidden = true;
}

// ── Builder sample document ──
const builderDropArea = document.getElementById('builderDropArea');
const builderFileInput = document.getElementById('builderFileInput');

builderDropArea.addEventListener('dragover', e => { e.preventDefault(); builderDropArea.classList.add('dragover'); });
builderDropArea.addEventListener('dragleave', () => builderDropArea.classList.remove('dragover'));
builderDropArea.addEventListener('drop', async e => {
  e.preventDefault();
  builderDropArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') await loadBuilderSample(file);
});
builderFileInput.addEventListener('change', async () => {
  if (builderFileInput.files[0]) await loadBuilderSample(builderFileInput.files[0]);
});

async function loadBuilderSample(file) {
  const info = document.getElementById('builderFileInfo');
  const prompt = document.getElementById('builderDropPrompt');
  const loaded = document.getElementById('builderFileLoaded');
  info.textContent = `${file.name} — rasterizing…`;
  prompt.hidden = true;
  loaded.hidden = false;
  try {
    const allPages = await rasterizePdf(file);
    builderPages = allPages.slice(0, 3);
    info.textContent = `${file.name} (${builderPages.length} page${builderPages.length !== 1 ? 's' : ''} ready)`;
  } catch (e) {
    info.textContent = `Failed to load: ${e.message}`;
    builderPages = [];
  }
}

function clearBuilderSample() {
  builderPages = [];
  builderFileInput.value = '';
  document.getElementById('builderDropPrompt').hidden = false;
  document.getElementById('builderFileLoaded').hidden = true;
}

// ── Generate from AI ──
async function generateTemplate() {
  const desc = document.getElementById('builderDesc').value.trim();
  if (!desc) { toast('Please describe what data you want to extract.'); return; }

  document.getElementById('builderInput').hidden = true;
  document.getElementById('builderGenerating').hidden = false;
  document.getElementById('builderReview').hidden = true;

  const statusEl = document.getElementById('builderGenStatus');
  const subEl = document.getElementById('builderGenSub');
  statusEl.textContent = builderPages.length > 0
    ? 'Analyzing your document and description…'
    : 'Analyzing your description…';
  subEl.textContent = 'This usually takes 5–15 seconds.';

  try {
    const result = await api('/templates/build', {
      method: 'POST',
      body: JSON.stringify({
        description: desc,
        ...(builderPages.length > 0 && { pages: builderPages }),
      }),
    });

    document.getElementById('builderName').value = result.name || '';
    document.getElementById('builderDocType').value = result.doc_type_hint || '';
    document.getElementById('builderFieldsList').innerHTML = '';
    (result.fields || []).forEach(f => addBuilderFieldRow(f));

    document.getElementById('builderGenerating').hidden = true;
    document.getElementById('builderReview').hidden = false;
  } catch (e) {
    toast('Generation failed: ' + e.message);
    showBuilderInput();
  }
}

function addBuilderFieldRow(f) {
  addFieldRow(f, 'builderFieldsList');
}

async function saveBuiltTemplate(e) {
  e.preventDefault();
  const name = document.getElementById('builderName').value.trim();
  const doc_type_hint = document.getElementById('builderDocType').value.trim() || null;
  const rows = document.querySelectorAll('#builderFieldsList .field-row');
  const fields = Array.from(rows).map((row, i) => ({
    title: row.querySelector('.f-title').value.trim(),
    description: row.querySelector('.f-desc').value.trim() || null,
    type: row.querySelector('.f-type').value,
    required: row.querySelector('.f-req').checked ? 1 : 0,
    sort_order: i,
  })).filter(f => f.title);

  try {
    const saved = await api('/templates', { method: 'POST', body: JSON.stringify({ name, doc_type_hint, fields }) });
    if (afterTemplateSaved) {
      const cb = afterTemplateSaved;
      afterTemplateSaved = null;
      cb(saved.id);
      return;
    }
    navStack.pop();
    showTemplateList();
    toast('Template saved!', 4000, 'success');
  } catch (e) {
    toast('Failed to save template: ' + e.message);
  }
}

// ── Settings ──
// PROMPT_DEFAULTS mirrors src/prompts.ts so the UI can show/reset defaults without a round-trip.
// Keep these in sync with the server-side defaults if either changes.
const PROMPT_DEFAULTS = {
  extraction_prompt: [
    'You are a document data extraction engine.',
    'Extract the following fields from the OCR text provided.',
    'If a value is not found, use null.',
    '',
    'Field type rules:',
    '',
    'currency — Return {amount, currency}.',
    '  amount: number in full units (e.g. 1234.56 — never pence/cents/minor units).',
    '  currency: ISO 4217 code (e.g. "USD", "GBP", "EUR", "AUD").',
    '  Infer the code from symbols ($→USD, £→GBP, €→EUR, A$→AUD) or explicit labels.',
    '  If multiple currencies appear for one field, use the primary/total value.',
    '',
    'object — Return a JSON object. Use the field description to determine the expected keys.',
    '  Key names should match the document labels, trimmed and in the original language.',
    '  Only include keys the description calls for — do not dump unrelated sub-fields.',
    '  Monetary sub-values within an object follow the same {amount, currency} rule above.',
    '',
    'array — Return a JSON array.',
    '  If the source is a table (rows with column headers): each element is an object',
    '    whose keys are the column headers (use the document\'s exact header text, trimmed).',
    '    Do NOT include the header row itself, nor subtotal/grand-total rows, as data elements.',
    '  If the source is a simple list (bullets, numbered items): each element is a string or number.',
    '  Monetary cell values within array rows follow the same {amount, currency} rule above.',
    '',
    '{{fields}}',
  ].join('\n'),
  template_builder_prompt: [
    'You are a document data extraction schema designer.',
    'Given a plain-language description of what data to extract — and optionally sample document page images —',
    'generate an extraction template schema.',
    '',
    '*** CRITICAL: currency vs number ***',
    'Use "currency" for EVERY monetary value without exception:',
    '  revenue, sales, income, profit, loss, cost, expense, fee, price, balance, payment,',
    '  tax, total, subtotal, gross, net, salary, wage, asset, liability, equity, cash,',
    '  deposit, withdrawal, invoice amount, loan amount, interest, principal, charge, refund.',
    'Use "number" ONLY for non-monetary numerics: page count, quantity, %, ratio, score, age.',
    'When in doubt between "currency" and "number" — always choose "currency".',
    '"currency" fields are extracted as {amount, currency}. NEVER use "number" for money.',
    '',
    'Choosing the right type:',
    '- "currency" — any monetary/money amount. See CRITICAL rule above.',
    '- "number" — purely non-monetary numeric (count, percentage, quantity, ratio, etc.).',
    '- "date" — any date or date-range value.',
    '- "string" — free-text, names, codes, identifiers, single-line labels.',
    '- "object" — a single structured sub-record with a fixed set of named fields',
    '    (e.g. an address, a reporting period with start/end dates, contact details).',
    '    In the description, list the expected keys so the extraction AI knows what to capture.',
    '- "array" — a repeating list or table.',
    '    Use for line items, transactions, multiple periods, or any data that forms rows in a table.',
    '    In the description, name the expected columns/keys so the extraction AI knows the structure.',
    '    Do not use "array" for a single value that happens to be a total or summary.',
    '',
    'Other guidelines:',
    '- Field titles: concise, 2–4 words',
    '- Descriptions: help the extraction AI locate the value and understand its structure',
    '- required=true only for fields reliably present in every document of this type',
  ].join('\n'),
};
const OCR_BATCH_SIZE_DEFAULT = 16;

async function showSettings() {
  navStack.push('settings');
  showView('viewSettings');
  updateBreadcrumb([{ label: 'Settings' }]);
  try {
    const settings = await api('/settings');
    document.getElementById('settingsExtractionPrompt').value =
      settings.extraction_prompt || PROMPT_DEFAULTS.extraction_prompt;
    document.getElementById('settingsBuilderPrompt').value =
      settings.template_builder_prompt || PROMPT_DEFAULTS.template_builder_prompt;
    document.getElementById('settingsOcrBatchSize').value =
      Number.parseInt(settings.ocr_batch_size, 10) || OCR_BATCH_SIZE_DEFAULT;
  } catch (e) {
    toast('Failed to load settings: ' + e.message);
  }
}

async function saveSettings() {
  const btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const rawBatchSize = Number.parseInt(document.getElementById('settingsOcrBatchSize').value, 10);
  const ocrBatchSize = Number.isFinite(rawBatchSize)
    ? Math.min(16, Math.max(1, rawBatchSize))
    : OCR_BATCH_SIZE_DEFAULT;

  try {
    await api('/settings', {
      method: 'PUT',
      body: JSON.stringify({
        extraction_prompt: document.getElementById('settingsExtractionPrompt').value,
        template_builder_prompt: document.getElementById('settingsBuilderPrompt').value,
        ocr_batch_size: String(ocrBatchSize),
      }),
    });
    document.getElementById('settingsOcrBatchSize').value = ocrBatchSize;
    toast('Settings saved!', 3000, 'success');
  } catch (e) {
    toast('Failed to save settings: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

function resetPrompt(key) {
  if (!confirm('Reset this prompt to the default? Your edits will be lost.')) return;
  const id = key === 'extraction_prompt' ? 'settingsExtractionPrompt' : 'settingsBuilderPrompt';
  document.getElementById(id).value = PROMPT_DEFAULTS[key];
}

// ── Starter templates ──
const STARTERS = [
  {
    name: 'Income Statement',
    doc_type_hint: 'Income statement / P&L',
    fields: [
      { title: 'Revenue', description: 'Total revenue / sales for the period', type: 'currency', required: 1 },
      { title: 'Cost of Goods Sold', description: 'COGS for the period', type: 'currency', required: 0 },
      { title: 'Gross Profit', description: 'Gross profit (Revenue - COGS)', type: 'currency', required: 0 },
      { title: 'Operating Expenses', description: 'Total operating expenses', type: 'currency', required: 0 },
      { title: 'Net Income', description: 'Net income / net profit for the period', type: 'currency', required: 1 },
      { title: 'Period', description: 'Reporting period (e.g. FY2024, Q3 2024)', type: 'string', required: 1 },
    ],
  },
  {
    name: 'Balance Sheet',
    doc_type_hint: 'Balance sheet / Statement of financial position',
    fields: [
      { title: 'Total Assets', description: 'Total assets at period end', type: 'currency', required: 1 },
      { title: 'Total Liabilities', description: 'Total liabilities at period end', type: 'currency', required: 1 },
      { title: 'Total Equity', description: 'Shareholders equity / net worth', type: 'currency', required: 1 },
      { title: 'Cash and Equivalents', description: 'Cash and cash equivalents', type: 'currency', required: 0 },
      { title: 'Current Assets', description: 'Total current assets', type: 'currency', required: 0 },
      { title: 'Current Liabilities', description: 'Total current liabilities', type: 'currency', required: 0 },
      { title: 'Period', description: 'As-of date (e.g. Dec 31, 2024)', type: 'string', required: 1 },
    ],
  },
  {
    name: 'Bank Statement',
    doc_type_hint: 'Bank statement',
    fields: [
      { title: 'Account Holder', description: 'Name of the account holder', type: 'string', required: 1 },
      { title: 'Account Number', description: 'Bank account number (masked OK)', type: 'string', required: 0 },
      { title: 'Statement Period', description: 'Statement date range', type: 'string', required: 1 },
      { title: 'Beginning Balance', description: 'Opening balance for the period', type: 'currency', required: 1 },
      { title: 'Ending Balance', description: 'Closing balance for the period', type: 'currency', required: 1 },
      { title: 'Total Deposits', description: 'Sum of all deposits / credits', type: 'currency', required: 0 },
      { title: 'Total Withdrawals', description: 'Sum of all withdrawals / debits', type: 'currency', required: 0 },
    ],
  },
];

async function seedStarterTemplates() {
  const existing = await api('/templates');
  if (existing.length > 0) return;
  for (const t of STARTERS) {
    await api('/templates', { method: 'POST', body: JSON.stringify(t) });
  }
}

// ── Bucket rename ──
function startRenameBucket() {
  const h2 = document.getElementById('bucketName');
  if (!h2) return;
  const current = currentBucket.name;
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
        await api(`/buckets/${currentBucket.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: newName }),
        });
        currentBucket.name = newName;
      } catch (e) {
        toast('Failed to rename: ' + e.message);
      }
    }
    const newH2 = document.createElement('h2');
    newH2.id = 'bucketName';
    newH2.textContent = currentBucket.name;
    input.replaceWith(newH2);
    document.getElementById('btnRenameBucket').hidden = false;
    updateBreadcrumb([
      { label: 'Buckets', action: 'goHome()' },
      { label: currentBucket.name },
    ]);
  }

  input.addEventListener('keydown', e => {
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

// ── Utils ──
function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Expose to inline handlers
Object.assign(window, {
  goHome, goToTemplates,
  showDashboard, openBucket, showTemplateList, showTemplateEditor,
  editTemplate, deleteTemplate, duplicateTemplate, showNewBucket, saveBucket, deleteBucket,
  renderBucketInfoBar, changeBucketTemplate, applyBucketTemplate, cancelBucketTemplateChange,
  saveTemplate, addFieldRow, goBack, openUploadZone, runExtraction, reRunExtraction,
  runAllPending, toggleJobDetail, deleteJob, previewTemplate,
  showTemplateBuilder, showBuilderInput, generateTemplate,
  addBuilderFieldRow, saveBuiltTemplate, clearBuilderSample,
  openBuilderFromBucketForm, openManualEditorFromBucketForm, returnToNewBucket,
  openBuilderFromBucket, exportBucketCSV, startRenameBucket,
  showSettings, saveSettings, resetPrompt,
  toggleDebugPanel, clearDebugPanel, updateDebugCount,
});

// ── Init ──
await checkHealth();
showDashboard();
