# Relationship notifications — SN-B12

Implementation on `asmyrogl/B12`, based on merged B11 at `6a650e9`. The [approved contract](profiles-contract.md#durable-notifications-and-read-actions) owns interfaces; [tracker](ticket-tracker.md) owns status. This delivers durable follow requests, current recipient-authorized notification reads/actions, and socket refresh signals. Vue rendering remains A10; complete browser acceptance remains A11 after B13 protects inherited content/media routes.

## Storage and transactions

[Migration 000003](../../internal/db/migrations/sqlite/000003_relationship_notifications.up.sql) rebuilds notification target constraints, preserving existing IDs, types, timestamps, read flags, deduplication and the AUTOINCREMENT high-water mark, including deleted historical IDs. Copy verification runs before dropping the source. Existing pending follows receive one unread request notice with their original creation time; startup never broadcasts historical inserts. `follow_id` is a durable historical identity, deliberately without a foreign key to a row deleted on cancellation/unfollow. Recipient/actor/content foreign keys remain enforced.

The rebuild follows SQLite's [create/copy/drop/rename procedure](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes). No table references notifications, so its rebuild keeps foreign-key enforcement enabled. Existing [migration recovery rules](backend-migrations.md) apply: dirty/failed versions refuse startup; back up consistent DB/media before upgrading. Version 3's down migration deliberately refuses a lossy downgrade. Restore a coordinated pre-upgrade backup instead of deleting notification history.

[Follow transactions](../../internal/db/follows.go) insert the pending notice with its request and reconcile accept, decline, cancel, unfollow and private→public auto-accept inside the same serialized writer transaction. Resolved notices become read history without controls. Retry creates a new follow/notice identity; old actions cannot affect it. Public follows and accepted-follow transitions introduce no extra notification type. Duplicate creation and repeated acceptance emit no new-notice signal. Caller-owned `*Tx` functions remain transport-free; production wrappers commit before invoking hooks.

## Authorized HTTP behavior

[Notification queries](../../internal/db/social_notifications.go) project actor identities through B11's current profile access rules. Private actors retain only name/routing/control fields; compatibility usernames, emails and other registration fields never enter the response. Follow request actions require the exact current pending follow ID and participants. Marking a pending notice read keeps its controls and relationship unchanged.

Inherited content notices require an active author, a published existing parent post and current profile permission. Comment reactions resolve their actual parent post and a plain-text excerpt capped at 20 Unicode code points. Old `comment` notices without a stored comment ID return only the post target: no guessed latest-comment excerpt. B16 extends this predicate when audiences exist.

List rows, total, unread total across all pages and actor projections share one read snapshot. Authorization filters run before pagination/counts. Read-one checks the same filter; read-all atomically changes only visible recipient notices. Hidden read flags stay stored and reappear unchanged when access returns. Foreign/hidden/missing notices return the same 404; unavailable storage returns 5xx. Routes reuse strict pagination/query/ID/body validation, session admission, method-before-Origin/header ordering and no-store responses. Legacy unversioned forum test fixtures retain their original notification interface.

## A10 socket and recovery handoff

The existing `/ws` sends these exact empty frames:

```json
{"type":"notification.new"}
{"type":"social.invalidate"}
```

A newly committed request sends `notification.new` only to its recipient's sessions, followed by `social.invalidate` to both participants. Cancel/decline/accept/unfollow refresh both participants; read-one/read-all refresh all recipient sessions. Actual privacy switches broadcast invalidation to every authenticated socket because public viewers may hold affected data. No-op privacy writes, duplicate creation, rollback and failed commits stay silent. Existing comment/reaction notification and DM frame types remain compatible.

Hooks are wired in [backend startup](../../cmd/backend/server.go), using [hub delivery](../../internal/ws/connection_manager.go). Delivery is best effort: offline/full buffers lose signals, never stored state or successful HTTP responses. The [socket writer](../../internal/handlers/ws.go) rechecks outbound social session/account validity under the same admission gate used by logout. Revocation closes only that token's sockets; independent device sessions continue receiving frames. Social sessions have no age-based expiry.

A10 should refetch notifications/unread/request inbox on first connection, reconnect, focus and signals. Discard protected caches during revalidation, coalesce bursts and discard superseded HTTP responses. Keep the approved 60-second fallback refetch on visible protected screens. A 401 clears protected state/socket; network/5xx presents unavailable state with retry. There are no payload IDs, counts, presence, names or excerpts, and no acknowledgement/replay protocol. [Approved fixture examples](fixtures/phase-2-contract.json) remain the exact frontend handoff.

## Verification record

Commands and results below describe the working tree based on `6a650e9`, checked on 2026-10-03. They do not claim full Phase 2 browser/image acceptance or hosted CI.

- `go test ./internal/db -run 'TestRelationship|TestSocialNotice' -count=1` passed: version-2 upgrade/restart, IDs/read flags/timestamps/FKs/high-water allocation, pending backfill, target constraints, atomic failure/rollback, resolution/retry, concurrent transitions and authorized pagination/read-state recovery.
- `go test ./internal/tests -run 'TestSocialNotificationSockets|TestSocialProfilesAndNotifications|TestSocialNotificationValidation' -count=1` passed: 87 runnable approved HTTP fixtures (72 previous profile/follow fixtures plus 15 notification fixtures), mutation notice postconditions, strict validation, recipient denial and real multi-session sockets. Socket checks cover committed-state visibility, rollback/duplicate silence, recipient/participant isolation, read refresh, revocation/inactive accounts, compatible comment/reaction/DM delivery, disconnect/refetch and persistent backend restart.
- `go test -race ./internal/db ./internal/handlers ./internal/ws ./internal/tests -run 'TestRelationshipNotification|TestSocialNotice|TestSocialNotification|TestSocialProfilesAndNotifications' -count=1` passed. macOS linker emitted existing LC_DYSYMTAB warnings; every selected package passed.

The first socket test incorrectly treated legacy `expires_at` as an active social-session expiry policy; that assertion was corrected to cover inactive-account revocation, preserving the approved persistent-session contract. Initial full Go run failed only that assertion; subsequent final gate results are recorded below.

Final verification after code/test cleanup on 2026-10-03:

- `make test` exited 0: backend/frontend native builds, Biome, gofmt, vet, complete Go suites, scoped race packages, Vitest 540/540 with coverage and native Playwright 15/15. Disposable browser services were stopped by the harness.
- The focused race command above passed again, including the deferred-COMMIT failure test: no follow/notice survived and neither delivery hook fired.
- Documentation checks passed: 727 local links/anchors, 36 unique tickets with 20 complete and 16 unstarted, docs-consistency Vitest 10/10, and tracked/new-file whitespace checks.
- Docker images and hosted CI were not run for B12. Full Phase 2 browser/image acceptance remains SN-A11; inherited content/media enforcement remains SN-B13.
