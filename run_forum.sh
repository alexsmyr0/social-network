#!/usr/bin/env bash
set -e

echo "🚀 Starting Forum Project (backend + frontend)..."

make run-backend &
BACKEND_PID=$!

make run-frontend &
FRONTEND_PID=$!

trap "echo '🛑 Stopping servers...'; kill $BACKEND_PID $FRONTEND_PID" INT TERM

wait
