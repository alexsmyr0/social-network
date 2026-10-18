# Group events, responses and notices — SN-B21

Implemented on `asmyrogl/B21`, working tree based on B20 `9a6cd4d`. Owner approved the complete [Phase 5 contract](events-chat-contract.md#approval-and-verification-record), [data plan](phase-5-data-plan.md), policies and fixtures on 2026-10-18, including B21 → B22 migration ordering. No second human approval is required.

## Delivered behavior

- [Migration 8](../../internal/db/migrations/sqlite/000008_group_events.up.sql) creates immutable events and membership-generation responses. The notification rebuild copies every prior column and ID, compares row counts and both EXCEPT directions before swapping, preserves allocation above deleted IDs, recreates all six prior indexes and adds event uniqueness. Foreign keys stay enabled and are checked before commit. Applied migrations 1–7 remain unchanged. Downgrade refuses while event data exists; QA-only reset removes responses/events before groups.
- [Repository](../../internal/db/group_events.go) reuses B18's active membership/group visibility check in each read snapshot and serialized write. Event list order is `(starts_at,id)` ascending, including past events. Response pages/counts include current active membership generations only. Departure retains events and responses; readmission starts unanswered. Inactive event authors use `Unavailable account`; group creator inactivity retains B18's visibility restriction.
- [HTTP adapter](../../internal/handlers/group_events.go) serves the five approved routes: collection GET/POST, detail GET, responses GET and own response PUT under `/api/v1/groups/{id}/events`. Strict JSON/query/body/field validation, safe integer bounds, Unicode code-point text limits and whole-second, offset-qualified UTC instants follow the contract. Methods precede origin/header/session checks; immutable routes return exact Allow lists. Stale membership or response versions return 409 without mutation.
- Creation commits the event and exactly one notice per current active member except its creator, with no automatic response. Only after commit do recipients receive empty `notification.new` and current members receive empty `social.invalidate`. Responses emit invalidation only. No signal loss can remove committed state.
- [Notification consumers](../../internal/db/social_notifications.go) share current membership, active group creator and event/group consistency checks across list, totals, unread, read-one and read-all. Hidden notices retain flags, and readmission restores them. Targets expose event/group references and no response action; actor projection retains existing People redaction.

## Verification record — 2026-10-18

Commands run on the working tree based on `9a6cd4d`:

- `go test ./internal/db ./internal/tests -run 'TestGroupEvent|TestGroupDownMigration' -count=1` passes. All **85 B21 HTTP fixtures** replay through the real router and migrated SQLite: exact shapes/fields/status, postconditions, no-store, signal recipients and unchanged-state assertions. New event validation/not-found/conflict messages are exact; inherited common error wording uses the existing fixture normalization. Additional tests cover strict JSON/Unicode/time/size boundaries, auth/origin/method precedence and UTC normalization.
- Migration tests cover fresh startup, sources **1–7**, populated schema-7 preservation of every existing table column and media bytes, notice read flags and allocation, all indexes/FKs, repeated startup, **five injected failure boundaries**, dirty-readiness refusal, lossy downgrade refusal and empty round trip. Historical migration fixture builders stop before later migrations; the B18 downgrade test unwinds schema 8 first.
- Repository/API tests cover removal/readmission, stale generation/version, both serial orders and concurrent execution of removal versus create/response and competing responses, overflow, rollback silence, inactive accounts, sorting/paging and forged associations. Event/response/notice/read state survives database close/reopen. A fetch recovers committed state without socket signals.
- Real WebSocket tests cover recipient-only empty notice signals, member invalidation, two sessions for one member, outsider silence, separate-connection proof of commit before signal, rollback silence and authoritative recovery after dropped signals.
- `go test -race ./internal/db ./internal/tests -run TestGroupEvent -count=1` passes. The macOS linker emits its existing LC_DYSYMTAB warning; execution passes.
- `python3 docs/social-network/fixtures/validate-phase-5.py` passes the approved artifact pack and all 44 ticket dependencies/reverse edges/links. Documentation consistency tests pass (10/10); `git diff --check` passes.

`make test` passes: backend/frontend builds, Biome, Go format/vet, full Go suite, shared race gate, **Vitest 2100/2100** and **native Playwright 62/62**. Scoped B21 race tests also pass as recorded above. No hosted CI run is claimed.

Docker was stopped and was not started. Image/container checks and real-browser Phase 5 acceptance are unverified here; SN-A21 owns the integrated gate.

## Handoff

SN-A18 consumes the approved event DTOs, fixed options, membership IDs and response versions. On a conflict, refetch before an explicit new choice; uncertain creation requires list/detail recovery before a deliberate retry. SN-B22 starts after migration 8 and owns migration 9. SN-A21 combines events with the later messaging tickets through B07's real-service harness. Event editing/cancellation, extra options, chat and Vue UI are outside B21.
