# -----------------------------------------------------
# 🗨️ Forum Project - Makefile
# -----------------------------------------------------

APP_NAME = forum
TEST_CACHE_DIR = $(CURDIR)/.tmp/go-cache
TEST_TMP_DIR = $(CURDIR)/.tmp/go-tmp

# -----------------------------------------------------
# 📦 Binaries
# -----------------------------------------------------

BACKEND_BIN  = forum-backend
FRONTEND_BIN = forum-frontend
QA_SEED_PKG  = ./cmd/qa-seed

BACKEND_PKG  = ./cmd/backend
FRONTEND_PKG = ./cmd/frontend

PORT = 8080

# -----------------------------------------------------
# 🧱 Build & Run (Local – Go)
# -----------------------------------------------------

build-backend:
	@echo "🔧 Building backend..."
	@go build -o $(BACKEND_BIN) $(BACKEND_PKG)
	@echo "✅ Backend build complete"

build-frontend:
	@echo "🔧 Building frontend..."
	@go build -o $(FRONTEND_BIN) $(FRONTEND_PKG)
	@echo "✅ Frontend build complete"

build: build-backend build-frontend

build-all: build

run-backend: build-backend
	@echo "🚀 Starting backend server..."
	@./$(BACKEND_BIN)

run-frontend: build-frontend
	@echo "🚀 Starting frontend server on http://localhost:3000 ..."
	@./$(FRONTEND_BIN)

run: build
	@echo "🔥 Starting backend & frontend..."
	@./$(BACKEND_BIN) &
	@./$(FRONTEND_BIN)

seed-qa:
	@echo "🌱 Applying QA seeds..."
	@go run $(QA_SEED_PKG)
	@echo "✅ QA seed complete"

# -----------------------------------------------------
# 🛑 Stop Local Processes
# -----------------------------------------------------

stop-backend:
	@pkill -x $(BACKEND_BIN) 2>/dev/null || true
	@pkill -f "backend" 2>/dev/null || true
	@pkill -f "$(BACKEND_PKG)" 2>/dev/null || true

stop-frontend:
	@pkill -x $(FRONTEND_BIN) 2>/dev/null || true
	@pkill -f "frontend" 2>/dev/null || true
	@pkill -f "$(FRONTEND_PKG)" 2>/dev/null || true

stop: stop-backend stop-frontend

# Free any process squatting on the local dev/test ports. By-port cleanup is
# more reliable than by-name (a leaked go-build cache binary may not match the
# expected binary name), which is what caused stale-server reuse in E2E runs.
free-ports:
	@node ./scripts/free-ports.mjs 3000 8080

# -----------------------------------------------------
# 🧪 Code Quality
# -----------------------------------------------------

# The single quality gate: every check runs exactly once, ordered so the
# cheapest failure surfaces first (compile → static analysis → tests). CI runs
# this one target, so a green `make test` locally is a green pipeline.
test: build lint fmt-check vet test-backend test-race test-frontend test-e2e

verify-infra:
	@./scripts/verify-infrastructure.sh

lint:
	@./node_modules/.bin/bun run lint

# Read-only Go format gate (issue #66). CI used to run `make format` and then
# `git diff --exit-code`, which mutates the checkout before judging it; this
# reports the offenders and fails without touching a single file. Run
# `make format-backend` to fix what it lists.
GOFMT_DIRS = ./cmd ./internal ./web

fmt-check:
	@offenders="$$(gofmt -l $(GOFMT_DIRS))"; \
	if [ -n "$$offenders" ]; then \
		echo "❌ gofmt: the following files need formatting (run 'make format-backend'):"; \
		echo "$$offenders" | sed 's/^/   /'; \
		exit 1; \
	fi
	@echo "✅ gofmt clean"

test-backend:
	@mkdir -p $(TEST_CACHE_DIR) $(TEST_TMP_DIR)
	@GOCACHE=$(TEST_CACHE_DIR) GOTMPDIR=$(TEST_TMP_DIR) go test ./...

# Packages carrying concurrent state. `internal/ws` is the reason this target
# exists: the Hub presence map is mutated from every reader goroutine, and
# TestConcurrentAddRemove cannot fail without -race.
RACE_PKGS = ./cmd/... ./internal/ws/... ./internal/middleware/... ./internal/handlers/... ./internal/db/...

# The race gate. Deliberately excludes ./internal/tests: the httptest
# integration suite runs 37s clean but ~358s under -race (~9x), which is too
# slow for the default gate. Use `make test-race-all` for the full sweep.
test-race:
	@mkdir -p $(TEST_CACHE_DIR) $(TEST_TMP_DIR)
	@GOCACHE=$(TEST_CACHE_DIR) GOTMPDIR=$(TEST_TMP_DIR) go test -race $(RACE_PKGS)

# The full sweep, including ./internal/tests. Needs an explicit timeout: the
# integration package alone sits at ~6min under -race, close enough to Go's
# 10m per-package default to trip it on a loaded machine.
test-race-all:
	@mkdir -p $(TEST_CACHE_DIR) $(TEST_TMP_DIR)
	@GOCACHE=$(TEST_CACHE_DIR) GOTMPDIR=$(TEST_TMP_DIR) go test -race -timeout 20m ./...

# Vitest only. `bun run policy` (Biome + Vitest) stays as the standalone
# frontend gate, but calling it here would re-run the `lint` target above.
test-frontend:
	@bun run test

test-e2e: free-ports
	@if node ./scripts/check-local-listener.mjs; then \
		trap 'node ./scripts/free-ports.mjs 3000 8080' EXIT INT TERM; \
		bun x playwright test; \
	else \
		echo "Skipping Playwright E2E: local TCP listeners are unavailable in this environment."; \
	fi

format: format-backend format-frontend

format-backend:
	@go fmt ./...

format-frontend:
	@./node_modules/.bin/bun run lint:fix

fmt: format

vet:
	@go vet ./...

deps: deps-backend deps-frontend

deps-backend:
	@go mod tidy

deps-frontend:
	@command -v bun >/dev/null 2>&1 && bun install || (npm install && bun install)
	@bun x playwright install chromium

# -----------------------------------------------------
# 🐳 Docker (Backend Only – Production)
# -----------------------------------------------------

IMAGE      = forum
CONTAINER  = forum_app

# -----------------------------------------------------
# Build & Run
# -----------------------------------------------------

docker-build:
	@echo "🐳 Building Docker image..."
	docker image build -t $(IMAGE) .

docker-run:
	@echo "🚀 Running Docker container..."
	docker container run -d \
		-p $(PORT):8080 \
		-v forum-data:/data \
		--name $(CONTAINER) \
		$(IMAGE)

docker-restart:
	@echo "🔄 Restarting container..."
	docker restart $(CONTAINER)

# -----------------------------------------------------
# Stop & Remove
# -----------------------------------------------------

docker-stop:
	@echo "🛑 Stopping container..."
	-@docker stop $(CONTAINER) 2>/dev/null || true
	-@docker rm $(CONTAINER) 2>/dev/null || true

# -----------------------------------------------------
# Inspection & Logs
# -----------------------------------------------------

docker-ps:
	docker ps -a

docker-images:
	docker images

docker-logs:
	docker logs $(CONTAINER)

docker-logs-follow:
	docker logs -f $(CONTAINER)

docker-inspect:
	docker inspect $(CONTAINER)

# -----------------------------------------------------
# Cleanup (Project-scoped, SAFE)
# -----------------------------------------------------

docker-clean-images:
	@echo "🧹 Removing Forum image..."
	-@docker rmi -f $(IMAGE) 2>/dev/null || true

docker-clean-all: docker-stop docker-clean-images
	@echo "✅ Forum Docker cleanup complete"


# -----------------------------------------------------
# 🌐 Browser Helper (Frontend)
# -----------------------------------------------------

open-browser:
ifeq ($(OS),Windows_NT)
	@start http://localhost:3000
else
	@xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000
endif
