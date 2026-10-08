# Audience-aware discussions and activity — SN-B16

Implementation on `asmyrogl/B16`, based on merged main `c19c279` (B15 and A12 included). The [owner-approved content contract](content-contract.md), [Phase 3 data plan](phase-3-data-plan.md) and [B15 handoff](backend-publishing.md#b16-handoff) control these changes. This record applies to the working tree, not an untested later revision.

## Delivered boundary

B16 owns every remaining content consumer: comment threads and writes, post/comment reactions, profile posts/comments, owner-only created/liked/disliked/comment history, category summaries, navigation and notice targets. B15 still owns posts, feeds, drafts, selections and the parent-based media predicate. No Vue code, group/chat/event policy, new service or deployment is introduced, and **no migration 6**: comment `content_version` already ships in migration 5 and every needed constraint, cascade and index already exists, so [old migrations stay untouched](phase-3-data-plan.md#upgrade-ownership-and-mappings).

All consumers compose the one B15 predicate (`contentPermission`/`CanViewPost`: active viewer and author, profile restriction AND published status AND audience, with owner exceptions) before counting, paging, aggregating or projecting. Writes take SQLite's existing social write lock first ([`BeginSocialWrite`](../../internal/db/follows.go)) and repeat access, ownership, parent and version checks inside it, so a concurrent unfollow, audience edit, unpublish or privacy switch cannot be raced by an earlier handler check.

| Concern | Implementation |
|---|---|
| [Comment and reaction writers](../../internal/db/discussions.go) | `WriteDiscussionComment`, `DeleteDiscussionComment`, `ToggleDiscussionReaction`: access, ownership, version, parent, text-or-image completeness, media claim, notice insert/dedup and counts commit atomically; signals follow commit. |
| [Reads](../../internal/db/content_reads.go) | Threads (oldest first), profile comments/posts, owner activity (one read snapshot for all four sections), navigation and category summaries; permission is part of every count/page query. |
| [Notices](../../internal/db/social_notifications.go) | List, total, unread badge, excerpt, read-one and read-all use the recipient's current post permission (audience included) and an active comment author. Content targets always carry the nullable title. |
| [HTTP adapters](../../internal/handlers/discussions.go) | Strict queries/bodies, exact `Allow` lists, JSON and multipart comments, owner-only history; shared multipart/JSON field reader with [post publishing](../../internal/handlers/publishing.go). |

## Route parity

| Route | Behavior | Evidence |
|---|---|---|
| `GET /posts/{id}/comments` | Parent readable or 404; oldest first `(created_at, id)`; nested parent IDs; inactive commenters excluded; private commenter shown by approved display name only. | Fixtures, matrix, ordering test |
| `POST /posts/{id}/comments` | Optional body/image, nullable `parent_comment_id` that must be a live comment of an active user on the same post (else 404); `CONTENT_REQUIRED`; 201 Comment with `version`. | Fixtures, lifecycle |
| `GET`/`PATCH`/`DELETE /comments/{id}` | Detail under parent access; edit/delete only by the comment author while the parent is readable (post owners cannot edit or delete foreign comments); `expected_version` required, `409 STALE_CONTENT` after authorization, exact no-op returns state with no version bump or signal; parent/post reassignment is a 400. Delete cascades descendants, reactions, notices and media links. | Fixtures, lifecycle, image tests |
| `POST /posts|comments/{id}/like|dislike` | Same permission and write transaction as the reaction row and its notice; toggle/switch/remove; counts from the same transaction. | Fixtures, reaction test, matrix |
| `GET /users/{id}/posts`, `/comments` | Full-profile permission AND published parent access, even for the owner; teaser, unknown or inactive subjects are 404; drafts never listed; posts newest first, comments newest first. | Fixtures, matrix, ordering |
| `GET /users/activity` | Owner only. `created_posts` (status filter), `liked_posts`, `disliked_posts`, `comments`, each `{items,pagination}` from one snapshot; inaccessible parents are omitted from items and totals. | Fixtures, matrix, activity test |
| `GET /posts/liked`, `/posts/disliked` | Caller's history with current permission; a forged owner/user parameter is an unknown key and a 400. | Strict-route test, matrix |
| `GET /categories`, `/categories/{id}`, `/categories/view` | Authenticated metadata only (no private-content statistics); view lists published authorized posts per category; no query parameters. | Fixtures, matrix |
| `GET /posts/{id}/nav` | Optional `category_id` and `feed=all|following`; source must be readable, published and inside both filters, else 404; neighbours by `(created_at, id)`; `category_id:null` when omitted. | Fixtures, ordering test |
| `GET /notifications`, `PATCH …/read`, `…/read-all` | Hidden, draft, deleted or audience-denied targets disappear from list, total, unread and read-one; read-all leaves hidden rows untouched and signals only when a row actually changed. | Fixtures, matrix |
| `GET /media/{id}`, `/static/uploads/…` | Unchanged B13/B15 byte routes; comment attachments resolve through the parent post predicate on every request, and encoded aliases stay 404. | Fixtures, matrix, image tests |

Lists accept only `page` (1–1,000,000) and `per_page` (1–50), each once; any other key, repetition or non-decimal value is `400 BAD_REQUEST`. Malformed IDs are 400; valid unknown or denied resources are the same 404. Unsupported methods get 405 with the exact `Allow` list before Origin/CSRF checks.

## Signals and notices

`social.invalidate` (empty, all authenticated sockets) follows every committed comment create/edit/delete and reaction change. A newly inserted notice also sends the recipient-only `notification.new`. Self-actions, exact no-ops, rollbacks and permission-lost writes send nothing and create no notice. Existing dedup identities are unchanged (repeating like→remove→like keeps one durable notice). Notice reads signal only the recipient and only when a row changed.

## Upgrade and recovery

B16 changes no table, index, trigger or file layout, so backup, restore and dirty-migration recovery are exactly the [migration guide](backend-migrations.md) and [B13 media recovery](backend-content-media.md#upgrade-and-recovery-handoff) already require; B15's migration-5 refusal and rollback evidence stands. Deleting a comment or post still sweeps unreferenced private bytes only after commit and a full owner check, a failed sweep is deferred to the next start, and replacing or removing an attachment never touches another resource's object. The restart test proves comment versions, reactions, notices and attachment bytes survive two reopen cycles without sweeping live media.

## Single implementation

The comment, reaction and activity rules above live only in the B16 writers and readers. B13's social-context branches of `CreateComment`, `UpdateComment`, `DeleteComment`, `ToggleReaction` and `ListUserCommentsWithPost` were unreachable once the social routes moved to the B16 adapters, so they were removed rather than left as a second, unversioned copy; the repository tests that used them (denied writes, signal-on-commit, permission-loss ordering, comment media privacy) now drive the live writers. The forum-schema code paths are unchanged.

## Verification record — 2026-10-08

Gate runs on the working tree based on `c19c279`:

- `go test ./internal/tests -run TestDiscussionContractFixtures` — **62/62** approved HTTP fixtures not owned by B15 (comments, reactions, profile/private activity, categories, navigation, aliases, notices): exact bodies, headers, persisted postconditions, unchanged-state snapshots and exact `social.invalidate`/`notification.new` signals. With B15's 184 cases this accounts for all **246** fixtures.
- `TestDiscussionAudienceMatrixAcrossEverySurface` — **30** profile × audience × relationship subtests (owner, selected follower, unselected follower, pending requester, outsider). Each traverses detail, thread, comment, attachment bytes, navigation, Following navigation, categories, profile posts/comments, another user's comments, private activity, liked history, notice list/total/unread badge/read-one, then attempts comment, like, dislike, comment reactions and foreign/own edits. Denied actors receive 404 everywhere, leak no `SECRET-` marker and leave table snapshots unchanged. A mutation of the notice predicate was confirmed to fail this test.
- `TestDiscussionConcurrentPermissionLossCommitsNothing` — **20** subtests: an unfollow, unpublish, audience-to-selected or private-plus-unfollow commits while a comment create/edit/delete or post/comment reaction is already waiting on the write lock; every request returns 404 and commits no row, notice or signal. `TestDiscussionParallelWritersAgainstUnfollow` races 24 writers with an unfollow: committed rows equal successful responses and everything after the unfollow is rejected.
- Interaction tests cover own/foreign edits and deletes, stale and no-op versions, nested cascades, parent validation (other post, missing, inactive commenter), image-only comments (PNG, GIF, JPEG), removal/replacement/retention, failed-edit rollback without orphan media, strict text/ID/query/method rules, retention across unfollow/unpublish/audience/deactivation with restoration, activity status filter, ordering and tie-breaking, and state/attachments surviving two restarts.
- `go test -race ./internal/tests -run TestDiscussion` and `make test-race` (including `./internal/db` and `./internal/handlers`) pass.
- Native `make test` Go stages passed: build, Biome (208 files), gofmt, vet, `go test ./...`, race gate. Vitest **1062/1062** and native Playwright (`make test-e2e`) **39/39** pass; the existing B13 real-service media regression is among them. Fixture validator, docs-consistency Vitest and whitespace checks passed after these documents were updated.

Not verified: Docker was not started, so the container images and the A11 two-image real-service suite are **unverified** for this tree. `bun run test` previously also collected a stale local git worktree at `.tmp/pr28` and failed there; `vitest.config.ts` now excludes `.tmp/**`, and the plain `make test` Vitest stage passes.

## A14 and A13 handoff

Start the backend with the existing commands and a throwaway `MEDIA_ROOT`/database; no additional configuration exists. The Vue discussion client must now send `expected_version` on comment edit/delete, send `parent_comment_id` as a number or null, expect `version` and nullable `parent_comment_id` on every Comment, treat `title: null` in notices and activity as valid, and reject `status` on liked/disliked/profile lists. A14 should exercise these routes with real sessions across both images; the HTTP fixtures above are the executable contract.
