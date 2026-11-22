# EasyExtract

Turns PDFs and document images into structured data. A Cloudflare Worker runs OCR with Google
Cloud Vision, extracts the fields a template defines with OpenAI, and keeps buckets, templates and
jobs in D1. The browser app is served from `public/`. Live at
https://easyextract.rick-wills.workers.dev.

## Run it

Needs Node.js 22 or later and `CLOUDFLARE_API_TOKEN` in the environment for anything remote.

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill in the OpenAI key and Google service account
npm run db:migrate               # create the local D1 tables
npm run dev                      # http://localhost:8787
```

Deploy with `npm run deploy:safe`: it typechecks, confirms the secrets `OPENAI_API_KEY`,
`GCP_SA_KEY` and `GCP_PROJECT_ID` exist (`npx wrangler secret put <NAME>` sets one), deploys, and
checks `/api/health`.

Coding agents start with `AGENTS.md`.
