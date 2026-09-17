# Track B - Forum Content and Retained Forum UX

## Mission

Track B owns the non-chat forum migration into the SPA:

- feed
- post detail
- create/edit post flows
- activity view
- notifications
- reactions
- drafts

This track should treat Track A as its main upstream dependency and otherwise move as independently as possible from the realtime chat work.

## Source Mapping
- B01 -> RTF-10, B02 -> RTF-11, B03 -> RTF-12, B04 -> RTF-13, B05 -> RTF-14, B06 -> RTF-29, B07 -> RTF-31, B08 -> RTF-30

## Suggested Execution Order
1. B01 | 2. B02, B03 | 3. B04, B05 | 4. B06, B07, B08

## Tickets

### B01 - Feed Route in the SPA
Source: RTF-10 | Phase: P1
Depends on: A03, A04, A05
Blocks: B02, B03, B06, B07

Work:
- move the feed into the SPA outlet
- preserve category filtering and pagination
- keep post card behavior compatible with SPA navigation

Verification Gate:
- the feed works inside the SPA shell
- feed filtering and pagination still function
- opening a post uses SPA navigation instead of full document navigation

### B02 - Remove Feed Comment Rendering
Source: RTF-11 | Phase: P1
Depends on: B01
Blocks: D05

Work:
- stop fetching comment previews for feed cards
- preserve clean post-card rendering in the feed
- keep feed cards and feed data flow fully decoupled from comment loading

Implementation Notes:
- removed feed-side preview comment fetching and preview-specific post-card props
- feed post cards now render post-only content and route to canonical SPA post detail paths
- comment loading responsibility is isolated to post detail work in B03

Verification Gate:
- feed cards no longer render comments
- feed loading no longer requests per-post comment lists

### B03 - Post Detail Route and Comment Flow
Source: RTF-12 | Phase: P1 | Status: Done
Depends on: B01
Blocks: D05, B06, B07

Work:
- move post detail into a SPA route
- load comments only on post detail
- preserve comment creation and comment image upload behavior

Implementation Notes:
- introduced the SPA route `/posts/:id` and booted it through the shared authenticated shell
- implemented a dedicated post-detail view that renders full post content, metadata, categories, comment list, and comment form
- added post-detail-only comment fetching so the feed remains fully decoupled from comments
- implemented the comment submission flow with comment list refresh after successful post
- preserved comment image upload behavior by reusing the existing image picker and multipart upload request path
- ensured opening a post uses SPA navigation and route initialization without a full document reload

Verification Gate:
- opening a post renders the post-detail route inside the SPA
- comments are loaded only on post detail
- comment submission still works
- comment image uploads still work

### B04 - Create and Edit Post SPA Flows
Source: RTF-13 | Phase: P1
Depends on: A04, A05
Blocks: D05, B08

Work:
- move create-post into the SPA shell
- move edit-post into the SPA shell
- preserve existing image upload and category behavior

Verification Gate:
- create and edit post screens render inside the SPA shell
- post create and update behaviors still work
- logout remains available while using these views

### B05 - Activity View in the SPA
Source: RTF-14 | Phase: P1 | Status: Done
Depends on: A03, A04, A05
Blocks: D05, D07

Work:
- move the activity screen into the SPA
- preserve activity data loading
- replace hard page navigation with SPA route transitions

Implementation Notes:
- added the SPA feature slice `SPA/features/activity/` with the standard
  three-file separation:
  - `activity.api.js` — REST client for `GET /api/v1/users/activity`,
    plus mutation helpers for post status, post delete, comment edit,
    and comment delete; also owns SPA-safe query-state helpers backed by
    `history.replaceState`
  - `activity.views.js` — markup for the activity screen, the four
    collapsible sections (created posts, comments, liked posts, disliked
    posts), the activity post card, the activity comment entry, and the
    inline comment editor
  - `activity.page.js` — page controller that binds section toggles,
    filters (status, items-per-section), pagination, owner/comment
    action dispatch via `data-action`, and the inline comment edit
    lifecycle (reusing `SPA/core/shared/image-picker.js`)
- wired the route through `SPA/core/router/routes.js`,
  `SPA/core/router/render-template.js`, and `SPA/core/app/create-app.js`
  so `/activity` renders inside the shared authenticated shell and is
  initialized through the SPA route lifecycle
- preserved the existing `/api/v1/users/activity` contract — no backend
  changes
- replaced legacy hard-reload patterns with SPA route transitions:
  filter and pagination changes use `history.replaceState`; mutations
  call an in-place `refresh()` instead of reloading the document; edit
  links use the standard SPA `data-link` anchor pattern
- deleted the legacy implementation:
  - `web/templates/activity.html`
  - `web/static/js/activity/activity-page.js`
  - `web/static/js/activity/api-activity.js`
  - `web/static/js/activity/bootstrap-activity.js`
  - `web/static/js/activity/comments-activity.js`
  - `web/static/js/activity/posts-activity.js`
  - `web/static/js/activity/render-activity.js`
  - `web/static/js/activity/sections-activity.js`
  - `web/static/js/activity/state-activity.js`
- follow-up: `web/static/css/activity.css` is now orphan legacy styling
  (not loaded by the SPA bundle) and can be ported or removed in a later
  cleanup pass — out of scope for B05

Verification Gate:
- activity is accessible inside the shared shell
- activity data loads correctly
- activity navigation no longer depends on a standalone template
- deep-link refresh on `/activity` is served by the SPA shell catch-all
- browser back/forward replays through the SPA router without a full
  document reload
- activity mutations refresh state without a full reload

### B06 - Notification Behavior in the SPA
Source: RTF-29 | Phase: P2
Depends on: A04, B01, B03
Blocks: D05, D07

Work:
- preserve notification polling in the SPA
- preserve unread badge and unread-count behavior
- preserve mark-one-read and mark-all-as-read behavior
- preserve notification click and deep-link navigation

Implementation Notes:
- added the SPA feature slice `SPA/features/notification/` with the
  standard three-file separation:
  - `notification.api.js` — REST client for
    `GET /api/v1/notifications`, `PATCH /api/v1/notifications/{id}/read`,
    and `PATCH /api/v1/notifications/read-all`; returns uniform
    `{ ok, status, ... }` results
  - `notification.views.js` — bell/badge/dropdown markup, item markup
    (carrying `data-notification-{type,post-id,comment-id}` for
    stateless destination resolution), and the message formatter
  - `notification.page.js` — `createNotificationCenter` lifecycle
    controller: 5s polling with duplicate-interval prevention, badge +
    dropdown rendering, mark-one/mark-all, and click → mark-read →
    SPA-router navigation
- mounted the bell in the persistent authenticated shell
  (`SPA/features/shell/shell.views.js`) so it survives client-side route
  changes; only `.app-shell__outlet` is swapped on navigation
- wired the polling lifecycle through `SPA/core/app/create-app.js`:
  start after authenticated boot and after login `onSuccess`; stop on
  logout, app teardown, and any `401`
- preserved the existing notification API contracts — no backend changes
- replaced legacy hard-reload navigation (`window.location.href` in
  `web/static/js/notifications.js`) with SPA router navigation; clicking
  a notification marks it read then routes to
  `/posts/{id}?highlight={comment_id|last}` without a full reload
- added SPA comment deep-link highlighting
  (`SPA/features/post/comment-highlight.js` + `comment-highlight.css`),
  resolving the legacy `#comment-{id}` selector to the SPA
  `[data-comment-id]` markup and supporting `highlight=last`; called from
  `initPostDetailPage` after comments render, with a retry loop for
  async comment loading
- toast and sound are intentionally out of scope for B06 (the legacy
  `web/static/js/notifications.js` toast/sound path was not migrated)

Verification Gate:
- notification polling works from the SPA shell
- unread badge/count behavior is preserved
- mark-read and mark-all-read still work
- notification click behavior still navigates correctly

### B07 - Reaction Behavior in the SPA
Source: RTF-31 | Phase: P2 | Status: Done
Depends on: B01, B03
Blocks: D05, D07

Work:
- preserve post reaction bindings after SPA migration
- preserve comment reaction bindings after SPA migration
- remove reaction boot assumptions tied to standalone templates

Implementation Notes:
- the SPA reaction engine lives in `SPA/features/post/`:
  - `post.reactions.bindings.js` — one delegated `change` listener
    attached to `document`, guarded by a module-level flag so it binds
    exactly once no matter how many pages call `initReactionBindings`
  - `post.reactions.logic.js` — pure helpers, including
    `normalizeReactionState`, which reconciles the list/detail payload
    (`likes`/`dislikes`/`my_reaction` int) and the reaction POST payload
    (`likes_count`/`dislikes_count`/`reaction`) into a canonical
    `{ likeCount, dislikeCount, userReaction }`
  - `post.reactions.api.js` — the reaction POST client
- shared reaction pill markup via `renderPostReactions` /
  `renderCommentReactions` (`post-card.views.js`), reused by the feed,
  post-detail, and activity views (no duplicated reaction templates)
- post-detail now renders post reactions (`post-detail.views.js`) and
  comment reactions (`post.page.js` comment markup), and wires
  `initReactionBindings` through `initPostDetailPage`
- resolved the audited scope mismatch: the reaction `<input>` carries no
  id of its own, so the listener resolves the target from the container.
  It reads the `.reactions` wrapper's `data-reaction-scope` hook
  (`post` / `comment`), then `closest('[data-post-id]')` or
  `closest('[data-comment-id]')` for the id — matching on the attribute
  rather than a fixed `article` tag, so the feed/activity `<article>` and
  the post-detail `<section data-post-id>` both resolve. Inputs no longer
  reuse the container id, so `[data-post-id="N"]` selects exactly one
  element on the detail page
- the delegated listener survives SPA navigation and `reloadComments()`
  re-renders without re-binding or duplicate listeners; no
  `DOMContentLoaded` and no standalone-template boot logic
- counts update in place with no full page reload; optimistic state is
  reverted on request failure or when unauthenticated
- preserved the existing reaction API contracts — no backend changes
- added `SPA/tests/unit/features/post/post.reactions.bindings.test.js`
  covering post and comment like/dislike, toggle, switch, count updates,
  both scope shapes, and re-render survival

Verification Gate:
- post reactions work in SPA-rendered views
- comment reactions work in SPA-rendered views
- reaction wiring no longer assumes old page boot logic

### B08 - Draft Workflows in the SPA
Source: RTF-30 | Phase: P2
Depends on: B04
Blocks: D05, D07

Work:
- preserve save-draft behavior in SPA create-post
- preserve draft edit and publish flows
- keep draft navigation inside the SPA

Verification Gate:
- saving a draft still works from the SPA create-post view
- draft editing and publish flows still work
- draft entry points no longer leave the SPA

Implementation Notes:
- the create-post "Save Draft" button (`name="action" value="draft"`) is now
  wired: the form submit handler reads `event.submitter` and, in create mode,
  treats a `draft` submitter as a draft save (`post.page.js`). A keyboard submit
  has no submitter and defaults to a normal publish.
- `createPost` (`post.api.js`) takes an optional `status` and forwards it on both
  the JSON and multipart paths (`buildPostMultipartFormData` in
  `core/shared/utils.js` appends a `status` field); the status is only sent when
  explicitly `draft`/`published`, so existing callers default to the backend's
  `published`. Draft creation reuses `POST /api/v1/posts` with `status="draft"`
  — no backend changes, and the `/api/v1/posts/draft` endpoints are intentionally
  left unused.
- draft validation is relaxed to match the backend: a draft requires a title and
  body-or-image but not a category (publish still requires a category).
- on a successful draft save the SPA shows "Draft saved." and navigates to
  `/activity` (where drafts are listed) via the in-SPA router — no full reload.
- publish stays in the existing Activity owner toggle
  (`PATCH /api/v1/posts/{id}` with `status="published"`); edit-post is unchanged.
- coverage: `post.page.test.js` asserts a draft submit sends `status="draft"` and
  navigates to `/activity`, a normal submit sends `status="published"`, drafts
  skip the category requirement, and publish still enforces it.
