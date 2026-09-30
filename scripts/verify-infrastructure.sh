#!/bin/bash
set -e

# scripts/verify-infrastructure.sh
# Purpose: Automate DevOps/Infrastructure sanity checks

echo "🔍 Starting Infrastructure Sanity Checks..."

# 1. Verify fresh bootstrap
echo "📦 Verifying bootstrap (make deps)..."
rm -rf node_modules
make deps
echo "✅ Bootstrap successful."

# 2. Verify build
echo "🏗️ Verifying build (make build)..."
make build
echo "✅ Build successful."

# 3. Verify process management
echo "🚀 Verifying process management (run -> stop)..."
make run &
RUN_PID=$!

# Wait for servers to start
TIMER=0
MAX_WAIT=30
while ! curl -s http://localhost:3000 > /dev/null; do
    sleep 1
    TIMER=$((TIMER + 1))
    if [ $TIMER -ge $MAX_WAIT ]; then
        echo "❌ Timeout waiting for frontend server"
        make stop
        exit 1
    fi
done

echo "🌐 Frontend server is UP."

# Check backend through proxy
if ! curl -s http://localhost:3000/api/v1/users/me > /dev/null; then
    echo "❌ API Proxy check failed"
    make stop
    exit 1
fi
echo "🔗 API Proxy is working."

# Test stop
echo "⏹️ Stopping servers..."
set +e
make stop
kill $RUN_PID 2>/dev/null || true
set -e
sleep 5

if curl -s http://localhost:3000 > /dev/null || curl -s http://localhost:8080 > /dev/null; then
    echo "❌ some servers are still alive after make stop"
    exit 1
fi
echo "✅ Process management successful."

echo "🎉 Infrastructure Sanity Checks: ALL PASSED"
