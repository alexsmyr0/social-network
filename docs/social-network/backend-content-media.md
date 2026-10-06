# B13 — Retained content privacy and private media

Implementation on `asmyrogl/B13`, branched from B12 commit `4d503d6` on 2026-10-03. This record describes the working tree; verification does not apply to an untested later revision. Policy comes from the owner-approved [profiles contract](profiles-contract.md), [data plan](phase-2-data-plan.md) and [Phase 2–3 decisions](phase-2-3-decisions.md).

## Content boundary and exposure inventory

Authenticated social HTTP and DM writes carry the viewer into retained repository entry points. [Shared post permission](../../internal/db/content_access.go) requires active viewer/author and either ownership or published content with public-author/accepted-directional-follow permission. Comment bodies and attachments inherit their parent post's permission; a private commenter's display name remains visible in a public thread. Inactive commenters are excluded. Owner drafts stay available through detail, draft and owned activity surfaces, but never enter general feeds, category summaries or navigation. No Phase 3 audience model or Phase 5 follow-gated messaging is introduced.

| Reachable surface | Enforcement and retained behavior |
|---|---|
| `GET /posts`, `?category_id=`, `/categories/view` | Published authorized rows only; filters precede limit, total and summary projection. Category metadata at `/categories` and `/categories/{id}` remains public to authenticated users. No category administration route is added. |
| `GET /posts/{id}`, `/posts/{id}/comments`, `/comments/{id}` | Checked detail/thread reads, approved display names, media URLs and reaction summaries. Rows/totals/projections share a read transaction. |
| `GET /posts/{id}/nav?category_id=` | Checked source; authorized published neighbors ordered by `(created_at,id)` within category. Drafts/private outsiders never become neighbors. |
| `/posts/mine`, `/posts/liked`, `/posts/disliked`, `/users/activity` | Viewer-owned histories; inaccessible parent posts disappear before paging/counting. Comment activity hydrates parent/comment in one snapshot. Caller IDs cannot select another owner's history. |
| `/posts/draft`, `/posts/draft/{id}` | Owner-only draft read/create/update/delete; private image projection and complete cleanup. |
| Post/comment create, edit, delete and both reactions | Early permission guard before upload/parsing, repeated under SQLite write lock before mutation. Ownership failures return 404. Parent comment must belong to the same post. Post content/status/category/image updates commit together. |
| `/chats`, `/chats/{id}/messages`, `/ws` DM frames | Compatibility `username`/`sender_username` fields contain approved display names. Bodies/history stay participant scoped. Roster presence is omitted for denied profiles. Snapshot/update frames recheck profile permission at delivery; social invalidation is followed by a filtered presence snapshot. Existing online-recipient messaging behavior is retained. |
| `/api/v1/media/{id}`, `/static/uploads/{file}`, `/static/uploads/dm/{file}`, profile avatars | Active session plus current resource permission on every GET; no-store, nosniff and verified image MIME. Denied/missing assets return 404; anonymous returns 401. Files stream without loading grandfathered large objects entirely into memory. |

[Frontend interception](../../cmd/frontend/routes.go) runs before ServeMux canonicalization. Encoded, duplicate-slash and dot-segment aliases reach the checked backend without redirecting to local files. The remaining static filesystem refuses upload paths, upload symlink aliases, escapes and directory listings; ordinary files remain readable. Backend interception repeats this boundary and rejects noncanonical paths. All social API responses receive `Cache-Control: no-store`.

## Manifest, writes and cleanup

[Migration 4](../../internal/db/migrations/sqlite/000004_private_media.up.sql) adds opaque media objects (`pending`/`ready`/`missing`), concrete avatar/post/comment/message links and durable uploader/recipient pending rows. Foreign keys, one-resource link constraints, stable unique source mappings and resource-image triggers preserve associations. Media IDs use AUTOINCREMENT and the safe JavaScript integer ceiling, so deleted URLs cannot later identify new bytes.

New uploads use the existing avatar decoder: JPEG/PNG/GIF, 5 MiB/file, 4096 pixels/side, GIF at most 100 frames and 64 million cumulative canvas pixels. Multipart bodies are capped at 10 MiB. Invalid/corrupt/mismatched images return `422 INVALID_IMAGE`; excess bytes return `413 PAYLOAD_TOO_LARGE`. Historical unversioned forum fixtures retain their separate interface and 20 MiB compatibility body limit.

Bytes are written to private temporary files, synced, renamed and synced before a reference can commit. The database claims only the writer's fresh upload or that resource's current attachment. Readability cannot grant a new association, even to the same uploader's already committed image. A failure rolls back links/notices and discards staged metadata/files. Replacement/deletion sweeps only after commit; a cleanup I/O failure is logged for restart recovery and cannot turn a durable mutation into an apparent rollback. Cascaded descendants and all remaining avatar/post/comment/DM/pending owners participate in cleanup. Legacy source bytes are never deleted.

Pending DM uploads record uploader, intended recipient and time. Until attachment only the uploader can read them; attachment requires that uploader and exact recipient. Stored DM media is readable only by a participant (or another independently authorized historical association). **No DM expiry or destructive pending-DM cleanup is enabled.** Pending DM bytes survive restart and unrelated sweeps. Abandoned content staging is cleaned before readiness, when no runtime upload can be in flight.

## Upgrade and recovery handoff

Stop old writers. Back up consistent SQLite, the complete private `MEDIA_ROOT`, and every actual legacy frontend/backend upload mount. `MEDIA_ROOT` still defaults to a sibling `media/` directory beside SQLite; images use `/data/media`. `LEGACY_UPLOAD_ROOTS` is an OS-separated path list of read-only source directories, default `web/static/uploads`. On Linux containers, for example, mount both former upload roots read-only and set `LEGACY_UPLOAD_ROOTS=/legacy/frontend:/legacy/backend`. These source mounts must be supplied by the operator; built images do not imply runtime files exist or agree.

Before readiness, reconciliation inventories all owners, commits stable manifest/link records, then recovers each object. It checks all configured legacy copies; conflicting bytes become a reported missing record, preserving every source until the operator selects verified bytes. Copies use sync/rename and can resume after a crash before readiness-state persistence. Existing avatars retain keys and URLs. Sources are preserved; new checked URLs can refer to missing manifest entries without exposing a raw static fallback.

Missing/unmappable/unsupported assets remain stored references with `state=missing`, text content remains available, and image reads return 404. Operational reports name media/resource IDs and recovery action. Unknown historical DM uploads have no proven uploader: they remain quarantined **in place**, reported, inaccessible and undeleted. Reports may repeat on startup until reconciled. Nonregular files, escaping symlinks, I/O or database faults prevent readiness rather than sweeping uncertain ownership.

Restore known bytes at a configured legacy relative path or their private object key, resolve conflicting source copies explicitly, and restart. If an existing private object is corrupt, retain a backup and remove that corrupt private copy so the retained source can be recopied. Reconciliation moves recovered entries to ready. Never force a dirty migration or use SQL down alone: migration 4 deliberately refuses a lossy downgrade. Restore a coordinated database/media/source backup with its matching runtime.

## Verification record

On 2026-10-03, working tree based on `4d503d6`:

- `make test` exited 0: native backend/frontend builds, Biome, gofmt, vet, complete Go tests, configured race packages, Vitest 540/540 and native Playwright 16/16. The added `b13-media.test.js` runs against real services through the frontend proxy and is included in both native and isolated two-image configurations.
- `go test -race ./internal/db ./internal/handlers ./internal/ws ./internal/tests ./cmd/frontend -run 'TestContent|TestMedia|TestSocialContent|TestSocialMedia|TestSocialPresence|TestPrivateStatic|TestRelationshipNotification|TestSocialNotice|TestSocialNotification|TestSocialProfilesAndNotifications' -count=1` passed. The selected handler/hub packages have no tests matching this expression; their full race suites passed in `make test`.
- Additional interrupted-write/replacement tests passed under `-race`. Repository cases cover owner/follower/pending/outsider reads and mutations, counts before pagination, private commenters in public threads, parent validation, permission loss, every media owner, cross-owner claims, rollback silence, upgrade/repeated startup, restored missing sources, conflicting mounts, interrupted copies/writes, replacement, cascading cleanup and pending-DM restart.
- HTTP/socket cases cover retained route denial, owner drafts, mutation ownership, corrupt/oversize upload errors, failed-write staging cleanup, media ownership/DM participant reads, identity names, omitted private presence and refreshed real socket snapshots. Frontend tests cover raw/encoded/traversal proxy paths and symlink/static fallback denial.

A second `make test` passed after streaming and staged-DM cleanup corrections (540 frontend tests, 16 browser tests). Final reaction-count snapshot and waiting-writer additions passed targeted API/race/build checks, recorded in the [combined audit](b12-b13-audit.md). Docker was stopped at initial verification and was not started without owner instruction. Both-image verification subsequently passed on 2026-10-04 as recorded below; A's review of the concrete shared frontend-route diff remains unrecorded. Full rendered Phase 2 journeys remain SN-A11; this ticket requires no future B15 implementation.


### Merged image verification — 2026-10-04

B13 implementation is committed as `08f345e`; `ba3b78f` merges main `d56d1a0`, retaining A09 UI/test changes and B13 privacy/media behavior. `make test` passed on the merged implementation (787 frontend tests, 25 native browser tests). `make test-images` rebuilt both images and passed backend persistence smoke, [legacy post/comment/DM recovery and static-denial smoke](../../scripts/smoke-media-images.sh), 10 container browser tests and backend-outage handling. The legacy smoke mounts actual uploads in frontend as well as backend, so a raw FileServer fallback would fail the privacy checks. Historical references and copied bytes survive backend restart; DM participant access remains intact after private-profile denial. The [combined audit](b12-b13-audit.md#main-merge-and-both-image-verification--2026-10-04) records exact revisions, image IDs and the corrected ephemeral-port harness failure. Shared frontend-route A review remains unrecorded; no second fixture sign-off is required.


### Track A frontend-route review — 2026-10-05

As part of the authorized A11 work, the Track A coding agent reviewed merged B13 frontend source and its concrete tests on `chbaikas/A11`, based on `078016c` (merged A10). `cmd/frontend/routes.go` intercepts sensitive escaped paths before ServeMux canonicalization, forwards cookies through the same-origin backend proxy, and uses `privateStaticFS` to refuse upload paths, symlink aliases, filesystem escapes and directory listings while permitting ordinary assets. API/WebSocket routing, CSP and SPA fallback remain compatible with the shipped Vue application.

`GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" go test ./cmd/frontend -run 'TestMediaAliases|TestPrivateStatic' -count=1` passed with local listeners permitted. The review found no additional frontend-route defect. This closes the previously unrecorded **A-side technical review**; it is not a claim of a new human review or A11 Phase 2 acceptance. B13's existing native/image evidence remains tied to the dated revisions above; A11 runs its own current combined gates.


The subsequent A11 image-level acceptance found duplicate `X-Content-Type-Options` values at the frontend proxy (`nosniff, nosniff`). A11 fixes that transport defect in `cmd/frontend/routes.go` and adds `TestMediaProxyKeepsSingleNosniffHeader`, preserving the authorization/static boundary reviewed above. The [Phase 2 acceptance record](phase-2-acceptance.md#review-correction) owns its current verification.
