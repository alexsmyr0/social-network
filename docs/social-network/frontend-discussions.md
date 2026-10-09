# Discussions and private activity — SN-A13

Implemented on `chbaikas/A13`, based on merged main `3e8e8eb` (A12 and B16 included). The [approved content contract](content-contract.md), [fixtures](fixtures/phase-3-contract.json), [publishing primitives](frontend-publishing.md) and [B16 handoff](backend-discussions.md#a14-and-a13-handoff) control the implementation. Status lives in the [tracker](ticket-tracker.md). This ticket verifies the Vue frontend with fixtures; real-service Phase 3 authorization, persistence and cleanup acceptance belong to SN-A14.

## Delivered behavior

**Discussions** (`/posts/:id`) show permitted post details, an oldest-first paginated comment thread and previous/next published posts. Feed cards carry Following/category filters into the discussion; navigation preserves both and never derives neighbours from cached cards. Drafts/archived posts remain owner-readable without published navigation. A missing, deleted or denied post has one unavailable-target state with no excerpts, images, counts or forms. An outage has a separate retry state and discards previous protected content.

**Comments** support text, image-only JPEG/PNG/GIF uploads, previews, replacement/removal, existing parent IDs and new replies. A parent link opens its comment route, including when it lives on another thread page. Direct `/comments/:id` entry first authorizes that comment, then loads the parent discussion; a linked comment outside the current page appears separately and receives focus. Comment names link to profiles without embedding private profile information. Only the comment author gets edit/delete controls; the post author does not gain control of foreign comments. Deletion requires an explicit confirmation explaining the descendant cascade.

Comment editing/deletion sends `expected_version`. A stale edit keeps unsent text, blocks saving and offers an explicit reload of the current text, attachment and version. A stale delete refetches and asks the viewer to review before trying again. Fresh attachments use multipart; nullable top-level parent IDs are omitted from multipart rather than encoded as invalid decimal strings. Removing a fresh preview before creating a comment does not send the edit-only `remove_image` field. Body validation reuses A12's Unicode, normalization and control-character rules; publication requires text or an image. Rejected fresh uploads release their preview and remain recoverable.

**Reactions** expose post/comment like and dislike controls with `aria-pressed`, counts and a shared duplicate-write guard. Same reaction removes, opposite reaction switches. Counts and pressed states come from refetched server responses. A rejected or uncertain response never leaves optimistic success or automatically repeats a toggle/create. The UI tells the viewer to check the refreshed discussion before another action.

**Profile activity** mounts only inside a full A09 profile. Posts/comments are separate paginated sections and contain only the backend's published, parent-authorized results. Another person's profile never gets personal liked/disliked history, drafts or history status filters. Owner profiles link to the private activity area.

**Your activity** (`/activity`) is session-owned, with Created, Liked, Disliked and Comments sections. Each uses its own contracted items/totals from `/users/activity`; Created offers All/Published/Drafts, and cards reuse A12 editors for continuing, publishing or deleting drafts and editing posts. A permanent Manage drafts link opens `/posts/mine?status=draft`. Empty/outage and beyond-last-page states have recovery controls. Private activity comment entries preserve the contracted authorized parent projection and link to the precise discussion comment.

**Content notifications** use the A10 shell and route to a post or exact comment. The title may be null. Direct entry rechecks access, so an old notice cannot grant access after deletion, unpublication, privacy/audience change or unfollow. No fixtures or test accounts are imported by production.

## Protected state and ownership

All discussion/activity reads reuse `useSocialResource`: signals, reconnect/focus and source changes discard protected results before refetch; newer loads supersede older responses; failed reads remove cached details. Account changes reset forms, previews, write guards and activity sections. Session loss removes views through the shared auth shell. Social invalidation also removes profile activity when the profile becomes a teaser. Shared writes refetch every mounted resource, handle 401 through A09's session handler and ignore responses from a superseded account.

| Area | Files / handoff |
|---|---|
| Strict comment, reaction, profile/history and navigation client | `SPA/src/api/content.js` |
| Shared guarded mutations | `SPA/src/features/content/content-state.js` |
| Discussion, linked-comment routing, navigation and paging | `DiscussionPage.vue`, `SPA/src/app/router.js` |
| Comment forms/cards and reaction controls | `CommentForm.vue`, `CommentCard.vue`, `ReactionControl.vue` |
| Profile integration and private history | `ActivityPanel.vue`, `ActivityPage.vue`, `SPA/src/features/social/ProfilePage.vue` |
| Feed links, shell and notification navigation | `PostCard.vue`, `SPA/src/app/App.vue`, `NotificationCenter.vue` |
| Layout | `SPA/src/styles/content.css`, existing Commonplace paper/forest/coral tokens |
| Test fixtures | `SPA/tests/fixtures/phase3/discussion-backend.js`, shared `browser.js`; frontend evidence only |

No Go/schema/shared-runtime changes are needed. The existing Playwright native configuration includes A13; SN-B07 remains the shared image/CI owner, and A14 owns the new real-service Phase 3 journeys.

## Verification record

Commands on the A13 working tree based on `3e8e8eb`, 2026-10-08:

```bash
bun run test:a13
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a13-discussions
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-images
python3 docs/social-network/fixtures/validate-phase-3.py
git diff --check
```

- Client replay: **52/52** A13-owned approved HTTP cases, with exact methods/paths/JSON or multipart fields, credentials/write header, successful normalized schemas and error outcomes. This includes all 18 access-matrix thread cases, nested/image-only comments, stale/foreign/cascade writes, reactions, profile reads, history and navigation. Five additional cases verify redaction, malformed responses, outage separation and nullable multipart-parent omission. Structural parent-reassignment rejection is exercised through the client but is never emitted by the UI.
- Discussion component journeys: **20/20**, including creation, nested replies, image-only edits/replacement/removal, all three accepted image types, rejected selections, validation, duplicate submission, stale edits, unknown committed outcomes, permission-lost writes, deletion/audience/unpublication invalidation, delayed reads, linked comments beyond page 1, filtered navigation and account changes.
- Activity/profile/notice journeys: **38/38**, including the 30-case profile × audience × viewer matrix, permission-filtered totals, private histories, draft editor reuse, unfollow/refollow selection pruning, teaser transitions, shorter lists, outages, logout/account changes and revoked notice targets.
- `bun run test:a13`: **493/493**, including A09/A10/A12 and shell/router/production-fixture regressions.
- Native browser suite includes **8** A13 journeys: keyboard reply/edit/delete, image-only preview/replacement/removal, reaction toggles/switches/unknown responses, profile/private history and drafts, notification revocation, navigation/paging/deep links/account/logout/back, outage/conflict recovery and 360px/1280px layout checks with 44px buttons.
- Visual inspection of the 360px/1280px discussion and activity screenshots (`.tmp/a13-discussion-360.png`, `.tmp/a13-discussion-1280.png`, `.tmp/a13-activity-360.png`, `.tmp/a13-activity-1280.png`) confirms long words wrap, mobile actions stack and the views retain the existing typography and palette; browser checks also capture the complementary desktop/mobile views.

- Native `make test` returned **exit 0**: production builds, Biome, gofmt, vet, Go suite and scoped race suite passed; Vitest **1177/1177** (79 files), coverage statements 89.77%, branches 86.42%, functions 89.65%, lines 89.75%; Playwright **47/47**, including all 8 A13 journeys. The final mobile layout groups activity tabs into two columns and discussion links provide 44px targets; the A13 browser gate returned **8/8** after this presentation adjustment.
- Fixture/link/status validation passes for 246 contract cases, 18 access cells × four surfaces, the six-step follow sequence and the 36-ticket dependency/status graph; `git diff --check` passes.

Docker was already running. The final `make test-images` returned **exit 0**: both image builds, backend smoke, legacy-media/static-path recovery/denial and **16/16** existing real-service A07/A11/B07/B13 journeys passed, including persistence, container recreation, transport/outage and isolated cleanup. SHA-256 checks confirm the image CSS and JavaScript exactly match the final locally tested assets. These are previous-phase regression checks; hosted CI and real Phase 3 acceptance remain unverified by this ticket.

## Findings resolved during verification

- Retired-route checks used `/posts/:id`, which A13 restores. Those regression probes now use the still-retired `/edit-post/:id`; active routes have dedicated A13 coverage.
- Stateful discussion fixtures initially shadowed inherited Phase 2 session/profile dispatcher methods. Distinct helper names preserve the existing fixture flows.
- Browser fixture logout must return the approved account/session envelope, and a persistent-outage setup must survive the initial socket resync. Both are model fixes, not changes to production session policy.
