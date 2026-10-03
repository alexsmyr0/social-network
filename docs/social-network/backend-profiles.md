# Backend profiles and follows — SN-B11

Implementation on `asmyrogl/B11`, branched from B10 commit `09562ab`. The [approved contract](profiles-contract.md) owns public interfaces; the [tracker](ticket-tracker.md) owns ticket status. This delivers profiles, discovery, follower lists, avatar permissions and follow/privacy writes. B12 adds notification transactions/signals; B13 applies these permissions to inherited content and attachment routes. Profile privacy is not yet a complete application-wide boundary.

## Storage and upgrade

[Migration 000002](../../internal/db/migrations/sqlite/000002_profiles_follows.up.sql) adds public-by-default profile visibility, version 1, Unicode display-name search keys and a single pending/accepted directional follow table. Foreign keys, unique ordered pairs, no self-follow, state/timestamp consistency and safe JSON integer bounds are enforced. AUTOINCREMENT prevents a removed follow ID from being reused; accepting preserves its ID.

Startup uses existing numbered migrations, then [search-key reconciliation](../../internal/db/profiles.go) before readiness. Go Unicode lowercase supports international names; `instr` performs literal substring matching without SQL wildcard semantics. Registrations populate their search key in the account/session transaction. QA seeds reconcile keys after their reset in the same seed transaction. Existing account/session/content/notification rows and avatar references/bytes are preserved.

SQL migration failure leaves the recorded version dirty and refuses readiness under [existing recovery rules](backend-migrations.md). Search reconciliation failure also refuses readiness, but does not mark a successfully applied SQL migration dirty; fix the underlying fault and restart to retry the atomic backfill. Never delete data or force the recorded version to make startup succeed. The down migration discards relationships/privacy settings and is operator-only; use a coordinated backup for rollback once social data exists.

## Authorized reads and writes

[Profile queries](../../internal/db/profiles.go) reuse `CanViewProfile`: active owner, public subject or accepted viewer→subject relationship. Other private viewers receive only identity/name/control teasers. Pending requests grant no details or avatar access. Directory/list entries project every member independently; permission to see a list does not broaden access to its private members. Filters/counts/pagination use a single read snapshot. Owner-only version appears only on owner social Profile; registration/login/current-user and compatibility Account serializers keep their Phase 1 shape.

[Handlers](../../internal/handlers/profiles.go) provide the contract routes and strict body/query/ID validation. Same-origin/header enforcement and [session admission](../../internal/middleware/auth.go) remain in the router/middleware. Missing/revoked sessions fail 401, hidden resources and wrong participants 404, stale request/profile actions 409, and database lock exhaustion 503. All new routes and avatar successes/errors are no-store.

Public follow is immediately accepted; private follow is pending. Duplicate creation returns the same current ID without another row. Only the recipient accepts/declines; only the sender cancels/unfollows. Old IDs cannot act on a replacement relationship. Public→private retains accepted follows; private→public accepts all current incoming pending rows atomically. Privacy versions reject outdated writes even if their submitted value matches current visibility.

## Transaction handoff to B12 and B13

[Follows](../../internal/db/follows.go) exposes `BeginSocialWrite` plus `CreateFollowTx`, `RemoveFollowTx`, `DecideFollowTx` and `ChangePrivacyTx`. The caller owns commit/rollback. The transaction starts with a zero-row UPDATE to acquire SQLite's writer lock before inspecting privacy or relationship state; it changes no rows and keeps unrelated reads as deferred snapshots. This follows [SQLite's transaction rules](https://www.sqlite.org/lang_transaction.html). Returned follow identities and auto-accepted follow lists let B12 reconcile notices inside the same transaction, then signal after commit. The current wrappers commit relationship state only; no B12 schema or live delivery is introduced.

B13 can reuse `CanViewProfile` with a database or caller-owned transaction/snapshot. Avatar key lookup checks permission and resource reference in one snapshot; every subsequent request re-evaluates access. B15 later extends unfollow transactions to remove selected-post associations when that table exists. B11 never references future tables.

## Verification record

Checks are recorded against the working tree based on `09562ab`; commands below are evidence only after their results are recorded. [API fixtures](../../internal/tests/social_profiles_test.go) exercise the approved B10 HTTP examples against real SQLite/router services, checking status, headers, redacted/full bodies and follow/privacy postconditions. Notification/transport-failure injection cases remain outside that fixture subset. [Repository tests](../../internal/db/profiles_test.go) cover upgrade/restart preservation, failed migration/backfill, constraints, stale IDs, concurrent creation/privacy changes and caller-owned transaction rollback. Existing avatar tests now assert public access followed by private denial; the retained A07 PNG check expects the approved public default.

Initial `go test ./...` passed, including inherited regressions. `go vet ./...`, `git diff --check`, and `bun x biome check SPA/tests/e2e/a07-acceptance.test.js` passed. Final focused/race/regression results are below. Image/browser acceptance of complete Phase 2 remains A11 after B12/B13.

Final verification on 2026-10-02, working tree on `asmyrogl/B11` based on `09562ab`:

- `go test ./internal/db ./internal/tests -run 'TestProfiles|TestSocialProfiles' -count=1` passed, including 72 B10 HTTP fixture cases and explicit privacy/session revocation checks.
- `make test` exited 0 after the final code changes: both native builds, Biome, gofmt, vet, all Go suites and scoped race packages, Vitest 540/540 with coverage, and native Playwright 15/15. The macOS race linker emitted LC_DYSYMTAB warnings; affected packages still passed. Native browser services used disposable test data and were stopped by the harness.
- The initial Phase 1 avatar test failed because it expected foreign public avatars to return 404; it was adapted to verify public access then private denial, and the final suite passed. The A07 image browser PNG expectation was updated to the public default; that image-only suite was not run in this ticket.
- Documentation checks passed: 691 local links/anchors, JSON/fixture consistency, the 36-ticket dependency graph and reverse edges, completion counts/prerequisites, B10 branch ancestry, and tracked/untracked whitespace. Docker image checks and full Phase 2 real-browser acceptance remain unverified here and belong to later integration gates.

No new dependencies, frontend component changes, notification types or inherited-content authorization are included. B12 consumes the transaction seam; B13 closes the remaining retained-content/media exposure paths.
