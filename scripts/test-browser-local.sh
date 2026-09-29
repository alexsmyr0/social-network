#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export TEST_RUNTIME_DIR="$work"
export DB_PATH="$work/social.db"
export MEDIA_ROOT="$work/media"
# Dedicated ports; collisions fail without killing or reusing other processes.
export TEST_FRONTEND_PORT="${TEST_FRONTEND_PORT:-3301}"
export TEST_BACKEND_PORT="${TEST_BACKEND_PORT:-18081}"
bun x playwright test "$@"
