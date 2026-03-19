let worker = null;
let reqCounter = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;

  worker = new Worker('/js/pageClassifierWorker.js', { type: 'module' });
  worker.onmessage = (event) => {
    const msg = event.data || {};
    const entry = pending.get(msg.requestId);
    if (!entry) return;

    if (msg.type === 'progress') {
      entry.onProgress?.(msg.progress || {});
      return;
    }

    if (msg.type === 'done') {
      pending.delete(msg.requestId);
      entry.resolve(msg.report);
      return;
    }

    if (msg.type === 'error') {
      pending.delete(msg.requestId);
      entry.reject(new Error(msg.message || 'Page classification failed'));
    }
  };

  worker.onerror = (event) => {
    for (const [requestId, entry] of pending.entries()) {
      pending.delete(requestId);
      entry.reject(new Error(event.message || 'Classifier worker crashed'));
    }
  };

  return worker;
}

export function classifyPagesInWorker(payload, onProgress) {
  const activeWorker = ensureWorker();
  const requestId = `req_${Date.now()}_${reqCounter++}`;

  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress });
    activeWorker.postMessage({ requestId, payload });
  });
}
