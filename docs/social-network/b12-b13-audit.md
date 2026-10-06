# B12/B13 implementation audit

Reviewed 2026-10-03. B12 baseline is commit `4d503d6`; B13 working tree branches directly from it. Scores measure requirement coverage, correctness, failure handling and executed evidence. They are review judgments, not proof that undiscovered defects cannot exist.

| Ticket/revision | Grade | Findings and remaining gate |
|---|---|---|
| B12 as originally committed (`4d503d6`) | **8/10** | Follow/request notices, reconciliation, dedup/backfill/read authorization and real session-scoped socket delivery are covered. Two inherited-content transaction gaps remained: comment creation committed independently of notification insertion; reaction insertion ignored notification errors. |
| B12 behavior with corrections on B13 | **9/10** | Both gaps are corrected, with rollback/no-signal tests and preserved dedup/committed delivery. Existing migration/HTTP/socket/race suites rerun. Full Phase 2 UI acceptance stays with A11. B12 branch itself remains unchanged; corrections are part of the B13 diff. |
| B13 after main merge and image verification | **9/10, provisional** | Content/query/mutation/media/identity boundary implemented; native/race and both-image gates pass. A's shared frontend-route review remains unrecorded before the tracker can mark B13 verified complete. |

## Findings corrected during implementation

- [CreateComment](../../internal/db/comments.go) now checks parent/resource access, inserts comment and deduplicated notice inside one serialized transaction, and invokes the delivery hook only after commit. Injected notice failure leaves neither comment nor notification and emits nothing.
- [ToggleReaction](../../internal/db/reactions.go) now propagates notice insertion errors and checks current parent/post permission under the write lock. Injected failure rolls back the reaction and remains silent; committed comment/reaction delivery stays compatible.
- [Outer media guards](../../internal/router/router.go) and [frontend proxy](../../cmd/frontend/routes.go) intercept before ServeMux can redirect aliases. A new test initially found `/api/v1/media/../users/me` escaping to a redirect; both guards now catch that original path and the authorized handler rejects it.
- [Frontend static filesystem](../../cmd/frontend/routes.go) resolves its root before checking aliases, preserving ordinary files on macOS's symlinked temporary roots while denying upload/symlink/directory bypasses.
- Retained comment update now returns immediately when reloading the updated result fails, preventing a second success body after an error response.
- Failed JSON image edits no longer discard an uploader's pending DM image: request cleanup runs only for that request's actual content upload, and the discard query excludes DM staging. HTTP and repository regressions prove those bytes survive.
- [Private media reads](../../internal/handlers/media.go) stream checked files; existing over-budget recoverable assets do not require unbounded memory allocation just to serve bytes.

## Acceptance coverage

| Requirement | Evidence |
|---|---|
| B12 retained notice data, allocation, pending backfill, constraints and recovery | `internal/db/social_notifications_test.go`; versioned startup/migration cases |
| B12 atomic relationship changes and notices, rollback/commit silence, retries/privacy races | Relationship notification tests and focused race run |
| B12 recipient/current-profile/content authorization, visible totals/read flags | Approved 87 HTTP fixtures plus social notice tests |
| B12 live sessions, independent delivery, logout/inactive revocation, reconnect/restart | `internal/tests/social_notification_sockets_test.go` |
| B12 inherited content atomic failure and compatible delivery | `internal/db/content_privacy_test.go`; existing socket regressions |
| B13 feeds/category/detail/thread/activity/draft/nav privacy and filtered totals | `internal/db/content_privacy_test.go`; `internal/tests/content_privacy_test.go` |
| B13 current permission and ownership at mutations; matching comment parent | Repository/API route matrices, foreign/hidden edits/reactions and parent mismatch |
| B13 image validation, uploader/resource ownership and rollback cleanup | API upload failure/size/type cases; repository media ownership/replacement cases |
| B13 avatars/posts/comments/DM/pending associations, upgrade/restart/recovery | `internal/db/media_test.go` with real files and version-3 upgrade fixtures |
| B13 all-owner cleanup, interrupted writes, conflicts, missing/degraded state | Media copy/replacement/interruption/source-restoration/orphan cases |
| B13 direct/static/encoded/traversal/symlink denial; stale URLs | API matrix, `cmd/frontend/media_proxy_test.go`, real native proxy journey |
| B13 chat display names, participant bytes and authorized refreshed presence | API history/roster and real `content_presence_test.go` sockets |
| B13 authorized media through both built images | `make test-images` passed on 2026-10-04: backend smoke, legacy-media two-image smoke and 10 integration browser tests |
| A review of B-owned shared frontend routes | Concrete diff ready; no additional fixture sign-off requested or claimed |

Final native `make test` passed again after streaming and staging-cleanup corrections: Vitest 540/540 and Playwright 16/16. The final reaction-count snapshot and waiting-writer checks also passed focused race/API/build validation; see the [implementation handoff](backend-content-media.md#verification-record) for commands and scope. Docker/hosted CI failures or missing evidence are never treated as passing. Tracker status is maintained only in [ticket-tracker.md](ticket-tracker.md).


Final checks on 2026-10-03 after the last code changes:

- `go test -race ./internal/db ./internal/tests -run 'TestContent|TestMedia|TestSocialContent|TestSocialMedia|TestSocialPresence|TestSocialNotification' -count=1` — passed, including privacy changes holding the writer lock and pending DM preservation after rejected edits.
- `go vet ./...` and `make build fmt-check lint` — passed.
- `bun x vitest run SPA/tests/unit/docs-consistency.test.js` — 10/10 passed; 98 changed-document local links/anchors, 36 unique ticket/status rows and fixture JSON were also checked. `git diff --check` passed.
- Final `docker info --format '{{.ServerVersion}}'` still reported an unavailable daemon. No Docker startup/image execution or hosted CI is claimed. No PR was created; changes remain uncommitted on `asmyrogl/B13`.


## Main merge and both-image verification — 2026-10-04

The owner authorized Docker Desktop startup and main conflict resolution. Implementation commit `08f345e` preserves B13, including B12 corrections; merge commit `ba3b78f` incorporates `origin/main` revision `d56d1a0`. No main changes were discarded. Tracker conflict combines A09/B12 completion with B13 in progress (21 complete, 1 in progress, 14 unstarted). Native browser configuration retains A09 and B13 tests together. `git merge-base --is-ancestor origin/main HEAD` passed after a final fetch.

- `make test` passed on the merged implementation: builds, Biome, gofmt, vet, complete Go/configured race checks, Vitest **787/787**, native Playwright **25/25**.
- `make test-images` passed after rebuilding both merged images: backend registration/avatar/session restart smoke, the new [legacy-media smoke](../../scripts/smoke-media-images.sh), container Playwright **10/10**, backend outage handling and isolated stack cleanup.
- Legacy smoke mounts real recoverable files in both backend sources and frontend static storage, seeds historical post/comment/DM references with writers stopped, then checks copied bytes through both endpoints. Public post access, private stale-URL denial, participant DM access, anonymous/encoded/traversal denial and a further restart all pass. Retained source bytes remain identical. Only disposable test containers/networks/volumes are removed.
- Initial legacy smoke failed because Docker reallocated an ephemeral host port after backend restart. The harness now refreshes port mappings for every readiness check; the full image gate passed afterward. This was a harness failure, not an application readiness failure.
- Final tested image IDs: backend `sha256:01adcb797fd64c26db5f4d3cfab70199dab3f9f784c3c3d8602fa24082f82628`; frontend `sha256:71534151b146809d3cb08b9c2612b6bcd862f4ae0e0479af287b86d3e2c4f1c4`.

A's review of shared frontend routes remains unrecorded; no new fixture approval or duplicate owner confirmation is requested. Hosted CI has not been run. Docker remains running as authorized. No PR or remote push is part of this work.

## Track A technical review — 2026-10-05

The [A-side frontend-route review](backend-content-media.md#track-a-frontend-route-review--2026-10-05) is now recorded on merged source `078016c`, with real native proxy/alias/static tests passing. The earlier unrecorded-review caveat is historical; B13 is complete in the tracker. A11 subsequently found and fixed duplicate frontend-proxy nosniff values without changing authorization or API contracts. The [Phase 2 acceptance record](phase-2-acceptance.md) owns current image/native/hosted evidence and the owner-revised phase acceptance gate; no new human fixture sign-off is inferred.
