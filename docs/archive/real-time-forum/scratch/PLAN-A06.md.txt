# PLAN-A06: Global Logout Across the Forum

Ticket: A06 (RTF-09)
Depends on: A04, A05
Blocks: D05

## Source-of-truth scope
- AGENTS.md
- docs/requirements.md
- docs/audit.md
- docs/SDS.md
- docs/PRD.md
- docs/track-a.md (A06)

## Current state summary
- Backend logout contract already exists at POST /api/v1/users/logout and invalidates session cookie server-side.
- Shell already renders a persistent logout button (`data-action="logout"`) across protected routes.
- Missing A06 behavior in SPA app controller: clicking logout currently does not call API, clear auth state, or redirect to auth flow.
- Existing unit tests cover visibility of logout button but not functional logout flow.

## Files to modify
1. SPA/core/app/create-app.js
- Add a logout action handler in global click delegation for `[data-action="logout"]`.
- Call POST /api/v1/users/logout with cookie credentials.
- On success, set app auth state to unauthenticated and redirect to /login using replace navigation.
- Keep link navigation behavior unchanged.

2. SPA/tests/unit/main.test.js
- Extend test harness to support clicking a logout action.
- Add/extend tests to verify:
  - logout API call is made with expected method and credentials.
  - user is redirected to /login after successful logout.
  - protected shell no longer renders after logout (auth flow visible).
  - logout remains accessible from protected routes (existing checks retained).

3. docs/ticket-tracker.md (Phase 4)
- Mark A06 as complete once verification gate and tests pass.

4. docs/pr-message/A06-Global-Logout-Across-the-Forum-pr.md (Phase 4)
- Add PR summary using docs/pr-message/pr-template.md structure.

## API/WS contracts involved
REST:
- POST /api/v1/users/logout
  - Request headers: Accept: application/json
  - Request credentials: include (session cookie)
  - Response success (200): `{ "data": { "message": "logout successful" }, "error": null }`
  - Side effects: invalidates current session and expires `session_token` cookie.

- GET /api/v1/users/me
  - Used for auth gating already in boot flow and to assert unauthenticated post-logout behavior.

WebSocket:
- No WebSocket contract changes for A06.

## DB schema / migration impact
- None. A06 uses existing `sessions` table and repository invalidation flow.

## Verification-gate checklist (pass/fail)
1. Logout is visible and usable from every authenticated route.
2. Logout clears the session and returns the user to auth flow.
3. Logout no longer depends on create/edit page layout.

Operational checks mapped to gate:
- [ ] Protected routes render shell logout action (`/`, `/post/:id`, `/create-post`, `/edit-post/:id`, `/activity`).
- [ ] Clicking logout triggers POST /api/v1/users/logout exactly once per click.
- [ ] After logout success, SPA route becomes /login via replace navigation.
- [ ] After logout, rendered view is public/auth flow, not authenticated shell.
- [ ] Existing auth guard still blocks protected routes when unauthenticated.

## Implementation notes
- Keep changes minimal in app controller to preserve A03/A04/A05 behavior.
- Prefer centralized event delegation in create-app.js over page-specific handlers.
- Keep dependency footprint unchanged.

## Phase test gates
- Backend gate for phase consistency: `make test` must pass.
- Frontend gate for phase consistency: `bun run policy` must pass.
- A06-targeted evidence: SPA unit test(s) for logout behavior in SPA/tests.
