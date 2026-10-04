# -----------------------------------------------------
# Social Network - Makefile
# -----------------------------------------------------

APP_NAME = social-network
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

build-frontend: build-assets
	@echo "🔧 Building frontend..."
	@go build -o $(FRONTEND_BIN) $(FRONTEND_PKG)
	@echo "✅ Frontend build complete"

build-assets:
	@bun run build

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

# Native gate; make check adds both image builds and isolated container smoke.
test: build lint fmt-check vet test-backend test-race test-frontend test-e2e

verify-infra:
	@./scripts/verify-infrastructure.sh

lint:
	@bun run lint

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

# Existing UI fixtures and real-service transport run with disposable data.
test-e2e: build
	@./scripts/test-browser-local.sh $(PLAYWRIGHT_ARGS)

# SN-A07 extends playwright.integration.config.ts; no future tests required.
test-browser:
	@./scripts/test-stack.sh $(PLAYWRIGHT_ARGS)

check: test test-images

test-images: stack-build
	@./scripts/smoke-backend-image.sh social-network-backend
	@./scripts/smoke-media-images.sh social-network-backend social-network-frontend
	@$(MAKE) test-browser


format: format-backend format-frontend

format-backend:
	@go fmt ./...

format-frontend:
	@bun run lint:fix

fmt: format

vet:
	@go vet ./...

deps: deps-backend deps-frontend

deps-backend:
	@go mod download
	@go mod verify

deps-frontend:
	@bun install --frozen-lockfile
	@bun x playwright install chromium

# -----------------------------------------------------
# Docker: independent backend handoff (combined commands below)
# -----------------------------------------------------

IMAGE      = social-network-backend
CONTAINER  = social-network-backend
FRONTEND_ORIGIN ?= http://localhost:3000
BACKEND_VOLUME ?= social-network-backend-data

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
		-v $(BACKEND_VOLUME):/data \
		-e FRONTEND_URL=$(FRONTEND_ORIGIN) \
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
	@echo "🧹 Removing backend image..."
	-@docker rmi -f $(IMAGE) 2>/dev/null || true

docker-clean-all: docker-stop docker-clean-images
	@echo "✅ Backend Docker cleanup complete"


# -----------------------------------------------------
# 🌐 Browser Helper (Frontend)
# -----------------------------------------------------

open-browser:
ifeq ($(OS),Windows_NT)
	@start http://localhost:3000
else
	@xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000
endif

# Two-image development stack. Stop preserves its project-scoped data volume.
COMPOSE_PROJECT_NAME ?= social-network
export COMPOSE_PROJECT_NAME

stack-build:
	docker compose build

stack-up:
	docker compose up --build --wait --wait-timeout 120

stack-down:
	docker compose down

stack-logs:
	docker compose logs --tail=100 --follow

stack-ps:
	docker compose ps

.PHONY: build build-assets build-backend build-frontend test check lint fmt-check vet \
	test-backend test-race test-race-all test-frontend test-e2e test-browser test-images \
	deps deps-backend deps-frontend stack-build stack-up stack-down stack-logs stack-ps
