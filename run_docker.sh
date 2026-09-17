#!/usr/bin/env bash
set -e

echo "🛑 Stopping existing container (if any)..."
make docker-stop || true

echo "🐳 Building Docker image..."
make docker-build

echo "🚀 Starting Docker container..."
make docker-run

URL="http://localhost:8080"
echo "🌍 Opening browser at $URL"

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "$URL" >/dev/null 2>&1 || true
elif [[ "$OSTYPE" == "darwin"* ]]; then
    open "$URL"
elif [[ "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
    start "$URL"
fi

echo "📜 Container is running. Use 'docker ps -a' to verify."
