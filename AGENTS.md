# EasyExtract

EasyExtract turns PDFs and document images into structured data. One Cloudflare Worker (`easyextract`, entry `src/index.ts`) serves a browser app from `public/` and a JSON API under `/api/`: the browser renders each page to JPEG, the Worker sends pages to Google Cloud Vision for OCR, picks a template, asks OpenAI to extract the template's fields, and stores buckets, templates, jobs and runs in the D1 database `easyextract-db`. It runs at https://easyextract.rick-wills.workers.dev for limited personal use.

## Commands

Run from the repository root. A fresh checkout or cloud session needs `npm ci` first.

| Task | Command |
|---|---|
| Dev server with local D1 (http://localhost:8787) | `npm run dev` (needs `.dev.vars`, copy `.dev.vars.example`) |
| Typecheck | `npm run typecheck` |
| Validate the build without deploying | `npx wrangler deploy --dry-run` |
| Deploy to production | `npm run deploy:safe` |
| Create the local D1 tables | `npm run db:migrate` |
| Regenerate binding types | `npm run cf-typegen` (`wrangler types`) |

`npm run typecheck` and the dry run are the gate for every change; there are no tests. `npm run deploy:safe` (`scripts/deploy-safe.sh`) runs the typecheck, checks that the three secrets exist, deploys, and fails unless `/api/health` reports `ready: true` with every service `true`. Use plain `npm run deploy` only to debug a failed release.

After a deploy, also check that `/` returns the app and `GET /api/templates`, `/api/buckets` and `/api/jobs` return `{ "ok": true }`.

## Layout

- `src/index.ts`: routing for `/api/*`; everything else is a static file or a 404.
- `src/handlers/`: one file per API area (buckets, upload, extract and jobs, templates, the AI template builder, settings).
- `src/services/`: Vision OCR (`documentAi.ts`) and its service-account auth (`auth.ts`), OpenAI extraction (`openai.ts`), template classification (`classification.ts`).
- `src/prompts.ts`: default prompts. `src/types.ts`: row types and the `ok`/`err` response helpers.
- `src/db/schema.sql`: the tables. `src/db/migrations/`: one manual SQL migration (see below).
- `public/`: the browser app (plain ES modules in `public/js/`, pdf.js from cdnjs). Views: Home, Buckets, Jobs (global queue with filters and batch actions), Review (source beside extracted values, CSV export), Templates (manual or AI builder) and Settings (prompts, OCR batch size, classification thresholds).

## Cloudflare

- Worker `easyextract` on account `3c526a82504f460f254335ac81d313dd`, served on workers.dev only; preview URLs are on. Bindings: D1 `DB` (`easyextract-db`, `0dccdc9d-122c-40ce-96c3-4073bcbda09f`) and static assets from `./public` (no binding). Secrets: `OPENAI_API_KEY`, `GCP_SA_KEY` (service account JSON), `GCP_PROJECT_ID`, listed in `secrets.required`; local values go in `.dev.vars`.
- The schema is not managed by Wrangler migrations. `db:migrate` runs `src/db/schema.sql` against the local database only, and the code creates `job_previews` and `job_classifications` itself if they are missing. A schema change needs its SQL run on the remote database with `npx wrangler d1 execute easyextract-db --remote --file=<file>` before deploying code that depends on it.
- Agents deploy and change infrastructure directly. Wrangler (the repository's pinned copy, through the npm scripts or `npx wrangler`) handles deploys, rollbacks, D1 queries, secrets and `wrangler tail`. This project uses Wrangler, so do not run `cf dev`, `cf build`, `cf deploy` or `cf migrate`.
- Cloudflare Code Mode (`cloudflare-api` MCP server) covers the rest of the account: DNS, routes and domains, Worker settings, logs and analytics, other projects, and the Cloudflare docs. Call `search` to find an endpoint, then `execute` with `account_id` set to the account ID above. Results are cut off at about 6,000 tokens, so filter inside the code.
- Both act on production; there is no staging environment. Wrangler and Code Mode read `CLOUDFLARE_API_TOKEN`. The account-wide standard, token permissions and the inventory of every project are in the `Rw1942/cloudflare-account` repo.

## Working here

- Commit to `main` and deploy with `npm run deploy:safe` once the typecheck and dry run pass.
- The app is for limited internal use, so prefer simple, direct code over architecture. Keep the frontend as plain ES modules with no build step.
- The production database holds real uploaded documents and their OCR text. Never delete jobs, runs or templates as part of a code change, and do not print OCR text or extracted values into logs, commits or chat.
- Calls to Vision and OpenAI cost money. Test with a single small document, not a batch.

## Things that are easy to get wrong

- The OCR service file is `documentAi.ts`, but it calls Cloud Vision, not Document AI.
- The API has no authentication: anyone with the URL can list jobs and trigger paid calls. Do not add data or features that assume it is private.
- `/api/health` only reports whether the secrets are set. It does not prove the keys work; `POST /api/templates/build` with a short `description` is the cheapest real OpenAI call.
- The remote `buckets` table still has the legacy `template_id` column; `src/db/migrations/2026-03-18-remove-bucket-template.sql` was only ever run locally. The code no longer reads the column.

## Rules and reference

Rules in `.agents/rules/` hold decisions that are not visible in the code. Claude Code and Antigravity load them automatically; other agents should read the one that matches the files they are changing.

- `.agents/rules/writing-style.md`: the owner's writing rules for copy, docs, commit messages and replies.
- `.agents/rules/worker.md`: Worker conventions (response shape, routing, validation, timeouts, logging, secrets, schema).
- `.agents/rules/providers.md`: Cloud Vision OCR and the OpenAI calls (auth, batching, error mapping, models, what is sent).
