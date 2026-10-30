#!/usr/bin/env bash
# Builds the backend and frontend images, starts both containers and opens the
# app. Docker must already be running; this script never starts the daemon.
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker is not running. Start Docker, then run this script again." >&2
    exit 1
fi

echo "🐳 Building images and starting the backend and frontend containers..."
make stack-up

PROJECT="${COMPOSE_PROJECT_NAME:-social-network}"
URL="http://localhost:${FRONTEND_PORT:-3000}"

echo "📦 Containers:"
docker ps -a --size \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Size}}'

echo "🌍 Opening $URL"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "$URL" >/dev/null 2>&1 || true
elif [[ "$OSTYPE" == "darwin"* ]]; then
    open "$URL"
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
    start "$URL"
fi

echo "🛑 Stop with 'make stack-down' (accounts and media are kept)."
