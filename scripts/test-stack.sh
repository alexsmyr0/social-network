#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker info >/dev/null
# Never inherit the developer stack's project or data. Do not delete its volumes.
export COMPOSE_PROJECT_NAME="sn-b07-test-$$"
export FRONTEND_PORT="${TEST_STACK_PORT:-3307}"
compose=(docker compose --env-file /dev/null -f compose.yaml)
work="$(mktemp -d)"
cleanup() {
  result=$?
  trap - EXIT
  rm -rf "$work"
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --no-color --tail=100 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${compose[@]}" up --no-build --wait --wait-timeout 120
export PLAYWRIGHT_BASE_URL="http://localhost:$FRONTEND_PORT"
bun x playwright test --config playwright.integration.config.ts "$@"
# Frontend stays ready and returns the handoff's explicit outage envelope.
"${compose[@]}" stop backend
curl --fail --silent --show-error "$PLAYWRIGHT_BASE_URL/healthz" >/dev/null
status="$(curl --silent --show-error --output "$work/outage.json" --write-out '%{http_code}' \
  "$PLAYWRIGHT_BASE_URL/api/v1/users/me")"
[ "$status" = 502 ]
python3 - "$work/outage.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))['error']['code'] == 'BACKEND_UNAVAILABLE'
PY
echo 'two-image transport and outage smoke passed'
