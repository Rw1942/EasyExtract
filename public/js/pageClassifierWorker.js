import { classifyOcrPagesDetailed } from './pageClassifier.js';

self.onmessage = (event) => {
  const { requestId, payload } = event.data || {};
  if (!requestId || !payload) return;

  try {
    const startedAt = Date.now();
    const report = classifyOcrPagesDetailed(
      payload.ocrText,
      payload.templates,
      payload.options || {},
      (progress) => {
        self.postMessage({
          type: 'progress',
          requestId,
          progress,
        });
      },
    );

    self.postMessage({
      type: 'done',
      requestId,
      report: {
        ...report,
        meta: {
          ...(report.meta || {}),
          duration_ms: Date.now() - startedAt,
        },
      },
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : 'Page classification failed',
    });
  }
};
