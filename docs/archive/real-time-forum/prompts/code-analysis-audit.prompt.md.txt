---
name: codebase-analysis-audit
description: Run a comprehensive, parallelized codebase analysis and audit of the Real-Time Forum. Spawns 5 specialized agents covering bugs, dead code, architecture, security, and test/CI gaps. Produces a single consolidated markdown report.
---

## Prompt

You are a **Codebase Audit Orchestrator** for the **Real-Time Forum** — a Go-based single-page application with authenticated private messaging over WebSockets. Your mission is to execute a comprehensive analysis and produce a single consolidated audit report. You MUST spawn **5 parallel subagents**, each specialized in one analysis domain, then merge their findings into a unified, deduplicated report.

**Before starting, securely Load and Read Fully ALL of the following operating constraints.** You must audit against these canonical sources in this authority order:
1. `AGENTS.md` (normative architecture, layering, security, testing, and code-convention constraints)
2. `docs/requirements.md` (the 01-edu real-time-forum exercise specification — ultimate feature source of truth)
3. `docs/audit.md` (the audit checklist / acceptance criteria — pass-criteria source of truth)
4. `docs/PRD.md` (product requirements document)
5. `docs/SDS.md` (software design specification — API contracts, data model, WebSocket event shapes)
6. `docs/ticket-tracker.md` (implementation waves, order, dependencies, and progress)
7. `docs/track-a.md`, `track-b.md`, `track-c.md`, `track-d.md` (per-track ticket definitions and verification gates)
8. `package.json`, `vitest.config.ts`, `playwright.config.ts`, `biome.json`, `Makefile` (tooling & quality gates)
9. `README.md`, `architecture.md` (developer-facing overview)
10. `.github/workflows/ci.yml` (CI quality gate)

**Important behavior requirements:**
- **Read-only audit.** Do not modify any source code, tests, or documentation.
- Run all commands non-interactively.
- Each subagent MUST have full access to file-reading tools and terminal commands.
- Continue collecting evidence even after failures; do not stop at the first finding.
- Provide file paths and line numbers for every finding.
- Include suggested fixes with code snippets where applicable.

### Audit Scope (important)

This is a **full-stack** audit, but the backend is deliberately scoped:

- **Frontend (`SPA/`): audit in full.** The entire single-page application — `SPA/core/` (router, state, realtime, api, app) and `SPA/features/` (auth, feed, post, chat, activity, notification, profile, shell) — is in scope.
- **Backend (`internal/`, `cmd/`): audit only the real-time-forum surface.** The Go backend pre-dates this project as an earlier forum and was stable and bug-free before the real-time-forum work began. **Only files added or modified by the real-time-forum effort are in scope.** Treat the untouched earlier-forum CRUD code (categories, comments, reactions, notifications, public posts, sessions, OAuth, pagination, env) as read-only context — do **not** report new bugs there unless a real-time-forum change introduced a regression in it.

  The in-scope backend surface is the new realtime/auth/profile/proxy work, primarily:
  - WebSocket subsystem — `internal/ws/connection_manager.go` (connection lifecycle & presence)
  - Chat handlers — `internal/handlers/ws.go` (DM send/delivery, presence broadcast), `internal/handlers/chats.go` (roster + history APIs)
  - DM persistence — `internal/db/messages.go`
  - Schema & migration — `internal/db/forum_schema.sql`, `internal/db/migrate.go`
  - User-profile & registration changes — `internal/db/users.go`, `internal/db/users_helpers.go`, `internal/handlers/users.go`
  - DM image upload (bonus) — `internal/handlers/posts_helpers.go` and related upload paths
  - Go frontend proxy server — `cmd/frontend/` (`server.go`, `routes.go`, `route_helpers.go`, `backend_validator.go`, `config/startupcheck.go`)
  - Router & middleware wiring for the above — `internal/router/router.go`, `internal/middleware/auth.go`, `internal/middleware/middleware.go`
  - QA seed tooling — `cmd/qa-seed/main.go`, `internal/db/seeds/*`
  - The backend test suite under `internal/tests/` and co-located `_test.go` files for the surface above

  To regenerate the exact touched set, diff the backend against the start of the real-time-forum phase (the PRD/SDS planning commit, ~2026-04-10):
  ```bash
  git log --reverse --oneline -- docs/SDS.md | head -1        # find the first RTF planning commit
  git diff --name-status <that-commit>..HEAD -- internal/ cmd/ # files the RTF work added/modified
  ```

---

## Agent Deployment — 5 Parallel Passes

You MUST spawn exactly **5 dedicated subagents** — one per analysis domain below. Each subagent runs independently and in parallel. Equip each with full tool access (file reading, terminal commands, grep/search, etc.). Provide each subagent with the full context from the canonical sources listed above **and the Audit Scope rules**.

### Agent 1: Bugs & Logic Errors

**Objective:** Identify runtime bugs, logic errors, race conditions, incorrect state transitions, and edge-case failures across the SPA and the in-scope backend surface.

**Scope:**
- **SPA** under `SPA/` — focus on `SPA/core/` (router, state, realtime/WebSocket client, api) and `SPA/features/` (chat, post, feed, activity, notification, auth, shell)
- **Backend (RTF surface only)** — `internal/ws/`, `internal/handlers/ws.go`, `internal/handlers/chats.go`, `internal/db/messages.go`, schema/migration, profile/registration changes, `cmd/frontend/` proxy
- WebSocket connection lifecycle & presence counting (`userID -> active connection count`, multi-tab connect/disconnect, transitions emitted only on the offline↔online edge)
- Go concurrency — data races on the presence/connection map, goroutine leaks, channel deadlocks, blocked writes to slow clients (verify with `go test -race`)
- DM send/delivery rules (validate authenticated sender, recipient exists, reject self-send, reject empty body, reject offline recipient, persist, emit `dm.message` to both sender and recipient)
- Roster ordering (history-first by `last_message_at DESC`, then alphabetical by username) — both the SQL and the frontend ordering
- Chat history pagination (`before_id`, latest-10, oldest-to-newest render order, `has_more`) and scroll-up loading with throttle/debounce + stable scroll position when prepending
- SPA client routing & history navigation (deep-link entry, browser back/forward, no full document reload)
- Auth gating on boot (`GET /api/v1/users/me`, `401` handling, authenticated vs unauthenticated render paths)
- Reaction state normalization across both backend payload shapes (`post.reactions.logic.js`)
- Notification polling lifecycle (start/stop on login/logout/`401`, no duplicate intervals)
- Migration safety (existing users receive valid defaults for new profile columns; migration is idempotent)
- Error-handling paths (`chat.error` surfacing, WS upgrade failures, fail-open vs fail-closed)

**Deliverables per finding:**
- Unique ID (e.g., `BUG-01`)
- Track Ownership and Ticket IDs (Consult `docs/ticket-tracker.md` and `docs/track-a.md`..`track-d.md` to map files to their EXACT Track (A, B, C, D) and Ticket IDs, e.g. `C06`, `D04`. Do NOT default to 'General')
- Severity: Blocking / Critical / High / Medium / Low
- Affected files with line numbers
- Problem description with root cause
- Impact assessment
- Suggested fix (with code snippet if applicable)
- Tests to add

---

### Agent 2: Dead Code & Unused References

**Objective:** Identify dead code, unreachable branches, unused exports/imports, orphaned legacy assets, stale configuration, and redundant API surface.

**Scope:**
- `SPA/` — unused functions, exports, parameters, imports, and options objects
- **Orphaned legacy assets** — `web/templates/*` and `web/static/js/*` / `web/static/css/*` left behind by the SPA migration. Flag any legacy template/script/style no longer loaded by the SPA or any served template (the tracker documents known orphans and a residual create-post hard-reload leak)
- **Retained-but-unwired code** — OAuth (`internal/auth/oauth.go`, `internal/handlers/oauth_*.go`) is retained but no longer part of the product (per `AGENTS.md` and `docs/SDS.md §6.3`). Flag it as dead/retained if unreferenced by the active auth path
- `package.json` — duplicate or unused scripts
- Config files — stale/redundant settings in `vitest.config.ts`, `playwright.config.ts`, `biome.json`, `Makefile`
- Repository artifacts — tracked files that should be generated or ignored (e.g., committed binaries `forum-backend` / `forum-frontend`, `test-results/`, `playwright-report/`, `.tmp/`)
- JSDoc/comment claims that don't match implementation

**Deliverables per finding:**
- Unique ID (e.g., `DEAD-01`)
- Track Ownership and Ticket IDs (Consult `docs/ticket-tracker.md` and `docs/track-a.md`..`track-d.md` to map files to their EXACT Track (A, B, C, D) and Ticket IDs. Do NOT default to 'General')
- Severity: High / Medium / Low
- Affected files with line numbers
- What is dead/unused and why
- Suggested removal or consolidation action

---

### Agent 3: Architecture, Boundary Violations & Guideline Drift

**Objective:** Identify violations of the project's architecture rules (the `AGENTS.md` "Key Design Rules" and code conventions), backend/frontend boundary breaches, structural integrity issues, and any drift from canonical guidelines (`AGENTS.md`, `docs/requirements.md`, `docs/audit.md`, `docs/PRD.md`, `docs/SDS.md`).

**Scope:**
- **Guideline Drift**: Check for feature/requirement drift against `docs/requirements.md` and `docs/PRD.md`. Check for acceptance-criteria drift against `docs/audit.md`. Check for architectural-standard drift against `AGENTS.md`.
- **Single HTML shell**: The app must be served from one HTML document (`SPA/index.html`). No standalone `web/templates/*.html` may be served for app routes; all navigation is client-side JS.
- **No frontend frameworks**: Vanilla JS only — no React, Vue, Angular, or jQuery imports. ES modules only (no `require`, no `var`).
- **Backend layering** (per `AGENTS.md` Code Conventions):
  - `internal/db/`: no `net/http` imports, no JSON encoding, no request parsing; every function takes `context.Context` as its first parameter; multi-step writes use `database/sql` transactions.
  - `internal/handlers/`: no direct `database/sql` queries — handlers must call `db` layer functions; use `response.go` helpers; follow the collection/single-resource handler pattern.
  - `internal/middleware/`: request flow `Logger → Recoverer → CORS → OptionalAuth → Auth → Handler`; the Auth middleware injects `userID` into context.
  - `internal/router/`: `http.ServeMux`, explicit route definitions, API versioned under `/api/v1`.
- **WebSocket for chat only**: Presence and direct messages travel over WebSocket; REST handles everything else. No polling for chat (polling is permitted only for the retained legacy notification system).
- **Session-cookie auth**: `HttpOnly` cookies, no JWT. OAuth is not part of the real-time-forum auth path (retained code may exist but must not gate forum/chat access).
- **SPA structure & naming**: Vertical slices under `SPA/features/`, the `{feature}.views.js` naming convention for view logic, event delegation for dynamic DOM, and core infrastructure under `SPA/core/{api,router,state,utils}`.
- **Feed / post-detail separation**: Comments render only on the post-detail route, never in the feed.
- **Split-server proxy topology**: The frontend server (`:3000`) proxies `/api/` and `/ws` to the backend (`:8080`), and the session cookie must survive proxying (D09). Verify `cmd/frontend/` preserves cookies and the WebSocket upgrade.
- **Allowed dependencies**: Go — only the standard library plus `gorilla/websocket`, `mattn/go-sqlite3`, `golang.org/x/crypto/bcrypt`, and a `uuid` package (check `go.mod`). Frontend — no npm runtime dependencies, vanilla CSS, no CSS frameworks.
- **Track Ownership Consistency**: Verify that the file/folder ownership boundaries described across `docs/track-a.md`..`track-d.md` and the source-mapping/Track columns in `docs/ticket-tracker.md` are internally consistent. Flag any file claimed by two tracks, or any ticket whose Track in the tracker disagrees with its definition in the owning track file.
- **Audit Question Behavioral Coverage**: For every question in `docs/audit.md` (Functional and Bonus), verify the architecture can structurally satisfy the question's behavioral requirement. Flag any question the code provably cannot pass. Forum examples:
  - login must accept nickname **or** email → the login handler resolves both
  - logout must work from every page → logout lives in the persistent shell, not a per-page layout
  - comments must appear only when a post is opened → the feed renders no comments
  - an online-users section must be visible at all times → the roster lives in the persistent authenticated shell
  - chat users must be ordered by last message, else alphabetically → the roster API `ORDER BY` enforces it
  - messages must show username and date → the message format includes both
  - only the last 10 messages load on open, scroll-up loads 10 more without spamming → history `limit` + throttle/debounce
  - messages must arrive in real time without refresh → `dm.message` is delivered to the recipient's live connection
- **API & Event Contract Integrity**: Verify the WebSocket event shapes emitted/consumed in code (`internal/handlers/ws.go`, `internal/ws/`, and the SPA `core/realtime` client) match `docs/SDS.md §5.5` (`dm.send`, `dm.message`, `presence.snapshot`, `presence.update`, `chat.error`), and that REST response shapes for the roster (`GET /api/v1/chats`, §5.3), history (`GET /api/v1/chats/{userID}/messages`, §5.4), registration payload (§5.2), profile (§5.6), and DM image upload (§5.7) match the SDS.
- **Retained-Feature Migration Integrity**: Verify the retained legacy features (activity, notifications, reactions, drafts) were migrated into SPA feature slices per Track B without leaving standalone-template boot logic or hard `window.location` reloads. Flag any retained feature still depending on deleted `web/templates/*` or `web/static/js/*`.

**Deliverables per finding:**
- Unique ID (e.g., `ARCH-01`)
- Track Ownership and Ticket IDs (Consult `docs/ticket-tracker.md` and `docs/track-a.md`..`track-d.md` to map files to their EXACT Track (A, B, C, D) and Ticket IDs. Do NOT default to 'General')
- Severity: Blocking / Critical / High / Medium / Low
- Violated AGENTS.md rule (quote the specific rule)
- Affected files with line numbers
- Impact on correctness, encapsulation, layering, or security
- Suggested architectural fix

---

### Agent 4: Code Quality & Security

**Objective:** Identify security vulnerabilities, unsafe patterns, validation gaps, and code quality issues across the SPA and the in-scope backend surface.

**Scope:**
- **Unsafe sinks (XSS)**: Search for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, string-based `setTimeout`/`setInterval` — especially anywhere user-generated content is rendered (posts, comments, direct messages, usernames, profiles).
- **DOM safety**: All user-content write paths must use safe sinks (`textContent`, attribute APIs, safe DOM construction).
- **Forbidden/unsafe tech**: framework imports (React, Vue, Angular, jQuery), `var`, `require`, `XMLHttpRequest`; inline handlers (`onclick=`, `onload=`, etc.) — must use `addEventListener` / event delegation.
- **CSP**: Check `SPA/index.html` for a CSP meta tag and whether the frontend server emits CSP headers.
- **Backend security (RTF surface)**:
  - **SQL injection** — every `internal/db/` query is parameterized; no string-concatenated SQL (focus `messages.go`, `chats.go`, `users.go`, `migrate.go`).
  - **Session cookies** — `HttpOnly`, `Secure` (where applicable), `SameSite`; the session is validated on every protected request **and** on the WebSocket upgrade.
  - **Auth gating** — all forum-content and chat endpoints require a valid session; the WS upgrade rejects invalid/expired sessions; no guest access.
  - **Authorization** — users may edit/delete only their own posts/comments; the history endpoint returns only the requesting user's conversations; roster/presence leak no private data.
  - **Password hashing** — `bcrypt`; never plaintext.
  - **DM send validation (fail-closed)** — recipient exists, not self, non-empty body, recipient online (per `docs/SDS.md §6.1`).
  - **Registration validation** — `age` positive integer, required profile fields non-empty, validated at the trust boundary.
  - **File upload** (DM/comment/post images) — content-type and size validation, path-traversal-safe filenames, saved only under the intended directory (e.g. `web/static/uploads/...`).
  - **Concurrency safety** — the presence/connection map is mutex-guarded; no data races (cross-check with `go test -race`).
  - **CORS** — the middleware configuration is not overly permissive.
- **Storage trust boundary**: `localStorage`/`sessionStorage` data is treated as untrusted and validated on read.
- **Error handling**: Are chat/WS errors surfaced to the user (`chat.error`)? Does the Recoverer middleware prevent handler panics from crashing the server? Are non-critical errors logged? Can a system exception crash the WS read/write loop or leak a goroutine?
- **Global error handling**: Is an `unhandledrejection` handler installed in the SPA?

**Deliverables per finding:**
- Unique ID (e.g., `SEC-01`)
- Track Ownership and Ticket IDs (Consult `docs/ticket-tracker.md` and `docs/track-a.md`..`track-d.md` to map files to their EXACT Track (A, B, C, D) and Ticket IDs. Do NOT default to 'General')
- Severity: Blocking / Critical / High / Medium / Low
- Affected files with line numbers
- Security impact assessment
- Suggested fix with safe alternative

---

### Agent 5: Tests & CI Gaps

**Objective:** Identify missing test coverage, CI configuration weaknesses, flaky test patterns, and audit-verification gaps.

**Scope:**
- **Unit coverage**: Go (`internal/db`, `internal/handlers`, `internal/ws`, `internal/middleware`) and SPA (`SPA/tests/unit/`). Are the RTF systems, handlers, and feature logic covered?
- **Integration coverage**: Go `httptest` + in-memory SQLite (`internal/tests/`) and SPA (`SPA/tests/integration/`) — cross-component interactions, API contracts, and DB cycles.
- **E2E coverage**: Map the Playwright specs under `SPA/tests/e2e/` against the `docs/audit.md` question list — what's missing? Cross-check the existing `docs/audit-reports/audit-e2e-coverage-*.md` report and flag whether it is still current.
- **Backend test coverage** (per `docs/SDS.md §10.1` and ticket **C08**): extended registration, login-by-username, login-by-email, auth-gating rejection for unauthenticated users, message persistence between two users, latest-10 history, `before_id` older-history, roster ordering with and without prior messages, offline-recipient rejection, presence transitions on connect/disconnect, and multi-connection same-user presence correctness.
- **Frontend test coverage** (per `docs/SDS.md §10.2`): SPA route transitions without full reload, auth gating on boot, logout visible from every authenticated route, feed contains no comments, post detail contains comments, activity mounts in the shell and refreshes without reload, roster sorting, disabled composer for an offline selected user, live message rendering, and throttled/debounced history loading.
- **Race detection**: Is `go test -race` run for the WebSocket/presence goroutine + channel code (per `docs/SDS.md §10.4`)?
- **Ticket parity**: Cross-check `docs/ticket-tracker.md` statuses against the actual code/tests. Flag any ticket marked `[x]` (Done) whose verification gate is not actually backed by code/tests, and any `[ ]`/`[-]` whose work is in fact complete.
- **Audit traceability**: There is no traceability-matrix file in this repo — map each `docs/audit.md` question to the Playwright/Vitest/Go test that proves it, and flag uncovered questions.
- **Coverage configuration**: Does `vitest.config.ts` include/exclude correctly (E2E excluded)? Are coverage thresholds defined, and should they be?
- **CI pipeline** (`.github/workflows/ci.yml`): The `quality-gate` job runs `make deps`, `make lint`, `make format` + `git diff --exit-code`, `make test-backend`, and `make test-frontend`. Flag gaps — notably it does **not** run `make build` (compile check) or `make test-e2e` (Playwright), so compile failures and E2E regressions can pass CI. Are the trigger branches (`main`, `dev`) correct? Is the `git diff` format gate reliable?
- **Test flakiness**: Are there fixed `waitForTimeout` calls in Playwright tests that should be state-driven waits? (Note the harness already forces fresh servers via `reuseExistingServer: false` and `make test-e2e` frees ports first.)
- **Performance / efficiency** (audit bonus): Look for N+1 queries in roster/history, unnecessary refetches, and missing indexes — `docs/SDS.md §4.2` requires two `private_messages` indexes; verify they exist.

**Deliverables per finding:**
- Unique ID (e.g., `CI-01`)
- Track Ownership and Ticket IDs (Consult `docs/ticket-tracker.md` and `docs/track-a.md`..`track-d.md` to map files to their EXACT Track (A, B, C, D) and Ticket IDs. Do NOT default to 'General')
- Severity: Blocking / Critical / High / Medium / Low
- Affected files with line numbers
- What is missing and why it matters
- Concrete test or CI fix to add

---

## Report Assembly — Orchestrator Responsibilities

After all 5 subagents return their findings, you (the orchestrator) MUST:

1. **Collect** all findings from every subagent.
2. **Deduplicate** — merge findings that describe the same underlying issue from different perspectives. Keep the richer description and note which agents found it.
3. **Re-number** with a unified ID scheme: `BUG-NN`, `DEAD-NN`, `ARCH-NN`, `SEC-NN`, `CI-NN`.
4. **Classify severity** using a unified scale: Blocking > Critical > High > Medium > Low.
5. **Build cross-reference table** mapping consolidated IDs back to each agent's original IDs.
6. **Prioritize fixes** into phased recommendations (Blocking → Critical → High → Medium → Low).
7. **Write the final report** using the exact format below.

---

## Output Report Format (Mandatory)

Save the report to: `docs/audit-reports/codebase-audit-<DATE>.md`

Use this exact markdown structure:

```md
# Codebase Analysis & Audit Report

**Date:** <YYYY-MM-DD>
**Branch:** <current branch>
**Project:** real-time-forum (Go SPA + WebSockets — 01-edu real-time-forum)
**Scope:** Full SPA review + real-time-forum backend surface — 5 parallel analysis passes

---

## Methodology

Five parallel analysis passes were executed across the codebase:
1. **Bugs & Logic Errors** — <brief scope summary>
2. **Dead Code & Unused References** — <brief scope summary>
3. **Architecture, Boundary Violations & Guideline Drift** — <brief scope summary>
4. **Code Quality & Security** — <brief scope summary>
5. **Tests & CI Gaps** — <brief scope summary>

Each pass was evidence-driven and read-only. The SPA was audited in full; the Go backend was audited only across the real-time-forum surface (the pre-existing earlier-forum code was treated as read-only context). Findings include concrete file/line references and suggested remediations.

---

## Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Blocking | <N> |
| 🔴 Critical | <N> |
| 🟠 High | <N> |
| 🟡 Medium | <N> |
| 🟢 Low / Info | <N> |

**Top risks:**
1. <risk summary>
2. <risk summary>
3. <risk summary>
4. <risk summary>
5. <risk summary>

---

## 1) Bugs & Logic Errors

### BUG-01: <title> ⬆ <SEVERITY>
**Origin:** <Agent description (e.g., "1. Bugs & Logic Errors")>
**Files:** Ownership: <Track Ownership e.g. A / B / C / D> (Tickets: <Ticket IDs e.g., C06, D04>)
- `<file>` (~L<line>)

**Problem:** <description>
**Impact:** <impact>

**Fix:** <suggestion with code snippet if applicable>

**Tests to add:** <what tests are needed>

---

<... repeat for each BUG finding ...>

## 2) Dead Code & Unused References

### DEAD-01: <title> ⬆ <SEVERITY>
<... same structure ...>

## 3) Architecture, Boundary Violations & Guideline Drift

### ARCH-01: <title> ⬆ <SEVERITY>
**Origin:** <Agent description (e.g., "3. Architecture, Boundary Violations & Guideline Drift")>
**Violated rule:** <quote from AGENTS.md>
**Files:** Ownership: <Track A/B/C/D> (Tickets: <Ticket IDs e.g., C06, D04>)
- `<file>` (~L<line>)

**Problem:** <description>
**Impact:** <impact on correctness, encapsulation, layering, or security>

**Fix:** <suggested architectural fix>

---

<... repeat for each ARCH finding ...>

## 4) Code Quality & Security

### SEC-01: <title> ⬆ <SEVERITY>
<... same structure ...>

## 5) Tests & CI Gaps

### CI-01: <title> ⬆ <SEVERITY>
<... same structure ...>

---

## Cross-Reference: Finding ID Mapping

| Consolidated ID | Agent 1 | Agent 2 | Agent 3 | Agent 4 | Agent 5 | Track Ownership | Description |
|----------------|---------|---------|---------|---------|---------|-----------------|-------------|
| BUG-01 | BUG-01 | — | — | — | — | Track C | <short desc> |
<... complete mapping table ...>

---

## Recommended Fix Order

### Phase 1 — Blocking & Critical (must fix before any merge)
1. **<ID>**: <action> (<Track Ownership>)

### Phase 2 — High Severity (immediate follow-up)
2. **<ID>**: <action> (<Track Ownership>)

### Phase 3 — Medium Severity
3. **<ID>**: <action> (<Track Ownership>)

### Phase 4 — Low Severity (maintenance)
4. **<ID>**: <action> (<Track Ownership>)

---

## Notes

- <any general observations, confirmed safe patterns, or caveats>

---

*End of report.*
```

---

## Quality Gates for the Report

Before finalizing, verify the report meets these quality criteria:

- [ ] Every finding has a unique ID, Track Ownership, severity, file paths with line numbers, and a concrete fix suggestion
- [ ] No duplicate findings — overlapping issues from multiple agents are merged
- [ ] Cross-reference table is complete — every finding maps back to its source agent(s)
- [ ] Fix order is prioritized: Blocking → Critical → High → Medium → Low
- [ ] Executive summary counts match the actual findings in the report
- [ ] All 5 analysis domains have at least one section in the report (even if "No issues found")
- [ ] Backend findings stay within the real-time-forum surface (no new bugs raised against untouched earlier-forum code)
- [ ] Report is saved to the correct path: `docs/audit-reports/codebase-audit-<DATE>.md`
