# Audience-Aware Feeds and Publishing — SN-A12

Implemented on `chbaikas/A12`, based on merged `main` / `origin/main` revision `40ef6bc` (B14 contract and B15 backend included), using the [owner-approved content contract](content-contract.md) and its [fixture pack](fixtures/phase-3-contract.json). Status and dependencies live in the [tracker](ticket-tracker.md). This is frontend-only verification against approved fixtures; real persistence, authorization and image acceptance belong to SN-A14.

## Application behavior

**Feed** (`/feed`). Newest-first published posts the viewer may read, 20 per page, with Everyone/Following and category filters. Filters live in the route query (`feed=following`, `category=<id>`, `page=<n>`), so links, reloads and Back restore them. A router guard canonicalizes malformed, repeated or unknown values before any view mounts. An unknown category gets its own explanation and a reset link. Following combines with a category using AND and excludes the viewer's own posts, as in the contract. Category chips on cards open that category. Shorter lists show a beyond-the-last-page recovery state.

**Cards** show optional titles, plain-text bodies, checked same-origin images, categories, audience, non-published status and read-only like/dislike counts. Only the author's own cards show Edit/Continue draft and the number of selected recipients. Recipients and other viewers never see who else was chosen. Untitled posts still get an accessible heading. Missing or revoked media leaves the text and says the image is unavailable.

**Composer** (`/posts/new`). Optional title and categories, text and/or a JPEG/PNG/GIF image with preview, removal and replacement. Public is visibly the default audience. Followers and Selected followers are the other options. The recipient picker lists the author's *current accepted followers* by stable account ID, with a name filter. A private profile shows that even Public posts reach only accepted followers. Publish creates a post; Save as draft always creates a new draft (never overwriting another) and opens it in the editor. A banner offers the latest saved draft and links to all drafts.

**Owner editor** (`/posts/:id/edit`). Direct entry shows distinct missing (including another author's drafts), foreign ("only your own posts") and outage states; another author's post never gains owner controls. Edits send only changed fields with the required `expected_version`. Drafts can Save draft, Publish or Delete draft. Published posts can Save changes, Move to drafts or Delete post. Archived posts can Save changes, Publish again, Move to drafts or Delete. Unpublish and republish keep IDs, created time, image, audience and recipients. Deletion needs an inline confirmation. Audiences change in both directions: leaving Selected clears recipients, and switching to Selected sends an explicit selection.

**Your posts** (`/posts/mine`) lists All, Published and Drafts for the owner, with status badges and edit links. The SN-A13 activity area will reuse these cards and editors.

## Writes, failures and stale state

- **Validation before requests** mirrors the contract: CRLF normalization and trimming, Unicode code-point limits (title 200, body 10,000), control characters, text-or-image on publication, at least one recipient when a Selected post becomes published, and image type/5 MiB checks. Drafts may be empty. Server field errors (`CONTENT_REQUIRED`, `INVALID_SELECTION`, `INVALID_CATEGORY`, `TOO_LONG`, …) are mapped to fields. Every input survives except a rejected fresh image, which cannot be retried as-is.
- **Lost followers.** A recipient who no longer follows is not dropped silently. After an `INVALID_SELECTION` the follower list refreshes, the person is flagged with a Remove control, and saving that audience stays blocked until they are removed.
- **Version conflicts** (`409 STALE_CONTENT`, or a 404 that may mean a status change elsewhere). The editor re-reads the post and rebases unsaved edits onto it. Untouched fields follow the server, edited ones stay, and recipients the server removed meanwhile stay removed. A refollowed person is offered again but never re-selected automatically. A visible notice also appears when a newer version arrives while editing, with an explicit "load the latest version" action.
- **Unknown outcomes.** A lost or 5xx write response is never replayed. The UI says the change could not be confirmed, keeps the inputs, and offers a check (Your posts, or reload the saved version). Retrying a committed edit then becomes a reviewed conflict instead of a duplicate write.
- **Duplicate submissions** are blocked per post (or per new composition) in the shared content state. Controls show a busy state.

## Protected state and realtime

Feed and Your posts use the shared A09 resource loader. Socket `social.invalidate`/`notification.new` signals, reconnect, focus and the 60-second fallback discard protected cards *before* refetching. Superseded responses never paint, and outages show an unavailable state without stale cards. A 401 clears state through the shared session handler. The composer's own category list, follower list and profile visibility use the loader's new `retain` option: invalidations refresh them without blanking the form. Session clears and failed reads still discard them. The editor keeps its form during invalidations and tracks the newest server version separately. Account changes reset pending writes, notices and unsent text. Success notices are keyed to their destination route, so a view that remounts briefly during the shell's session re-check cannot consume them.

## Commands and ownership

```bash
bun run test:a12
make test-e2e PLAYWRIGHT_ARGS=a12-publishing
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
```

| Area | Owner files / handoff |
|---|---|
| Content HTTP client and strict normalization (owner-only recipients, checked media URLs, JSON/multipart encoding) | `SPA/src/api/content.js` |
| Shared write guard, refetch-after-write, 401 handling, route-keyed notices | `SPA/src/features/content/content-state.js` (`contentKey`), provided in `SPA/src/main.js` |
| Form model: validation, partial-edit diff, conflict rebase, failure mapping | `SPA/src/features/content/post-form.js`, `content-utils.js` |
| Reusable UI | `PostCard.vue`, `PostComposer.vue`, `use-composer-resources.js` — A13 reuses them for profile activity and drafts |
| Pages and routes | `FeedPage.vue` (`/feed`), `ComposePage.vue` (`/posts/new`), `EditPostPage.vue` (`/posts/:id/edit`), `MyPostsPage.vue` (`/posts/mine`); feed canonicalization in `SPA/src/app/router.js` |
| Shell entry points | Feed link in `App.vue`; feed/compose links in `HomePage.vue` |
| Presentation | `SPA/src/styles/content.css` (existing paper/forest/coral tokens, 44px targets, 360px layouts) |
| Discussion detail, comments, reactions, profile/private activity, notice navigation | SN-A13; add `/posts/:id` beside the A12 routes |

Production imports no fixtures. `SPA/tests/fixtures/phase3/content-backend.js` extends the Phase 2 model with the contract's audience matrix, selection grants bound to exact follow identities (unfollow prunes them and advances the version; refollow restores nothing), versions, drafts, publication rules matching B15, image sniffing, media links and fault injection. The policy test now also rejects Phase 3 fixture references in `SPA/src` and checks that the content client is same-origin only. The fixture model is a test stand-in, not evidence of backend authorization.

## Verification record

On 2026-10-07, the working tree on `chbaikas/A12` based on `40ef6bc` passed:

- `bun x vitest run SPA/tests/unit/src/api/content.test.js`: **152/152**. Every one of the **146** A12-owned approved HTTP cases (feed, detail, mine, latest draft, category metadata, post/draft create, edit and delete, including all 18 matrix feed/detail cells) goes through the client and maps to the contract outcome. Successful responses normalize to exactly the fixture body, and only the author's copy keeps `selected_follower_ids`. **129** cases reproduce the exact request (method, path, JSON or multipart fields). The other 17 are structural/transport probes the client never sends. Extra checks cover normalization and leak refusal.
- Content fixture interaction tests: **60** (feed 11, composer 12, editor 17, Your posts 2, form model 12, shared state 6, harness-backed). They cover text-only and image-only posts, omitted and supplied titles/categories, all three audiences, invalid and lost selections, upload and outage errors, duplicate submissions, draft save/reload/publish, unpublish/republish preserving attachment and recipients, archive, confirmed deletion, conflict rebase with refollow, unknown outcomes, filter/paging/stale-response/invalidation/401 behavior and direct-entry denied/missing states.
- `bun run test:a12`: **347/347** focused checks (content client replay, content interaction tests, A09/A10 social regressions, app shell/router and the production-fixture policy).
- `make test-e2e PLAYWRIGHT_ARGS=a12-publishing`: **7/7** browser journeys. Keyboard publishing to selected followers, with per-viewer visibility; image preview/removal/replacement with real image bytes rendered; draft lifecycle across reloads with keyboard deletion; filter/paging/route recovery and denied/missing editor entry; socket invalidation removing a revoked post; feed and editor at 360px and desktop with no horizontal overflow and 44px controls.
- `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test`: **exit 0**. Build, Biome, gofmt, vet, Go suite and scoped race suite passed; Vitest **1059/1059** (76 files) with coverage statements 89.15%, branches 85.99%, functions 89.35%, lines 89.12%; native Playwright **39/39**, including the 7 A12 journeys. The A03 registration-fixture timing failure recorded under SN-B15 did not recur in this run.
- Visual inspection of `.tmp/a12-feed-360px.png`, `.tmp/a12-feed-desktop.png` and `.tmp/a12-editor-360px.png` confirmed wrapping long titles and tokens, stacked actions on mobile and consistency with the existing Commonplace UI.
- `python3 docs/social-network/fixtures/validate-phase-3.py` passed (246 fixtures, 18 matrix cells, 263 local links/anchors, 36-ticket graph and status counts).

Docker was already running, so the shared image gate also ran. `make test-images` returned **exit 0**: backend image smoke, both-image legacy media recovery and static denial, two-image transport/outage smoke, and **16/16** real-service integration journeys (A07, A11, B07, B13) against the new frontend image. These confirm earlier journeys still pass. They are **not** SN-A12 acceptance: real Phase 3 publishing, persistence and authorization remain SN-A14. Hosted CI was not run for this record.

Problems found and fixed during the work:

- Redirecting malformed feed queries from inside the view looped, because the shell re-checks the session (and remounts the view) on every navigation. Canonicalization moved to a router guard.
- For the same reason, a success notice could be consumed by the remounting source view, so notices are now keyed to their destination route.
- The B15 publication rule turned out narrower than first modelled. Recipients are required only when a post *becomes* published, and content on any visible edit. The client checks and the fixture model now match it.
- Chromium request interception drops uploaded file bytes, so the browser fixture records the uploaded part's name/type and models it as the chosen fixture image. Byte-level image validation stays covered by the unit replay.
