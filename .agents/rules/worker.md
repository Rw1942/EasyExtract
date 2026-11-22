---
trigger: glob
globs: "src/**, wrangler.jsonc"
paths:
  - "src/**"
  - "wrangler.jsonc"
---

# Worker conventions

- The Worker stays thin and IO-bound: it calls Google Cloud Vision and OpenAI and stores results in D1. Heavy parsing stays out of it; PDFs are rendered to JPEG pages in the browser (pdf.js) before upload.
- Every `/api/*` response uses the shared shape from `src/types.ts`: `ok(data, meta?)` gives `{ ok: true, data, meta }` and `err(status, code, message, details?)` gives `{ ok: false, error: { code, message, details } }`. Use those helpers rather than building responses by hand.
- Routes are matched in order in `src/index.ts`; specific paths (`/api/jobs`, `/api/templates/build`) come before the catch-alls. Handlers live in `src/handlers/`, provider calls in `src/services/`.
- Validate content type, size and required fields and reject bad input early with a 400.
- Every outbound `fetch` has an explicit timeout through `AbortController` (60 s for Vision and the template builder, 95 s for extraction, 45 s for classification).
- Prefer Web Platform APIs (`fetch`, `crypto.subtle`, `atob`/`btoa`). Node.js compatibility is on by default at this compatibility date, but nothing here needs it.
- Log one line per failure with the job ID and error message. Never log API keys, the service account JSON, raw documents or OCR text.
- Secrets come from Wrangler secrets in production and `.dev.vars` locally; never put them in `wrangler.jsonc` or the code.
- Tables are created by `src/db/schema.sql` (and `CREATE TABLE IF NOT EXISTS` in the code for `job_previews` and `job_classifications`). There is no Wrangler migrations folder; see AGENTS.md before changing the schema.
