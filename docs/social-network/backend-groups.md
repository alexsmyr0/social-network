# Groups and membership transitions — SN-B18

Implementation on `asmyrogl/b18`, branched from B17 `7906855` (itself based on merged main `e331ca0`). The [owner-approved groups contract](groups-contract.md), [Phase 4 data plan](phase-4-data-plan.md) and [fixture pack](fixtures/phase-4-contract.json) control these changes. This record covers the working tree, not an untested later revision.

## Delivered boundary

B18 owns group persistence, discovery, member lists, invitations, join requests, creator removal, leave, the invitation/request notices and their post-commit signals. B19 still owns `posts.group_id` (migration 000007), every content, media, aggregate and content-notice consumer. No Vue code, group content, events, chat or new queue, socket, database or service is introduced.

| Concern | Implementation |
|---|---|
| [Migration 000006](../../internal/db/migrations/sqlite/000006_groups.up.sql) | `groups`, `group_memberships`, `group_invitations`, `group_join_requests`; `notifications` rebuilt (two new types, `group_id`, historical `group_entry_id`, `group_state`) with IDs, `sqlite_sequence`, indexes and every existing column preserved and copy-checked before the swap. Ordinary transaction path: nothing references `notifications`, so no foreign-key disabling. |
| [Repository](../../internal/db/groups.go) | Reads (`ListGroups`, `GetGroup`, `ListGroupMembers`, `ListGroupJoinRequests`, `ListGroupInvitations`) and serialized writers (`CreateGroup`, `CreateGroupInvitation`, `DecideGroupInvitation`, `CreateGroupJoinRequest`, `DecideGroupJoinRequest`, `RemoveGroupMembership`). Every writer takes `BeginSocialWrite` before reading, repeats role and state checks, inserts/reconciles notices in the same transaction, then signals after commit. |
| [HTTP adapters](../../internal/handlers/groups.go) | Strict bodies/queries, exact `Allow` lists before Origin/CSRF (`GroupMethods`), field validation, pinned error codes/messages. [`socialQueryValues`](../../internal/handlers/profiles.go) was factored out of `socialQuery` so `GET /groups` can add its own `membership` key. |
| [Notices](../../internal/db/social_notifications.go) | `group_invitation` / `group_join_request` appear in list, total, unread, read-one and read-all like follow notices; actions exist only while the exact entry is live for the recipient. |
| [Router](../../internal/router/router.go) | `/groups`, `/groups/{id}[/members|/invitations|/join-requests]`, `/group-invitations/{id}`, `/group-join-requests/{id}`, `/group-memberships/{id}`, `/users/me/group-invitations`. |
| [QA reset](../../internal/db/seeds/00_reset.sql) | Deletes groups (children cascade) and resets their allocation before users. |

## Behavior notes beyond the contract text

- **Database backstops.** Triggers insert the creator membership with every group, make membership rows insert/delete only, retain the creator row, delete a person's pending invitation/request when a membership is inserted, and delete a departing inviter's invitations. The writers reconcile notices *before* those deletes, so a raw write can never leave a usable invitation from a non-member, but only the writers keep notice history exact.
- **Groups with an inactive creator** are hidden from discovery and detail (the Reads table says active-creator groups); membership rows are retained. Inactive inviters make their invitations unusable (`409 STALE_INVITATION`) and hide them from the invitee's reads. Nothing is deleted on deactivation.
- **Memberships and entries cascade with their group**, while `groups.creator_id` and `notifications.group_id` are `RESTRICT`: a group with notice history cannot be deleted. No delete route exists.
- **Signals** are computed from what the transaction changed: users named by changed memberships/entries/notices plus every active member when a membership row was inserted or deleted; group creation signals all sockets. Duplicates, denials, stale actions and rollbacks send nothing.

## B19 handoff

- **Predicate seams.** `db.GroupMemberSQL(groupExpr, userExpr)` is the SQL membership predicate (active user, current membership); `db.IsGroupMember` is its query form. The shared content predicate must choose by `p.group_id IS NULL` (personal rules) versus membership (group rules), never OR them.
- **Notice seam.** `visibleNotice` in `social_notifications.go` treats `follow_request`, `group_invitation` and `group_join_request` as always visible to their recipient; group-content notices must additionally require current membership at list, count, unread, read-one and read-all time, and no notice is inserted for a recipient who is not a current member.
- **Invalidation seam.** Content changes keep the existing all-authenticated `social.invalidate`; membership transitions already invalidate the affected users and current members through `fireSocialInvalidation`.
- **Schema seam.** Migration 000007 only adds `posts.group_id`, its partial index and triggers; `groups` exists and `notifications.group_id` already references it. Content tables are not touched here.
- **Fixture harness.** `internal/tests/groups_contract_test.go` replays every B18-owned pack case and filters out content routes; B19 can reuse `loadGroupPack`, `seedGroupFixture` (extend it with posts/comments/media) and `runGroupRequest`.

## Upgrade and recovery

A pre-B18 database (version 5) gains the group tables empty, keeps every personal row, notice, notification ID and `sqlite_sequence` value, and passes `foreign_key_check`. A failed migration leaves data and schema unchanged, marks version 6 dirty and blocks readiness until repaired; the normal connection keeps foreign keys on. Back up the SQLite file and `MEDIA_ROOT` first, as the [migration guide](backend-migrations.md) requires. The down migration refuses once any group, membership, entry or group notice exists; with none it rebuilds the previous notification constraint and round-trips.

## Verification record — 2026-10-09

Gate runs on the working tree based on `7906855`:

- `go test ./internal/tests -run TestGroupContractFixtures` — **205/205** B18-owned pack cases through the real router and migrated SQLite: exact bodies, headers, persisted postconditions, unchanged-state snapshots and exact `social.invalidate`/`notification.new` recipients; plus all **5** pack journeys and every serial order of the **8** group races (content-writing races stay with B19).
- `TestGroupConcurrentRacesPreserveOneValidResult` — each race fired concurrently 12 times; every outcome matches one serial order and the invariants hold. `TestGroupParallelWritersKeepInvariants` — 8 workers × 60 random group writes with no server error and no invariant violation (no duplicate membership, one creator, no pending entry from a non-member or to a member, pending notice ⇔ live entry, resolved notices read).
- `TestGroupAtomicNoticeFailureRollsBackSilently` — injected failures in notice insert/update and membership insert/delete roll back all eight writers with no state change and no signal. `TestGroupForgedAndConfusedIdentitiesCannotAdmit` — wrong participants, notice IDs used as credentials, creator departure and duplicate accepts admit nobody. `TestGroupRealAccountsRestartAndMissedSignalRecovery` — registered accounts, repeated restarts and no sockets: pending work is recovered by reads, resolved identities stay stale and IDs never decrease. `TestGroupSocketSignalsAreRecipientScopedAndPayloadFree` — real sockets receive exactly the scoped payload-free frames.
- `go test ./internal/db -run 'TestGroup|TestQASeed'` — upgrade preservation (including the deleted high notification ID), failed-migration atomicity and dirty-readiness block, raw-write invariants, notice constraints, ID non-reuse, down-migration refusal and round trip, QA reset.
- `go test ./...` passes (including the 246 earlier fixtures and every Phase 1–3 test); `go test -race ./internal/tests -run TestGroup` and `go test -race ./internal/db ./internal/handlers ./internal/router ./internal/ws` pass; `make build lint fmt-check vet` pass. Native `make test-frontend` (Vitest **1177/1177**) and `make test-e2e` (Playwright **47/47**, run against the built backend on the migrated schema) pass. The full-tree `-race` sweep over `./internal/tests` was not run (about nine times slower; the group tests were run under `-race` directly).

Not verified: Docker was not started, so the container images and two-image real-service suites are **unverified** for this tree. Content, media and content-notice enforcement for groups remains B19 work before Phase 4 acceptance; Phase 5 behavior is not required.
