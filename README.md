# EasyExtract

Cloudflare Worker API for OCR + structured extraction.

## Deployments (use this, always)

Use the safe deploy command:

`npm run deploy:safe`

This command is the standard release path. It runs:
- Typecheck
- Required secret verification (`OPENAI_API_KEY`, `GCP_SA_KEY`, `GCP_PROJECT_ID`)
- Worker deploy
- Live `/api/health` validation

If any step fails, deployment exits with a clear error.

## First-time production setup

Set required secrets once:

- `npx wrangler secret put OPENAI_API_KEY`
- `npx wrangler secret put GCP_SA_KEY`
- `npx wrangler secret put GCP_PROJECT_ID`

Then deploy with:

`npm run deploy:safe`

## Optional health URL override

If you need to target a different Worker URL:

- `HEALTH_URL=https://<worker-domain>/api/health npm run deploy:safe`
- or `./scripts/deploy-safe.sh --url https://<worker-domain>`
