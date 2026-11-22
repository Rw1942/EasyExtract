---
trigger: glob
globs: "src/services/**, src/handlers/**, src/prompts.ts"
paths:
  - "src/services/**"
  - "src/handlers/**"
  - "src/prompts.ts"
---

# OCR and model calls

## Google Cloud Vision (`src/services/documentAi.ts`, `src/services/auth.ts`)

The file is named for Document AI, but OCR uses the Cloud Vision `images:annotate` REST endpoint with `DOCUMENT_TEXT_DETECTION`.

- Up to 16 base64 page images per request (the `ocr_batch_size` setting can lower it); pages are joined with a `--- Page Break ---` line.
- Auth is a service account: `GCP_SA_KEY` holds its JSON, the Worker signs a JWT with `crypto.subtle` and exchanges it for an access token, cached in memory per isolate. Never rely on `gcloud` or commit the key. `x-goog-user-project` is set from `GCP_PROJECT_ID` for billing.
- Upstream errors map to: 401/403 as 502 `UPSTREAM_AUTH_FAILED`, 400 as 400 `INVALID_DOCUMENT`, 429 as 503 `UPSTREAM_RATE_LIMITED`, other failures as 502 `UPSTREAM_ERROR`.

## OpenAI (`src/services/openai.ts`, `src/services/classification.ts`, `src/handlers/buildTemplate.ts`)

- All calls use the Responses API with a strict JSON schema output format and `OPENAI_API_KEY`.
- Extraction sends the OCR text and the template's fields (model `gpt-5.2`, temperature 0), never the original file. Classification (`classification_mode`, default `hybrid`) scores templates from text signals first and asks `gpt-5.4-nano` (falling back to `gpt-5-nano`) only when the top score or its margin over the second is below the escalation settings. The template builder sends a description and up to three sample page images.
- Prompts live in `src/prompts.ts`; the extraction and builder prompts can be overridden from Settings (stored in the `settings` table).
- Parse the model output as JSON and return a structured error when it fails. Never log or return the API key.
