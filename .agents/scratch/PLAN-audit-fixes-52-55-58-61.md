# PLAN — Audit fixes: Gitea issues #52, #55, #58, #61

Combined branch `medvall/audit-fixes-52-55-58-61` (one PR), resolving four
deduplicated-audit findings. Source for all four:
`docs/audit-reports/deduplicated-audit-report-2026-07-14.md`.

Scope decisions (confirmed with owner):
- **#52** — do the **whole** issue, including the two Track-D frontend sub-bugs.
- Structure — **one combined branch/PR** (mirrors `ekaramet/A-54…` which grouped #54+#64).

Execution order chosen for least churn / independence: **#61 → #58 → #55 → #52**.

---

## #61 — Remove retained OAuth backend (DEAD, Low)

Dead product/attack surface; never surfaced by the SPA (a SPA test already
asserts the shell never references `/api/v1/auth/google|github`). Verified: the
four handlers are referenced *only* by their route registrations, and
`internal/auth` is imported *only* by the two OAuth handler files.

Changes:
- Delete the 4 route blocks in `internal/router/router.go` (`/auth/google[/callback]`, `/auth/github[/callback]`).
- Delete `internal/handlers/oauth_google.go`, `oauth_github.go`, `oauth_helpers.go`, `internal/auth/oauth.go` (and the now-empty `internal/auth` pkg).
- Keep OAuth DB tables (SDS §8 permits).
- Verify: `go build ./...`, `go vet ./...`, full test suite; grep for stragglers.

## #58 — Backend layering & auth-convention drift (C+A, all Low)

- `AGENTS.md` middleware doc: remove `OptionalAuth` (already deleted in C08) and
  correct the order to the actual runtime flow (Recoverer → Logger → CORS; Auth is per-route).
- Remove the `Authorization: Bearer` fallback in `internal/middleware/auth.go`
  (cookie-only by design; verified no test uses Bearer — all use `Cookie: session_token`).
- Add `ctx context.Context` as the first param to `InitDB`/`ApplyQASeeds` in
  `internal/db/db.go` and update callers.

## #55 — WebSocket hardening (Track C)

- **panic recovery (Medium):** add `defer recover()` to `readPump` and `writePump`
  so one panic drops only that connection instead of crashing the process.
- **CheckOrigin allowlist (Low):** validate `Origin` against the configured
  frontend origin instead of returning `true`.
- **`/ws` Auth wrapper (Low):** acceptable-by-design (handler re-validates the
  cookie). Leave behavior; only a clarifying note. No code change.
- **dropped frames on full buffer (Low):** the drop is documented, intentional
  policy. Keep semantics; add an observability log/comment. (No untrusted trigger today.)

## #52 — Chat data bugs (mostly Track D)

- **History pagination dead-end (D):** `fetchConversation` returns
  `{messages:[],hasMore:false}` for *every* failure → `loadOlderHistory` freezes
  scroll-up forever. Distinguish transient failure from genuine end-of-history.
  Files: `SPA/features/chat/chat.conversation.api.js`, `chat.conversation.page.js`.
- **Orphaned `isLoading` on switch (D):** reset `state.isLoading` in the abandon
  path of the switch guard. `chat.conversation.page.js`.
- **Blank roster preview for image-only DMs (C+D):** `GetChatRoster` `latest` CTE
  never selects `image_path`; fall back to `[image]`/glyph in SQL and in
  `moveToTopForMessage`. `internal/db/messages.go`, `chat.roster.logic.js`.
  NOTE: near no-op today (body currently required), but aligns with the schema.

---

## Verification (per issue + final)

- Backend: `go build ./...`, `go vet ./...`, `gofmt -l`, `go test ./internal/...`.
- Frontend (#52): the SPA unit/e2e suite for chat conversation + roster.
- Independent cold-start audit subagent (must NOT read this PLAN) against
  `docs/SDS.md`, `docs/requirements.md`, `docs/audit.md`, `AGENTS.md`.

## Closure

- PR message in `docs/pr-message/` using `pr-template.md`; reference issues #52/#55/#58/#61.
- Update `docs/ticket-tracker.md` if these map to tracked rows.
- **No commit/push without explicit owner approval.**
