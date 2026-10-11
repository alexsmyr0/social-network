# Group publishing and discussions — SN-A16

Implemented on `chbaikas/A16`, based on merged main `8074231` (B19 included). The [owner-approved groups contract](groups-contract.md#group-content-extension), the [fixture pack](fixtures/phase-4-contract.json) and the [Phase 4 content decisions](phase-4-decisions.md#group-content-and-existing-features) control the implementation. Status lives in the [tracker](ticket-tracker.md). This ticket verifies the Vue frontend with fixtures. Real persistence, authorization and media delivery belong to SN-A17; membership controls are [SN-A15](frontend-groups.md) and server enforcement is [SN-B19](backend-group-content.md).

## Delivered behavior

**Group posts** (`/groups/:id/posts`) are a fourth group section, offered and requested only after the server-reported role is creator or member. It reuses the post card, Everyone/Following switch, category chips, pager and states of the home feed, always sends `group_id`, and keeps `feed`, `category` and `page` in the URL (malformed values recover to the nearest valid view, and the group in the path is kept). Cards show `Group · {title}` instead of a personal audience badge and link to the group's posts. A category chip on a group card filters that group, never the home feed. Nonmembers, invitees, requesters and departed members see "Only members can read group posts." and no feed, media or category request is made.

**Home feed.** The server already adds current member groups' published posts; the feed page needs no scope parameter. Group cards carry their group, personal cards their audience. The Following and category filters combine exactly as before.

**Composer** (`/groups/:id/posts/new`) reuses `ComposePage` and `PostComposer`. For group content the personal audience picker is replaced by "Members of {title}"; no followers or profile are read for it. A create sends `group_id` and never `audience`/`selected_follower_ids` (the server rejects both together as `GROUP_SCOPE`). Optional title and categories, text or image (JPEG/PNG/GIF, 5 MiB), Save as draft and Publish all work as in Phase 3. Drafts are found per scope: the group composer asks `GET /posts/draft?group_id=`, the personal one asks without it, so group drafts never appear as personal drafts or the reverse. After publishing, the member lands on the group's posts with a notice.

**Editor** (`/posts/:id/edit`) shows the group badge and "Changes appear to the members of {title}…", no audience picker, and sends only changed text, category and attachment fields with `expected_version`. `group_id` is create-only; `updatePost` and `updateDraft` drop it so an edit can never carry it. Ownership of a group post is authorship alone (a group post has no recipient list), and the group creator gets no edit controls over other members' posts, in cards or by direct link. Publish, Move to drafts, delete (with confirmation) and image replace/remove use the same flows as personal posts.

**Discussions** reuse comments, replies, reactions, attachments and previous/next. A discussion opened from a group's posts carries `?group=<id>`; the page sends `group_id` to `/posts/{id}/nav` only when the post really belongs to that group, so a guessed or stale hint is ignored. "Back to {title}" replaces "Back to feed". Comments by a departed author stay visible to remaining members.

**Activity.** Your posts, private activity, profile activity and comment cards show the group. Profile comments on a group post now keep the activity-style parent projection the server adds for them.

**Notices** are unchanged: a post/comment notice opens the existing discussion route. The server hides notices for content the recipient can no longer read, so the list, count and unread badge refresh through the existing signal lifecycle and return after fresh admission.

## Membership loss and protected state

Every group read uses `useSocialResource` through `useGroup`. A removal signal, reconnect, focus, route or account change discards the open posts, discussion or editor before refetching, and a delayed pre-removal response can never repaint. The group's posts section mounts only while the group read confirms membership. The discussion becomes "This discussion isn't available." and its comment form and reactions disappear. The editor shows "You can no longer open this group post." with the author's unsaved text still readable and nothing savable. A write refused with 404 after a silent removal never shows success; the follow-up read closes the view.

The group composer is the one place that holds a member's unsent work, so `GroupComposePage` keeps the last confirmed membership while a re-read is in flight or briefly fails (with a notice), and closes only on a response that says the viewer is not a member. A composer that never confirmed membership stays closed during an outage. Switching accounts starts the composer over and never shows the previous author's text. A lost response is never replayed.

## Files

| Area | Files |
|---|---|
| Strict content client (group scope, contradictions rejected, edit helpers drop `group_id`) | `SPA/src/api/content.js` |
| Group posts, composer gate, section routing | `SPA/src/features/groups/GroupPosts.vue`, `GroupComposePage.vue`, `GroupPage.vue`, `use-group.js` (`useGroup({ retain })`, `groupSections`) |
| Reused content views made group-aware | `PostCard.vue`, `PostComposer.vue`, `ComposePage.vue`, `EditPostPage.vue`, `DiscussionPage.vue`, `CommentCard.vue`, `post-form.js`, `content-utils.js`, `use-composer-resources.js` |
| Routes | `SPA/src/app/router.js` (`group-posts`, `group-compose`; filter canonicalization keeps the route params) |
| Layout | `SPA/src/styles/content.css`, `groups.css` (group titles are user text and wrap anywhere) |
| Test model and helpers | `SPA/tests/fixtures/phase4/group-content-backend.js`, `browser.js`, `SPA/tests/unit/src/features/groups/content-harness.js`; frontend evidence only, never imported by `SPA/src` |

No Go, schema or shared-runtime changes are needed. The native Playwright configuration includes A16. SN-B07 remains the shared image/CI owner.

## Verification record

Commands on the A16 working tree based on `8074231`, 2026-10-11:

```bash
bun run test:a16
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a16-group-content
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-images
python3 docs/social-network/fixtures/validate-phase-4.py
git diff --check
```

- **Client replay: 146 content-owned cases** replay through the real client functions with exact method, path, query set, JSON body and normalized result. The other 38 of the 184 B19-owned cases are image byte reads and the liked/category-view lists, which no screen calls. Five of the 146 are server-only rejections the client cannot emit (non-decimal group ID, zero, string ID, edits carrying `group_id`) and check outcome mapping only. Further checks cover a contradicting audience/scope, recipients never kept for group content, personal shapes unchanged, `group_id` only on create and never on edit, and `GROUP_SCOPE`/404 mapping.
- **Test model conformance: all 184 content-owned pack cases**, the five journeys and the three content races in both orders replay with exact statuses, bodies, image bytes, resulting state, unchanged-state snapshots and signal recipients. A deliberately broken membership predicate fails 78 of them, so the model is not vacuous.
- **Interaction checks: 84.** Role-gated group posts, filters, empty/beyond-last-page/outage states, in-flight and missed-signal removal, account switching, the member home feed per role, the composer (membership instead of audience, no follower reads, JPEG/PNG/GIF, validation, lost response, drafts per scope, unsent work kept through signals and outages), drafts, edits, image replace/remove, unpublish/republish and delete, creator and departed-author denial, discussions (scoped navigation, comments, replies, edits, reactions, attachments), activity, profiles, notices and fresh admission without reviving an obsolete invitation.
- `bun run test:a16`: **1203/1203** (30 files), including every Phase 3 content, discussion, notification and shell regression.
- **Browser: 8/8 A16 journeys.** Keyboard authoring and editing; drafts and attachment replace/remove; comments, replies, reactions, image comments and scoped previous/next; removal with signal, notice disappearance and fresh admission; notice navigation and the departed author; outsider routes and account switching with no group request or media request; outage and reconnect; 360px/1280px layouts with no horizontal scroll and 44px controls on five routes. Screenshots `.tmp/a16-{posts,compose,discussion,edit,feed}-{360,1280}.png` were inspected with a 90-character unbroken group title.
- Native `make test` returned **exit 0**: builds, Biome, gofmt, vet, Go suite, scoped race suite, Vitest **2100/2100** (90 files, statements 91.21%) and Playwright **62/62**, including the 8 A16 journeys.
- `validate-phase-4.py` passes with the 36-ticket graph at **35 complete, 0 in progress, 1 unstarted**; `git diff --check` passes.

Docker was already running. `make test-images` returned **exit 0**: both image builds, backend smoke, legacy-media recovery/participant access/static denial, two-image transport/outage smoke and **29/29** existing real-service journeys passed. These are earlier-phase regression checks. Hosted CI and real Phase 4 group acceptance remain unverified by this ticket and belong to SN-A17.

## Findings resolved during verification

- `normalizePost` rejected `audience:"group"`, so any feed containing a group post would have shown "unavailable". The client now accepts it only together with a group scope.
- The owner editor proved ownership by the presence of `selected_follower_ids`, which group posts never carry; ownership of a group post is now authorship.
- Canonicalizing filters redirected without route params, which broke `/groups/:id/posts`; the redirect now keeps them.
- A hard group re-read on every signal would have unmounted the group composer and wiped unsent text; the composer now keeps its last confirmed membership.
- Profile comments dropped the parent projection that carries the group; they now keep it for group posts.
- Layout: group titles in the new headings, notes and badges could widen the page at 360px; they now wrap.
