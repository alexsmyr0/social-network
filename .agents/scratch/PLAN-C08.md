# PLAN-C08 — Backend Test Coverage for Auth, Messaging, and Presence

Source: RTF-26 | Phase: P4 | Depends on: C11, A05, C01, C03, C04, C05, C06 | Blocks: D07
Branch: `medvall/C08` (off `main`)

## Key finding (from coverage audit)

The C08 verification gate is **already satisfied** by tests delivered in C03–C06:

| Gate clause | Proving tests |
|---|---|
| Major auth flows covered | `users_test.go` (register valid + 15 invalid/profile cases, wrong-password, non-existent user/email, logout, `/me` no/invalid cookie), `forum_auth_access_test.go` |
| **Both login modes explicitly tested** | `TestUserLoginByUsername`, `TestUserLoginByEmail` |
| Major chat flows covered | `chat_roster_test.go`, `chat_history_test.go`, `dm_send_test.go`, `ws_test.go` (WS auth: unauthenticated + invalid session → 401) |
| **Offline-recipient covered** | `TestDMSend_RecipientOfflineRejected` |
| **Multi-connection presence covered** | `TestPresence_SecondTabDoesNotBroadcast`, `TestPresence_NonLastDisconnectDoesNotBroadcast`, `TestWebSocket_MultiTab` |

Overall backend coverage 62.4%; core auth/chat/presence functions 85–100%.

So C08 is **not** a "write the missing flow tests" ticket — those exist. C08's
deliverable is: (a) close the genuinely-untested real paths, and (b) a coverage
report that maps each gate clause to its proving tests.

## Scope (real gaps only — no over-engineering)

Add tests that assert real behavior; explicitly skip dead/trivial/redundant code.

1. **`CleanupSessions` (0% → covered).** Wired into backend startup
   (`cmd/backend/server.go:52`) but untested. DB-layer test: seed a valid,
   an invalidated (`is_valid=0`), and an expired (`expires_at` in the past)
   session, run `CleanupSessions`, assert only the valid one survives.
2. **Single-active-session invalidation.** `CreateSession`
   (`internal/db/sessions.go:56-63`) bumps `session_version` and invalidates all
   prior sessions. Behavioral test through the HTTP API: login → token1, login
   again → token2; `token1` `/me` → 401, `token2` `/me` → 200. Covers
   `bumpSessionVersionTx` + `invalidateUserSessionsTx`.
3. **`Register`/`Login` malformed-body branch (→ 400).** Genuine handler error
   path currently uncovered.
4. **`Register`/`Login` route method contract (→ 405).** GET on the POST-only
   auth routes returns 405 (via `AllowMethods`). Asserts the route contract.

### Explicitly NOT doing
- **`OptionalAuth` (0%)** — dead code (defined, never called). Testing it would
  pin code that should be deleted. Flag for removal instead, do not test.
- Handler internal method-checks unreachable behind `AllowMethods` — not tested
  (testing unreachable code).
- No re-assertion of flows already covered by C03–C06 tests.

## Files
- `internal/tests/session_lifecycle_test.go` (new) — CleanupSessions +
  single-active-session invalidation.
- `internal/tests/auth_errors_test.go` (new) — malformed-body + wrong-method
  for register/login.
- `docs/pr-message/C08-Backend-Test-Coverage-pr.md` (new) — gate→test mapping +
  coverage figures.
- `docs/ticket-tracker.md` — C08 → `[x]`.

## Verification gate checklist
- [ ] Major auth + chat flows covered — confirmed mapped to existing tests.
- [ ] Both login modes explicitly tested — `TestUserLoginByUsername` + `TestUserLoginByEmail`.
- [ ] Offline-recipient + multi-connection presence — confirmed mapped.
- [ ] New gap tests pass; `go build`, `go vet`, `go test ./internal/...` (+ `-race`) green.
- [ ] Independent cold-start audit: PASS.
