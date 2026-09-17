# Social Network — Active Project Context

Start with [docs/social-network/CONTEXT.md](docs/social-network/CONTEXT.md).
The [Zone01 social-network requirements](docs/social-network/requirements.md) define the current target.
Use the caveman skill by default for coding tasks, as requested by the project owner.

The guide below was imported from real-time-forum as historical context. Its old
project identity, requirements authority, vanilla-JS restriction, feature scope,
and ticket priorities do not override social-network requirements or the owner's
instructions. Keep applicable code conventions while working with the inherited
code. Major architecture choices remain open; agree them with the owner before
implementation. Documentation cleanup is a later task.

---

# AGENTS.md — Coding Agent Guide for Real-Time Forum

## Project Identity

This is a **real-time forum** — a Go-based single-page application with authenticated private messaging via WebSockets. It satisfies the [01-edu real-time-forum exercise](docs/requirements.md).

## Source of Truth

| Document | Purpose |
|----------|---------|
| `docs/requirements.md` | Exercise specification — ultimate requirements authority |
| `docs/audit.md` | Audit checklist questions that must be satisfied |
| `docs/PRD.md` | Product requirements document |
| `docs/SDS.md` | Software design specification — API contracts, data model, event shapes |
| `docs/ticket-tracker.md` | Implementation order and progress tracker |
| `docs/track-{a,b,c,d}.md` | Detailed ticket definitions per track |

**Always read the relevant ticket definition in the track file before starting work.** Each ticket has a verification gate — your work is not complete until the gate is satisfied.

## Architecture

```
cmd/
  backend/           → backend server entrypoint (port 8080)
  frontend/          → frontend server entrypoint (port 3000) — serves SPA + proxies API/WS
internal/
  auth/              → OAuth helpers (retained, not required for audit)
  db/                → persistence layer (SQLite, repository functions, schema)
  env/               → environment configuration
  handlers/          → HTTP handlers (REST API under /api/v1)
  middleware/        → request middleware (auth, logging, CORS, recovery)
  router/            → route registration
  tests/             → backend integration tests
SPA/                 → Single Page Application (Vanilla JS ES2026+)
  index.html         → SPA Entrypoint
  main.js            → Bootstrap Application Logic
  assets/            → Global CSS & Static Images
  core/              → State (Proxy store + session/presence slices), Router, and API Logic
  components/        → Shared UI Elements
  features/          → Domain Slices (each with its {feature}.views.js)
  tests/              → Vitest-powered shared test suite
    unit/            → Isolated logic and component tests
    integration/     → Multi-component or API-coupled tests
    e2e/             → Full flow regression tests (user journeys)
web/
  static/            → CSS, JS, images, sounds, uploads (legacy)
  templates/         → HTML templates (legacy — replaced by SPA)
  errors/            → error page templates
  startupcheck/      → startup validation
data/                → SQLite database file location
docs/                → project documentation
```

### Topology

- **Frontend server** (`:3000`): serves static assets, the SPA HTML shell, and proxies `/api/` and `/ws` to the backend.
- **Backend server** (`:8080`): owns business logic, persistence, REST APIs, and WebSocket endpoint.
- **Database**: SQLite — file stored in `data/`.

### Key Design Rules

1. **Single HTML file** — the SPA is served from one HTML document. All navigation is client-side JS.
2. **No frontend frameworks** — vanilla JS only. No React, Angular, Vue, etc.
3. **Session-cookie auth** — `HttpOnly` cookies. No JWT. No OAuth for the real-time forum (retained code may exist but is not required).
4. **WebSocket for chat only** — presence and private messaging. REST for everything else.
5. **Layered backend** — `db/` (SQL, no HTTP), `handlers/` (HTTP, no SQL), `middleware/` (cross-cutting).

## Allowed Dependencies

Only these Go packages are permitted:

- All [standard Go packages](https://golang.org/pkg/)
- [`github.com/gorilla/websocket`](https://pkg.go.dev/github.com/gorilla/websocket)
- [`github.com/mattn/go-sqlite3`](https://github.com/mattn/go-sqlite3)
- [`golang.org/x/crypto/bcrypt`](https://pkg.go.dev/golang.org/x/crypto/bcrypt)
- [`github.com/google/uuid`](https://github.com/google/uuid) or [`github.com/gofrs/uuid`](https://github.com/gofrs/uuid)

**No other third-party packages are allowed.**

> **Note:** `github.com/gorilla/websocket` must be added to `go.mod` when implementing C01 (WebSocket endpoint). Run `go get github.com/gorilla/websocket` and then `go mod tidy`.

## Code Conventions

### Go Backend

- **Persistence layer** (`internal/db/`):
  - No `net/http` imports. No JSON encoding. No request parsing.
  - All functions accept `context.Context` as first parameter.
  - Use `database/sql` transactions for multi-step writes.
  - Schema lives in `internal/db/forum_schema.sql`.

- **Handlers** (`internal/handlers/`):
  - Parse requests, validate input, call db functions, format JSON responses.
  - Use `response.go` helpers for consistent JSON response structure.
  - Pattern: `HandlePosts` (collection), `HandlePost` (single resource).
  - All responses follow existing error schema.

- **Middleware** (`internal/middleware/`):
  - Global request flow (outermost first): Recoverer → Logger → CORS → Handler.
  - `Auth` is applied per-route (wraps the handlers that require a session); it injects `userID` into context. Authentication is cookie-only (`session_token`).

- **Router** (`internal/router/`):
  - Uses `http.ServeMux`. Explicit route definitions. API versioned under `/api/v1`.

- **Tests** (`internal/tests/`):
  - **Integration Tests**: Using `httptest` with in-memory SQLite to validate API behavior.
  - **Unit Tests**: Co-located with source code (`_test.go`) in backend subpackages.
  - **E2E Tests**: High-level tests simulating full user journeys using Playwright.

### Test Architecture

The project follows a tiered testing strategy to ensure reliability across the stack:

| Tier | Goal | Tools | Locations |
| :--- | :--- | :--- | :--- |
| **Unit** | Test individual functions/logic in isolation. | Go `testing`, Vitest | `.../*.go`, `SPA/tests/unit/` |
| **Integration** | Test component interactions, database cycles, and API contracts. | Go `httptest`, Vitest | `internal/tests/`, `SPA/tests/integration/` |
| **E2E** | Test full user journeys in a real headless browser. | Playwright | `SPA/tests/e2e/` |

### JavaScript Frontend

- **Vanilla JS** — Modern vanilla JS ES2026+ using optimal best practice patterns. ES modules, no frontend framework.
- **Development Tooling** — Use Bun for runtime and package management. Use Biome for fast, precise linting and static analysis. Use Vitest for all unit, integration, and end-to-end (E2E) testing workflows.
- **Folder Structure** — Located in `SPA/`. The architecture follows Clean Vertical Slices / Screaming Architecture (e.g., grouping by feature: `features/auth/auth.views.js`, `features/feed/feed.views.js`, `core/api`, `core/router`, `components/shared`). All testing logic is consolidated under `SPA/tests/`, subdivided into `unit/`, `integration/`, and `e2e/` folders. Avoid scattering files by generic type without domain context. Use `{feature}.views.js` for view logic within slices.
- **Event delegation** for dynamic DOM elements.
- **API-driven** — UI state comes from REST calls and WebSocket events.
- **Frontend Design** — Always use the `frontend-design` skill when implementing or modifying frontend components, layouts, or styles to ensure premium aesthetics and state-of-the-art UI/UX.

### CSS

- **Located in** `SPA/` (co-located with features or globally) or a dedicated CSS folder.
- **Vanilla CSS** — no preprocessors or utility frameworks.

## API Conventions

- All REST endpoints under `/api/v1/`.
- Auth endpoints: `POST /api/v1/users/login`, `POST /api/v1/users/register`, `POST /api/v1/users/logout`, `GET /api/v1/users/me`.
- Chat endpoints: `GET /api/v1/chats` (roster), `GET /api/v1/chats/{userID}/messages` (history).
- Profile endpoint (bonus): `GET /api/v1/users/{userID}/profile`.
- DM image upload (bonus): `POST /api/v1/chats/{userID}/images`.
- WebSocket: `GET /ws` — authenticated upgrade, JSON message frames.
- See `docs/SDS.md` sections 5.1–5.7 for full API contracts and event shapes.

## Database

- **Engine**: SQLite via `github.com/mattn/go-sqlite3`.
- **Schema**: `internal/db/forum_schema.sql`.
- **Tables**: `users`, `sessions`, `posts`, `drafts`, `comments`, `categories`, `reactions`, `notifications`, `private_messages` (new).
- **New columns on `users`**: `age INTEGER NOT NULL`, `gender TEXT NOT NULL`, `first_name TEXT NOT NULL`, `last_name TEXT NOT NULL`.
- **New table**: `private_messages` — see `docs/SDS.md` section 4.2 for full schema.
- **Bonus column**: `private_messages.image_path TEXT DEFAULT NULL` for DM image attachments.
- **Presence**: in-memory only (not stored in SQLite).

## WebSocket Event Contracts

### Client → Server

```json
{ "type": "dm.send", "payload": { "recipient_id": 12, "body": "hello" } }
```

### Server → Client

- `presence.snapshot` — full presence state on connect
- `presence.update` — single user online/offline transition
- `dm.message` — new direct message
- `chat.error` — send error (e.g., `RECIPIENT_OFFLINE`)

See `docs/SDS.md` section 5.5 for full event schemas.

## Build & Run

```bash
make deps          # install all deps & playwright browsers
make build         # build both servers
make run           # start backend (8080) + frontend (3000)
make test          # run all tests (Go, Vitest, Playwright)
make test-e2e      # run only playwright tests
make verify-infra  # run infrastructure sanity checks
make stop          # kill both servers
```

Individual targets: `build-backend`, `build-frontend`, `run-backend`, `run-frontend`.

## Working on Tickets

1. **Check `docs/ticket-tracker.md`** for the current implementation wave and which tickets are unblocked.
2. **Read the full ticket definition** in the relevant track file (`docs/track-{a,b,c,d}.md`).
3. **Check dependencies** — don't start a ticket until all its `Depends on` tickets are `[x]`.
4. **Satisfy the verification gate** — each ticket's gate defines "done".
5. **Update the tracker** — mark `[-]` when in progress, `[x]` when the gate is satisfied.
6. Run tests — `make test` must pass after every change.

## Bug Workflow

If you encounter or identify a bug during development:
1. **Reproduce**: Create a minimal test case (in Go or Vitest) that isolates and reproduces the bug.
2. **Fix**: Implement the fix while ensuring the reproduction test now passes.
3. **Verify**: Run the full test suite (`make test` and `bun test` / `vitest`) to ensure no regressions.
4. **Clean**: Fix any linting or formatting issues using Biome (`bun x biome`).

## Common Pitfalls

- **Don't serve multiple HTML templates** — the app is a SPA. One HTML shell, all navigation in JS.
- **Don't allow guest access** — all forum content requires authenticated session.
- **Don't render comments in the feed** — comments load only on post detail.
- **Don't send DMs to offline users** — the backend must reject `dm.send` to offline recipients.
- **Don't use polling for chat** — use WebSocket for presence and DMs. Polling is only for legacy notifications.
- **Don't add npm/node dependencies** — the frontend is vanilla JS served by the Go frontend server.
- **Don't use external CSS frameworks** — vanilla CSS only.
- **Throttle/debounce scroll events** — the history pagination scroll must not spam the API.
