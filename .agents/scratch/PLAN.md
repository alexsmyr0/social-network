# A05 Plan - Authenticated-Only Forum Access

## Scope

Ticket: A05 (Track A)

Goal: Enforce authenticated-only access for forum content while preserving SPA boot behavior based on `GET /api/v1/users/me`.

Source references:
- `docs/track-a.md` (A05 verification gate)
- `docs/requirements.md` (login required to use forum)
- `docs/audit.md` (register/login required)
- `docs/SDS.md` (all optional-auth forum endpoints become authenticated)
- `docs/PRD.md` (all forum content requires authenticated session)

## Findings (Current State)

- SPA route gating is already implemented:
  - `SPA/core/router/routes.js` marks forum routes as `protected`.
  - `SPA/core/app/create-app.js` checks `GET /api/v1/users/me` at boot and redirects unauthenticated users to `/login`.
- Backend still exposes some forum reads to guests:
  - `internal/router/router.go` uses public handlers for categories endpoints.
  - `internal/router/router.go` uses `optionalAuth` for `GET /api/v1/posts`, `GET /api/v1/posts/{id}`, and `GET /api/v1/comments/{id}`.

## Files To Modify

1. `internal/router/router.go`
- Protect these with `auth(...)` middleware:
  - `GET /api/v1/categories`
  - `GET /api/v1/categories/`
  - `GET /api/v1/categories/view`
  - `GET /api/v1/posts`
  - `GET /api/v1/posts/{id}`
  - `GET /api/v1/comments/{id}`

2. `internal/tests/...` (exact files selected during implementation)
- Add/adjust integration tests to assert:
  - unauthenticated requests to forum content endpoints return `401`
  - authenticated requests still return `200` for the same endpoints

3. `SPA/tests/...` (only if needed)
- Confirm/extend existing boot and protected-route tests if coverage gaps appear.

## API/Behavior Contract (A05)

### Bootstrap auth check

- Endpoint: `GET /api/v1/users/me`
- Purpose: determine authenticated vs unauthenticated app boot behavior
- Expected semantics:
  - `200`: authenticated session; render forum shell
  - `401`: unauthenticated; redirect/render auth flow (`/login`, `/register`)

### Forum content endpoints

All forum content APIs must require valid session cookies and reject guest access with `401`.

Examples:
- `GET /api/v1/posts` -> `401` when unauthenticated
- `GET /api/v1/posts/{id}` -> `401` when unauthenticated
- `GET /api/v1/comments/{id}` -> `401` when unauthenticated
- `GET /api/v1/categories` -> `401` when unauthenticated

## Database Migration Impact

None.

A05 is route/middleware enforcement and test coverage only. No schema updates are required.

## Verification Checklist (Pass/Fail)

Derived from `docs/track-a.md` A05 gate and source docs.

1. Unauthenticated users cannot access feed, posts, comments, activity, or chat:
- [ ] `GET /api/v1/posts` without session returns `401`
- [ ] `GET /api/v1/posts/{id}` without session returns `401`
- [ ] `GET /api/v1/comments/{id}` without session returns `401`
- [ ] `GET /api/v1/categories` without session returns `401`
- [ ] `GET /api/v1/users/activity` remains `401` without session

2. Authenticated users enter forum shell directly:
- [ ] `GET /api/v1/users/me` with valid session returns `200`
- [ ] SPA boot on `/` with valid session renders protected forum shell

3. App boot routes correctly by session state:
- [ ] SPA boot on protected route with `401` from `/users/me` redirects to `/login`
- [ ] SPA boot on protected route with `200` from `/users/me` renders target route

## Test Plan

Backend:
- Run `make test`
- Add/adjust integration tests under `internal/tests/` for endpoint auth rejection and authenticated success.

Frontend:
- Run `bun run policy`
- Ensure SPA auth-gating tests pass; add tests only if gaps are identified.

## Done Criteria For A05

- Backend forum content endpoints no longer allow guest reads.
- SPA boot/auth gating behavior remains correct.
- `make test` passes.
- `bun run policy` passes.
- Ticket status can be moved to done only after all checklist items pass.# A04 Implementation Plan: Persistent App Shell Layout

## Sources Reviewed
- docs/requirements.md
- docs/audit.md
- docs/SDS.md
- AGENTS.md
- docs/track-a.md
- docs/ticket-tracker.md
- SPA/index.html
- SPA/main.js
- SPA/assets/css/main.css
- SPA/tests/unit/main.test.js

## Scope Guard
- Implement only ticket A04 (Persistent App Shell Layout).
- Preserve A03 route behavior (matching, deep links, history navigation).
- Do not implement A05 auth-gating changes beyond current bootstrap behavior.
- Do not implement A06 logout API behavior; include persistent logout UI location only.

## Files To Modify
- SPA/main.js
  - Add authenticated shell rendering that persists across protected route transitions.
  - Keep public routes (login/register) outside the authenticated shell.
  - Add stable shell regions: header, logout control location, content outlet, chat sidebar containers.
- SPA/index.html
  - Keep single SPA entry and app root.
  - Ensure shell can be mounted under the existing root without introducing extra HTML pages.
- SPA/assets/css/main.css
  - Add shell layout and responsive behavior.
  - Reserve stable chat sidebar containers for roster and active chat.
- SPA/tests/unit/main.test.js
  - Add A04 assertions for shell persistence, always-visible nav/logout location, and reserved chat regions.

## API And WS Contracts
- REST used: GET /api/v1/users/me
  - Role in A04: decide whether public view or authenticated shell is rendered on boot.
  - No new request/response shapes introduced in this ticket.
- WebSocket: N/A in A04
  - Reason: A04 only reserves layout containers for chat; no live chat transport wiring in scope.

## DB Schema Migrations
- N/A for A04.
- Reason: this ticket is frontend shell/layout only.

## Verification Checklist (Pass/Fail)
- [ ] authenticated routes render inside a shared shell
  - Pass: protected routes (/, /post/:id, /create-post, /edit-post/:id, /activity) render inside one common shell wrapper.
  - Fail: protected screens render as standalone pages without shared frame.
- [ ] navigation and logout remain visible during route changes
  - Pass: forum navigation and logout control location remain present while navigating protected routes.
  - Fail: nav or logout disappears on some protected routes.
- [ ] layout reserves a stable location for chat
  - Pass: protected routes always include dedicated roster and active-chat containers in a fixed sidebar area.
  - Fail: chat containers are missing or route-dependent.

## Test Plan
1. bun run test SPA/tests/unit/main.test.js
   - Proves existing A03 behavior still passes and new A04 checks pass.
2. bun run test
   - Proves broader frontend test suite regression safety.
3. make test
   - Proves project-wide Go and integration tests remain green after A04 frontend changes.

## Risks And Assumptions
- Assumption: A06 will wire the logout action later; A04 provides persistent placement now.
- Risk: render refactor may accidentally regress route access handling.
- Risk: responsive shell CSS may affect existing spacing in route content.
- Mitigation: keep route matching logic intact and add targeted shell persistence tests.
