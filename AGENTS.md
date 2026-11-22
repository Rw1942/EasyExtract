# Notes for coding agents

EasyExtract turns PDFs and document images into structured data: a Cloudflare Worker (`easyextract`, entry `src/index.ts`) sends each document to Google Document AI for OCR and then to OpenAI for extraction, stores buckets, templates and jobs in the D1 database `easyextract-db` (binding `DB`), and serves the browser app from `public/`. The README covers setup and daily commands, and the Cursor rules in `.cursor/rules/` hold the project's conventions, including the safe deploy procedure.

## Cloudflare operations

Agents deploy and change infrastructure directly. Two tools cover it, and both authenticate with the `CLOUDFLARE_API_TOKEN` environment variable for account `3c526a82504f460f254335ac81d313dd`:

- **Wrangler** (`npx wrangler`, installed with `npm install`) for anything tied to `wrangler.toml`: deploys, versions and rollback, D1 migrations and queries, secrets, and `wrangler tail`. Use the project's own scripts when one fits (`npm run deploy:safe` for releases, which runs the typecheck, checks the required secrets, deploys and verifies `/api/health`; `npm run dev`, `npm run typecheck`, and the `db:migrate` scripts, which run against the local database).
- **Cloudflare Code Mode MCP** (`cloudflare-api` in `.mcp.json`) for the rest of the account: DNS, routes and custom domains, zone and Worker settings, analytics, other Workers and their resources, and the Cloudflare docs. Call `search` to find the endpoint, then `execute` with `account_id` set to the account ID above. `docs` searches the developer docs. Results are cut off at about 6,000 tokens, so filter inside the code instead of returning whole lists.

Both act on production, since `wrangler.toml` defines no other environment. `.claude/settings.json` allows these tools without prompts and still asks before a force push or deleting a Worker, database, bucket or namespace. Account-wide setup, token permissions and the inventory of every project are in the `Rw1942/cloudflare-account` repo, `docs/agent-setup.md`.
