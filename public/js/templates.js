import { state, invalidateTemplateCache } from './state.js';
import { api, toast, esc, STATUS_LABELS } from './shared.js';
import { showView, updateBreadcrumb, goToTemplates, goBack } from './navigation.js';

const OCR_BATCH_SIZE_DEFAULT = 16;
let builderPages = [];

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

const PROMPT_DEFAULTS = {
  extraction_prompt: 'You are a document data extraction engine.\n{{fields}}',
  template_builder_prompt: 'You are a document data extraction schema designer.',
};

export async function seedStarterTemplates() {
  const existing = await api('/templates');
  if (existing.length > 0) return;
  for (const t of STARTERS) {
    await api('/templates', { method: 'POST', body: JSON.stringify(t) });
  }
}

export async function showTemplateList() {
  if (state.navStack[state.navStack.length - 1] !== 'templateList') state.navStack.push('templateList');
  showView('viewTemplateList');
  updateBreadcrumb([{ label: 'Templates' }]);
  const templates = await api('/templates');
  const grid = document.getElementById('templateGrid');
  if (!templates.length) {
    grid.innerHTML = '<p class="empty-state">No templates yet. Create your first one to start extracting data from PDFs.</p>';
    return;
  }
  grid.innerHTML = templates.map((t) => `<div class="card" onclick="showTemplateDetail('${t.id}')"><h3>${esc(t.name)}</h3><p>${esc(t.doc_type_hint || 'General document')}</p><div class="card-actions"><button class="small" onclick="event.stopPropagation(); editTemplate('${t.id}')">Edit Fields</button><button class="small" onclick="event.stopPropagation(); duplicateTemplate('${t.id}')">Duplicate</button><button class="small danger" onclick="event.stopPropagation(); deleteTemplate('${t.id}')">Delete</button></div></div>`).join('');
}

export function showTemplateEditor(id) {
  state.editingTemplateId = id || null;
  state.navStack.push('templateEditor');
  showView('viewTemplateEditor');
  updateBreadcrumb([{ label: 'Templates', action: 'goToTemplates()' }, { label: id ? 'Edit Template' : 'New Template' }]);
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
  (t.fields || []).forEach((f) => addFieldRow(f));
}

export function addFieldRow(f, containerId = 'fieldsList') {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.innerHTML = `<input type="text" placeholder="Field title" value="${esc(f?.title || '')}" class="f-title" required><input type="text" placeholder="Description" value="${esc(f?.description || '')}" class="f-desc"><select class="f-type">${['string', 'number', 'currency', 'date', 'object', 'array'].map((t) => `<option value="${t}" ${f?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select><label class="field-req-label"><input type="checkbox" class="f-req" ${f?.required ? 'checked' : ''}> Req</label><button type="button" onclick="this.closest('.field-row').remove()">&times;</button>`;
  document.getElementById(containerId).appendChild(div);
}

export async function saveTemplate(e) {
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
  })).filter((f) => f.title);

  try {
    invalidateTemplateCache();
    if (state.editingTemplateId) {
      await api(`/templates/${state.editingTemplateId}`, { method: 'PUT', body: JSON.stringify({ name, doc_type_hint, fields }) });
      goBack();
    } else {
      const saved = await api('/templates', { method: 'POST', body: JSON.stringify({ name, doc_type_hint, fields }) });
      if (state.afterTemplateSaved) {
        const cb = state.afterTemplateSaved;
        state.afterTemplateSaved = null;
        cb(saved.id);
      } else {
        goBack();
      }
    }
  } catch (e) {
    toast('Failed to save template: ' + e.message);
  }
}

export function editTemplate(id) { showTemplateEditor(id); }

export async function deleteTemplate(id) {
  if (!confirm('Delete this template permanently?')) return;
  try {
    invalidateTemplateCache();
    await api(`/templates/${id}`, { method: 'DELETE' });
    showTemplateList();
  } catch (e) {
    toast('Failed to delete template: ' + e.message);
  }
}

export async function duplicateTemplate(id) {
  try {
    invalidateTemplateCache();
    const t = await api(`/templates/${id}`);
    await api('/templates', { method: 'POST', body: JSON.stringify({ name: `Copy of ${t.name}`, doc_type_hint: t.doc_type_hint, fields: t.fields }) });
    showTemplateList();
    toast('Template duplicated successfully.', 3000, 'success');
  } catch (e) {
    toast('Failed to duplicate template: ' + e.message);
  }
}

export async function showNewBucket() {
  state.navStack.push('newBucket');
  showView('viewNewBucket');
  updateBreadcrumb([{ label: 'Buckets', action: 'goHome()' }, { label: 'New Bucket' }]);
}

export async function saveBucket(e) {
  e.preventDefault();
  const name = document.getElementById('bucketNameInput').value.trim();
  if (!name) { toast('Please enter a bucket name.'); return; }
  await api('/buckets', { method: 'POST', body: JSON.stringify({ name }) });
  state.navStack.pop();
  window.showDashboard();
}

export async function deleteBucket(id) {
  if (!confirm('Delete this bucket and all its documents? This can\'t be undone.')) return;
  await api(`/buckets/${id}`, { method: 'DELETE' });
  window.showDashboard();
}

export function showTemplateBuilder() {
  if (state.navStack[state.navStack.length - 1] !== 'templateBuilder') state.navStack.push('templateBuilder');
  showView('viewTemplateBuilder');
  updateBreadcrumb([{ label: 'Templates', action: 'goToTemplates()' }, { label: 'Build with AI' }]);
  showBuilderInput();
}

export function showBuilderInput() {
  document.getElementById('builderInput').hidden = false;
  document.getElementById('builderGenerating').hidden = true;
  document.getElementById('builderReview').hidden = true;
}

async function loadBuilderSample(file) {
  const info = document.getElementById('builderFileInfo');
  const prompt = document.getElementById('builderDropPrompt');
  const loaded = document.getElementById('builderFileLoaded');
  info.textContent = `${file.name} — rasterizing…`;
  prompt.hidden = true;
  loaded.hidden = false;
  try {
    if (file.type === 'application/pdf') {
      const allPages = await window.rasterizePdf(file);
      builderPages = allPages.slice(0, 3);
    } else {
      builderPages = [await fileToBase64(file)];
    }
    info.textContent = `${file.name} (${builderPages.length} page${builderPages.length !== 1 ? 's' : ''} ready)`;
  } catch (e) {
    info.textContent = `Failed to load: ${e.message}`;
    builderPages = [];
  }
}

async function fileToBase64(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
  return String(dataUrl).split(',')[1];
}

export function clearBuilderSample() {
  builderPages = [];
  const input = document.getElementById('builderFileInput');
  input.value = '';
  document.getElementById('builderDropPrompt').hidden = false;
  document.getElementById('builderFileLoaded').hidden = true;
}

export async function generateTemplate() {
  const desc = document.getElementById('builderDesc').value.trim();
  if (!desc) { toast('Describe the data you want to extract first.'); return; }

  document.getElementById('builderInput').hidden = true;
  document.getElementById('builderGenerating').hidden = false;
  document.getElementById('builderReview').hidden = true;

  const statusEl = document.getElementById('builderGenStatus');
  const subEl = document.getElementById('builderGenSub');
  statusEl.textContent = builderPages.length > 0 ? 'AI is analyzing your document and description…' : 'AI is designing your template…';
  subEl.textContent = 'Usually takes 5–15 seconds.';

  try {
    const result = await api('/templates/build', { method: 'POST', body: JSON.stringify({ description: desc, ...(builderPages.length > 0 && { pages: builderPages }) }) });
    document.getElementById('builderName').value = result.name || '';
    document.getElementById('builderDocType').value = result.doc_type_hint || '';
    document.getElementById('builderFieldsList').innerHTML = '';
    (result.fields || []).forEach((f) => addBuilderFieldRow(f));
    document.getElementById('builderGenerating').hidden = true;
    document.getElementById('builderReview').hidden = false;
  } catch (e) {
    toast('Generation failed: ' + e.message);
    showBuilderInput();
  }
}

export function addBuilderFieldRow(f) { addFieldRow(f, 'builderFieldsList'); }

export async function saveBuiltTemplate(e) {
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
  })).filter((f) => f.title);

  try {
    invalidateTemplateCache();
    const saved = await api('/templates', { method: 'POST', body: JSON.stringify({ name, doc_type_hint, fields }) });
    if (state.afterTemplateSaved) {
      const cb = state.afterTemplateSaved;
      state.afterTemplateSaved = null;
      cb(saved.id);
      return;
    }
    state.navStack.pop();
    showTemplateList();
    toast('Template saved successfully.', 4000, 'success');
  } catch (e) {
    toast('Failed to save template: ' + e.message);
  }
}

export async function showSettings() {
  state.navStack.push('settings');
  showView('viewSettings');
  updateBreadcrumb([{ label: 'Settings' }]);
  try {
    const settings = await api('/settings');
    document.getElementById('settingsExtractionPrompt').value = settings.extraction_prompt || PROMPT_DEFAULTS.extraction_prompt;
    document.getElementById('settingsBuilderPrompt').value = settings.template_builder_prompt || PROMPT_DEFAULTS.template_builder_prompt;
    document.getElementById('settingsOcrBatchSize').value = Number.parseInt(settings.ocr_batch_size, 10) || OCR_BATCH_SIZE_DEFAULT;
  } catch (e) {
    toast('Failed to load settings: ' + e.message);
  }
}

export async function saveSettings() {
  const btn = document.getElementById('settingsSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const rawBatchSize = Number.parseInt(document.getElementById('settingsOcrBatchSize').value, 10);
  const ocrBatchSize = Number.isFinite(rawBatchSize) ? Math.min(16, Math.max(1, rawBatchSize)) : OCR_BATCH_SIZE_DEFAULT;

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
    toast('Settings saved.', 3000, 'success');
  } catch (e) {
    toast('Failed to save settings: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

export function resetPrompt(key) {
  if (!confirm('Reset to default? Your custom instructions will be replaced.')) return;
  const id = key === 'extraction_prompt' ? 'settingsExtractionPrompt' : 'settingsBuilderPrompt';
  document.getElementById(id).value = PROMPT_DEFAULTS[key];
}

export async function showTemplateDetail(id, isBack) {
  state.viewingTemplateId = id;
  if (!isBack) state.navStack.push('templateDetail:' + id);
  showView('viewTemplateDetail');

  try {
    const t = await api(`/templates/${id}`);
    document.getElementById('templateDetailName').textContent = t.name;
    document.getElementById('templateDetailHint').textContent = t.doc_type_hint || 'General document';
    updateBreadcrumb([{ label: 'Templates', action: 'goToTemplates()' }, { label: t.name }]);

    const fieldsEl = document.getElementById('templateDetailFields');
    const fields = t.fields || [];
    fieldsEl.innerHTML = `<h3>Fields (${fields.length})</h3><div class="field-pills">${fields.map((f) => `<span class="field-pill ${f.required ? 'required' : ''}" title="${esc(f.description || '')}${f.type ? ` (${f.type})` : ''}">${esc(f.title)}<span class="field-pill-type">${f.type}</span></span>`).join('')}</div>`;

    const bucketsEl = document.getElementById('templateDetailBuckets');
    const buckets = t.buckets_using || [];
    bucketsEl.innerHTML = `<h3>Historically used in ${buckets.length} bucket${buckets.length !== 1 ? 's' : ''}</h3>${buckets.length ? buckets.map((b) => `<a class="bucket-link" onclick="openBucket('${b.id}')">${esc(b.name)}${Number(b.run_count) ? ` (${b.run_count})` : ''}</a>`).join('') : '<p class="detail-muted">No extraction history yet for this template.</p>'}`;

    const runsEl = document.getElementById('templateDetailRuns');
    const runs = t.recent_runs || [];
    runsEl.innerHTML = runs.length
      ? `<h3>Recent Extractions</h3><table class="template-runs-table"><thead><tr><th>File</th><th>Bucket</th><th>Status</th><th>Date</th></tr></thead><tbody>${runs.map((r) => `<tr><td>${esc(r.filename || '—')}</td><td>${esc(r.bucket_name || '—')}</td><td><span class="status-badge status-${r.status}">${STATUS_LABELS[r.status] || r.status}</span></td><td class="date-cell">${new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>`).join('')}</tbody></table>`
      : '<h3>Recent Extractions</h3><p class="detail-muted">No extractions yet. Upload documents to a bucket using this template to see results here.</p>';
  } catch (e) {
    toast('Failed to load template: ' + e.message);
  }
}

export function initTemplateDomHandlers() {
  const builderDropArea = document.getElementById('builderDropArea');
  const builderFileInput = document.getElementById('builderFileInput');

  if (builderDropArea) {
    builderDropArea.addEventListener('dragover', (e) => { e.preventDefault(); builderDropArea.classList.add('dragover'); });
    builderDropArea.addEventListener('dragleave', () => builderDropArea.classList.remove('dragover'));
    builderDropArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      builderDropArea.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file && (file.type === 'application/pdf' || file.type.startsWith('image/'))) {
        await loadBuilderSample(file);
      }
    });
  }

  if (builderFileInput) {
    builderFileInput.addEventListener('change', async () => {
      if (builderFileInput.files[0]) await loadBuilderSample(builderFileInput.files[0]);
    });
  }
}

export function getViewingTemplateId() {
  return state.viewingTemplateId;
}

export function exposeTemplateActions() {
  return {
    goToTemplates,
    showTemplateList,
    showTemplateEditor,
    editTemplate,
    deleteTemplate,
    duplicateTemplate,
    showNewBucket,
    saveBucket,
    deleteBucket,
    saveTemplate,
    addFieldRow,
    showTemplateBuilder,
    showBuilderInput,
    generateTemplate,
    addBuilderFieldRow,
    saveBuiltTemplate,
    clearBuilderSample,
    showSettings,
    saveSettings,
    resetPrompt,
    showTemplateDetail,
    getViewingTemplateId,
  };
}
