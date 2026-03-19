#!/usr/bin/env bash
set -euo pipefail

HEALTH_URL="${HEALTH_URL:-https://easyextract.rick-wills.workers.dev/api/health}"
if [[ "${1:-}" == "--url" && -n "${2:-}" ]]; then
  HEALTH_URL="${2%/}/api/health"
fi

echo "==> Safe deploy: preflight checks"
npm run typecheck

echo "==> Checking required Wrangler secrets"
SECRETS_JSON="$(npx wrangler secret list)"

for key in OPENAI_API_KEY GCP_SA_KEY GCP_PROJECT_ID; do
  if [[ "$SECRETS_JSON" != *"\"name\": \"$key\""* ]]; then
    echo "ERROR: Missing required secret: $key"
    echo "Run: npx wrangler secret put $key"
    exit 1
  fi
done

echo "==> Deploying Worker"
npm run deploy

echo "==> Verifying health at: $HEALTH_URL"
HEALTH_BODY="$(curl -s "$HEALTH_URL")"

node -e '
const body = process.argv[1];
let json;
try {
  json = JSON.parse(body);
} catch {
  console.error("ERROR: /api/health returned non-JSON");
  console.error(body);
  process.exit(1);
}
const s = json?.data?.services ?? {};
const ok = json?.data?.ready === true
  && s.openai === true
  && s.gcp_sa === true
  && s.gcp_project === true
  && s.db === true;
if (!ok) {
  console.error("ERROR: Health check failed");
  console.error(JSON.stringify(json, null, 2));
  process.exit(1);
}
console.log("Health check passed.");
' "$HEALTH_BODY"

echo "==> Safe deploy completed successfully"
