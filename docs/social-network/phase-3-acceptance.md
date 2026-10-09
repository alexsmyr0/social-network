# Phase 3 integrated acceptance — SN-A14

Implementation on `chbaikas/A14`, based on merged main `92df197` (A13 and B16 included). The [content contract](content-contract.md), [Phase 3 data plan](phase-3-data-plan.md) and [Phase 2–3 decisions](phase-2-3-decisions.md) control expectations. Status lives in the [tracker](ticket-tracker.md). Acceptance remains in progress until the required local and hosted gates pass.

## Execution boundary

[Real-service A14 journeys](../../SPA/tests/e2e/a14-acceptance.test.js) use the existing [B07 two-image harness](shared-runtime.md). Each journey registers unique accounts through real HTTP into disposable SQLite/media storage. Independent browser contexts own real session cookies; no HTTP, socket, account, relationship, content or notice fixtures are mocked. The checked-in PNG is uploaded and compared byte-for-byte. Container recreation refuses any project outside the isolated `sn-b07-test-*` naming convention. Docker was already running; this work did not start the daemon. No shared deployment or CI architecture changes are needed.

```bash
make test-browser PLAYWRIGHT_ARGS=a14
make test
make test-images
# The two preceding commands are the complete make check prerequisites.
make check
```

A14 extends `playwright.integration.config.ts`; native frontend fixture tests remain in their existing configuration. The hosted PR gate runs the same `make check` with locked dependencies and Chromium.

## Coverage and preserved features

| Requirement or feature | Executable evidence |
|---|---|
| Public/private profiles × public/followers/selected audience | Six matrix journeys, each with author, selected follower, unselected follower, non-follower and pending role. Private profiles retain a real pending request. Public profiles automatically accept pending requests, so the former requester unfollows to exercise the approved non-follower cell. All 18 contract cells plus author are covered. |
| Shared permission on every surface | Direct post/thread/comment/navigation/media, comment attachment bytes, feed and Following/category combination, profile posts/comments and totals, private histories/category summaries, recipient selection redaction, denied mutations/static aliases, anonymous media 401 and browser detail/feed checks. |
| Audience and profile changes | Public→followers→selected→public; public↔private; live browser revocation, unfollow/refollow with new follow identity and empty selections, explicit reselection restores access. |
| Drafts and publication | Incomplete real editor draft, save/reload, publish, edit, stale write rejection, unpublish/delete; separate lifecycle journey preserves nested comments and reactions through unpublish/republish. |
| Optional titles/categories; image-only posts/comments | Matrix posts have null titles; recreation journey creates image-only post/comment; category-filtered feeds and summaries remain available. |
| Nested comments and ownership/versioning | Real comment creation/edit, nested reply, versioned deletion and descendant cascade; exact-comment notification deep link. |
| Likes/dislikes and activity | Same-action removal and opposite-action switch for post/comment reactions, private liked history, comment activity, hidden history filtering and restored counts after publication. |
| Notifications | Real durable comment-reaction notice, exact target navigation, hidden list/read-all state during unpublish, same notice restored after republish. Existing A11 journeys retain socket reconnect, cross-tab read state, empty signals and recipient-only follow decisions. |
| Hidden totals/navigation | Dedicated category/page-size-one journey checks hidden total difference, skips a hidden adjacent post, excludes category projections and restores total/navigation on audience expansion. |
| Persistence and cleanup | Recreate both containers with retained storage: selected grants, draft post, comments, reaction and exact bytes survive; republish preserves restrictions; replacement invalidates old URL, removal retains text, deletion removes descendant access/bytes. A07/A11 retain account/session/avatar/follow/notice persistence. |
| Earlier-phase upgrade and orphan recovery | Current native gate runs `TestContentMigrationPreservesPhase2DataAndBytes`, failure-boundary/dirty/corruption checks in `internal/db/content_migration_test.go`, and media recovery/orphan suites in `internal/db/media_test.go`. Existing image gate runs legacy media import/recovery, participant/static denial and restart. Migration fixtures execute at the database layer; browser accounts are real registrations. |
| Keyboard/mobile/desktop/session cleanup | Real selected publishing and comment submission with keyboard, 360px/desktop screenshots, horizontal overflow assertions, logout/back and protected direct-entry checks. Existing native A12/A13 journeys retain broader UI error/loading/empty and conflict coverage. |

Groups, events and chat adaptation remain outside Phase 3. The inherited DM media regression preserves existing participant access without deciding Phase 5 behavior.

## Verification record — 2026-10-09

The initial exploratory run found an acceptance assertion passing a null optional title to `toContain`; it was corrected to compare the unique post body. This was a test defect; no application behavior changed. The next focused run passed all **11/11** then-present A14 journeys, including both-image recreation, attachment cleanup and desktop/360px keyboard journeys. Local log: `.tmp/a14-focused-2.log`. Two additional focused journeys now cover the real draft editor and filtered totals/navigation; their final results and complete local/hosted records will be recorded after execution. No hosted success or final acceptance is claimed yet.
