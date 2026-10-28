#!/usr/bin/env bash
# SN-A21: real two-image upgrade. Builds the last pre-Phase-5 backend from git,
# seeds earlier-phase data through it, then starts the current images on the
# same project volume and verifies the data, the permissions and Phase 5 on it.
set -euo pipefail
cd "$(dirname "$0")/.."
docker info >/dev/null
# Phase 4 head (migration 000007): accounts, sessions, avatars, follows, notices,
# post/comment/DM images, groups with every membership state, drafts, reactions.
rev="${LEGACY_REV:-025c849ef451ab641929f3e03d9779c03e85903a}"
if ! git cat-file -e "$rev^{commit}" 2>/dev/null; then
  git fetch --no-tags --depth=1 origin "$rev"
fi
rev="$(git rev-parse "$rev^{commit}")"
export COMPOSE_PROJECT_NAME="sn-b07-test-$$"
export FRONTEND_PORT="${TEST_UPGRADE_PORT:-3308}"
legacy_image="sn-b07-legacy-$$"
work="$(mktemp -d)"
compose=(docker compose --env-file /dev/null -f compose.yaml)
legacy=(docker compose --env-file /dev/null -f compose.yaml -f "$work/legacy.yaml")
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs --no-color --tail=100 || true; fi
  "${compose[@]}" down --volumes --remove-orphans || result=1
  docker rmi -f "$legacy_image" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$work/legacy.yaml" <<YAML
services:
  backend:
    image: $legacy_image
YAML
echo "building legacy backend from $rev"
git archive "$rev" | docker build -q -t "$legacy_image" - >/dev/null
export PLAYWRIGHT_BASE_URL="http://localhost:$FRONTEND_PORT"
export A21_UPGRADE_STATE="$work/state.json"
export A21_LEGACY_REV="$rev"
"${legacy[@]}" up --no-build --wait --wait-timeout 120
A21_PHASE=seed bun x playwright test --config playwright.upgrade.config.ts
# Stop the legacy writers, then start the current images on the same volume.
"${legacy[@]}" stop backend frontend
"${compose[@]}" up -d --no-build --force-recreate --wait --wait-timeout 120 backend frontend
A21_PHASE=verify bun x playwright test --config playwright.upgrade.config.ts
echo "upgrade from $rev through both current images passed"
