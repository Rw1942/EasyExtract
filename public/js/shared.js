import { state } from './state.js';

const API = '/api';
const debugState = { collapsed: false };

export const STATUS_LABELS = {
  ocr: 'Processing',
  pending: 'Ready',
  extracting: 'Extracting',
  done: 'Extracted',
  error: 'Failed',
};

export function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function debugLog(msg, type = 'info') {
  const messages = document.getElementById('debugPanelMessages');
  const bar = document.getElementById('debugPanelBar');
  if (!messages || !bar) return;
  const el = document.createElement('div');
  el.className = `debug-log debug-log-${type}`;
  el.innerHTML = `<span>${msg}</span><button onclick="this.closest('.debug-log').remove(); window.updateDebugCount()" title="Dismiss">&times;</button>`;
  messages.appendChild(el);
  bar.hidden = false;
  updateDebugCount();
  if (!debugState.collapsed) messages.scrollTop = messages.scrollHeight;
}

export function updateDebugCount() {
  const messages = document.getElementById('debugPanelMessages');
  const label = document.getElementById('debugPanelLabel');
  const bar = document.getElementById('debugPanelBar');
  if (!messages || !label || !bar) return;
  const count = messages.children.length;
  label.textContent = count ? `Debug (${count})` : 'Debug';
  if (!count) bar.hidden = true;
}

export function toggleDebugPanel() {
  debugState.collapsed = !debugState.collapsed;
  const messages = document.getElementById('debugPanelMessages');
  const btn = document.getElementById('debugCollapseBtn');
  if (!messages || !btn) return;
  messages.hidden = debugState.collapsed;
  btn.innerHTML = debugState.collapsed ? '&#9650;' : '&#9660;';
}

export function clearDebugPanel() {
  const messages = document.getElementById('debugPanelMessages');
  if (!messages) return;
  messages.innerHTML = '';
  updateDebugCount();
}

export async function api(path, opts = {}) {
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

export function toast(msg, duration = 5000, type = 'error') {
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

export async function checkHealth() {
  try {
    state.healthStatus = await api('/health');
  } catch {
    state.healthStatus = { ready: false, services: {} };
  }
}

export function formatCurrency(amount, currencyCode) {
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

export function formatResultVal(val, depth = 0) {
  if (val === null || val === undefined) return `<span class="rval-null">—</span>`;
  if (typeof val === 'boolean') return `<span class="rval-bool">${val}</span>`;
  if (typeof val === 'number') return `<span class="rval-number">${val.toLocaleString()}</span>`;

  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length > 1 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) return formatResultVal(parsed, depth);
      } catch {
        // no-op
      }
    }
  }

  if (typeof val === 'object' && !Array.isArray(val) && typeof val.amount === 'number' && typeof val.currency === 'string') {
    return formatCurrency(val.amount, val.currency);
  }

  if (Array.isArray(val)) {
    if (!val.length) return `<span class="rval-null">—</span>`;
    const objectItems = val.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (objectItems.length > 0) {
      const keys = [...new Set(objectItems.flatMap((item) => Object.keys(item)))];
      return `<table class="rval-table"><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${objectItems.map((row) => `<tr>${keys.map((k) => `<td>${formatResultVal(row[k], depth + 1)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    return val.map((item) => formatResultVal(item, depth + 1)).join(', ');
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val);
    if (!entries.length) return `<span class="rval-null">—</span>`;
    return `<table class="rval-table"><tbody>${entries.map(([k, v]) => `<tr><td class="rval-table-key">${esc(k)}</td><td>${formatResultVal(v, depth + 1)}</td></tr>`).join('')}</tbody></table>`;
  }

  return esc(String(val)).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/_(.*?)_/g, '<em>$1</em>').replace(/\n/g, '<br>');
}

export function renderSingleRun(run) {
  if (run.status === 'error') {
    return `<div class="detail-error-box"><strong>Something went wrong</strong><p>${esc(run.error || 'An unexpected error occurred. Try re-extracting or using a different template.')}</p></div>`;
  }

  let result = run.result;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      // no-op
    }
  }
  if (!result || typeof result !== 'object') return `<div class="detail-empty">No data was found in this document.</div>`;

  const entries = Object.entries(result);
  if (!entries.length) return `<div class="detail-empty">The document was processed but no matching fields were found. Try adjusting your template.</div>`;

  return `<table class="result-fields"><tbody>${entries.map(([key, val]) => `<tr><td class="result-key">${esc(key)}</td><td class="result-val">${formatResultVal(val)}</td></tr>`).join('')}</tbody></table>`;
}

export function switchRunTab(tab, idx) {
  const container = tab.closest('.job-detail-inner') || tab.closest('#reviewRuns');
  if (!container) return;
  container.querySelectorAll('.run-tab').forEach((t) => t.classList.remove('active'));
  container.querySelectorAll('.run-panel').forEach((p) => p.classList.remove('active'));
  tab.classList.add('active');
  container.querySelector(`.run-panel[data-run-idx="${idx}"]`)?.classList.add('active');
}
