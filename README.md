# EasyExtract

Last updated: 2026-03-18 20:19:29 MDT

Turn PDFs and document images into structured data using a Cloudflare Worker.

## What You Need
- A Cloudflare account
- Node.js 18+
- This repo cloned locally

## First Deploy (Cloudflare Beginner Path)
1. Install dependencies

```bash
npm install
```

2. Log in to Cloudflare

```bash
npx wrangler login
```

3. Create your D1 database (one time)

```bash
npx wrangler d1 create easyextract-db
```

4. Update `wrangler.toml`
- Set `database_id` to the ID returned by the create command.
- Keep `binding = "DB"`.

5. Create required secrets (one time)

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GCP_SA_KEY
npx wrangler secret put GCP_PROJECT_ID
```

6. Deploy safely

```bash
npm run deploy:safe
```

That command runs typecheck, verifies required secrets, deploys, and checks `/api/health`.

## Local Development
1. Add local vars in `.dev.vars`

```env
OPENAI_API_KEY=...
GCP_SA_KEY={...json...}
GCP_PROJECT_ID=...
```

2. Start local server

```bash
npm run dev
```

## Daily Commands
```bash
npm run dev          # local app
npm run typecheck    # TypeScript check
npm run deploy:safe  # production deploy with health validation
```

## Troubleshooting
- `Missing required secret`: run `npx wrangler secret put <NAME>`
- `no such table`: ensure your D1 DB is created and `database_id` is correct in `wrangler.toml`
- Deploy health failure: open `/api/health` and confirm all services are `true`
