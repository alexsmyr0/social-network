# Content, Audiences and Lifecycle — SN-B14

Prepared 2026-10-06 on `asmyrogl/B14`, based on merged main `e890eae`. **Owner-approved contract and fixture handoff; B14 verification gate satisfied.** [Phase 2–3 product policies](phase-2-3-decisions.md) are already approved. [A11 acceptance](phase-2-acceptance.md) is complete. Status lives in the [tracker](ticket-tracker.md).

B14 changes documentation/fixtures only. B15 implements publishing/schema/feed/media; B16 implements discussions/activity/notification consumers; A12/A13 implement Vue using the approved fixtures; A14 performs real-service acceptance. [Data mappings and recovery](phase-3-data-plan.md) and [executable HTTP examples](fixtures/phase-3-contract.json) are part of this single approval package. No group/chat/event interfaces or runtime migrations are added.

## Approved concrete choices

| Choice | Recommendation and alternative |
|---|---|
| Routes and payloads | Extend inherited `/posts`, `/comments`, category/navigation/activity/media routes; preserve existing names, add audience/version fields. A new parallel content API would duplicate adapters. |
| Audience values | `public`, `followers`, `selected`; owner-only `selected_follower_ids` array of account IDs, not follow IDs. Store exact accepted follow identity internally so refollow never restores a grant. |
| Stale writes | Required `expected_version` for post/comment edit/delete and draft update/delete. Return `409 STALE_CONTENT`; authorization precedes conflict disclosure. Last-write-wins risks reverting a newer audience or attachment. Reactions retain serialized toggle behavior without a version. |
| Draft completeness | Allow empty/incomplete drafts and multiple stored drafts. Keep latest-draft convenience endpoint and list all through owner activity. Publishing requires text or image; selected publication requires at least one eligible selection. Requiring complete drafts would prevent saving unfinished work. |
| Bounds and paging | Extend Phase 2's strict paging rules to these routes; JSON body 64 KiB, title 200 Unicode code points, post/comment body 10,000, categories 50, selected followers 500. Preserve B13 image/body budgets. Alternative is unbounded content or retaining the smaller 16 KiB JSON limit. |

The owner approved all concrete choices, this contract, the data plan and fixture handoff on 2026-10-06 by stating “I agree with all, implement.” One owner approval covers this package; no separate Dev 1 fixture sign-off is required. Existing privacy, audience, ownership, media storage, notification and framework choices remain binding.

## Transport, errors and field rules

Prefix every route below with `/api/v1`. Preserve [auth/session/origin policy](auth-contract.md#session-cookie-and-origin-policy), [Phase 2 envelopes/IDs](profiles-contract.md#common-rules-and-validation) and B13 `Cache-Control: no-store`. GETs never perform business writes. All writes require valid session, allowed Origin/Referer and `X-Requested-With: XMLHttpRequest`; missing session is `401 UNAUTHORIZED`, forbidden origin/header is `403 ORIGIN_FORBIDDEN` / `CSRF_CHECK_FAILED`. A lookup/storage outage is 500/503, not permission loss. Media anonymous reads are 401; authorized-session missing/denied reads are indistinguishable 404.

Method → write origin/header → session → bounded strict body/query parsing → field validation → current resource/ownership access → version and relationship checks under serialized transaction → commit. Unsupported method returns 405 with exact `Allow`. Unknown/repeated JSON keys, trailing values, invalid UTF-8, non-object JSON, malformed decimal IDs/versions, unknown/repeated query keys or invalid parameter types return `400 BAD_REQUEST`. Denied resources never expose version, selection, title or error detail. Structurally valid unknown/inactive/foreign resources return `404 NOT_FOUND`.

JSON and multipart are supported on post/comment creation and edits. JSON body limit is 64 KiB; multipart total limit is 10 MiB, each image 5 MiB. Text fields use the same limits in either encoding. Multipart scalar fields occur once; `category_ids` and `selected_follower_ids` are repeated decimal fields; a single empty array field clears that array and cannot mix with nonempty entries. `expected_version`/`parent_comment_id` are decimal strings, boolean `remove_image` is exactly `true` or `false`. No arbitrary structured JSON is parsed from multipart text. JSON-only content-type mismatch is `415 UNSUPPORTED_MEDIA_TYPE`; excessive body/file bytes are `413 PAYLOAD_TOO_LARGE`.

Normalize body CRLF (`\r\n`) line endings to LF (`\n`) in both JSON and multipart before trimming surrounding Unicode whitespace and validating text. Trim surrounding Unicode whitespace from titles too; missing title/null/whitespace becomes `null`, missing create body becomes `""`. Body cannot be null. Plain text only; allow newline/tab in bodies, reject other control characters (including remaining lone `\r`); title rejects all controls. Lengths measure Unicode code points after normalization and trimming. Overlength fields use `400 VALIDATION_ERROR`, `fields.<field> = TOO_LONG`; bad text uses `INVALID_TEXT`. New published posts and comments require nonempty body or a valid attached image (`CONTENT_REQUIRED`). Title and categories are optional. Image-only posts/comments are valid. Drafts may have neither body nor image, but all supplied fields remain validated.

JSON `category_ids`/`selected_follower_ids` must be arrays of unique positive safe integer IDs; null, duplicates, invalid numbers and over-limit arrays are field errors (`INVALID_IDS` / `TOO_MANY`). Category IDs must currently exist (`INVALID_CATEGORY`); no category CRUD is introduced. Audience is exactly `public`, `followers` or `selected`; create default `public`. Invalid audience enum is `INVALID_AUDIENCE`; invalid status is `INVALID_STATUS`, both field validation errors. Selections on another audience must be absent/empty (`INVALID_SELECTION`). For `selected`, every supplied ID must identify a current active accepted follower of the author, never self/pending/outsider; failure is `400 VALIDATION_ERROR`, `fields.selected_follower_ids = INVALID_SELECTION`, with no identifying details. Selected drafts may have an empty array; publishing them fails until at least one eligible follower is chosen.

Fresh uploads use multipart `image`, never remote URLs or another resource's stored attachment. Omitted edit image preserves it; JSON `image_url:null` or `remove_image:true` removes it; nonnull `image_url` can only retain that same resource's current URL. Upload plus removal/nonempty `image_url` is `400 BAD_REQUEST`. Existing checked legacy URLs can be retained on their own resource, not copied into another. JPEG/PNG/GIF validation, corruption/MIME/dimension/frame failures and all-owner rollback/cleanup follow [B13](backend-content-media.md#manifest-writes-and-cleanup): `422 INVALID_IMAGE` with `fields.image`, or 413 for byte budgets. Missing recoverable historical media stays referenced and returns 404; it does not delete accessible text. New publication must have actual text or ready media; a missing image alone cannot satisfy `CONTENT_REQUIRED`.

Paginated list routes use `page` default 1, range 1–1,000,000; `per_page` default 20, range 1–50; reject invalid values instead of clamping. Return `data:[]`, `meta.pagination:{page,per_page,total,total_pages}`. Empty total implies zero pages; beyond-last page has empty data and current totals. Filter permission before counts/paging/navigation; items/totals/projections use one read snapshot. Order posts by `(created_at DESC,id DESC)`, comments oldest `(created_at ASC,id ASC)` for threads, activity comments newest. No stable snapshot between requests is promised; reset page after changes. Category metadata and `/categories/view` retain unpaginated responses and accept no query parameters. Following filters combine with category filters using AND and include only current accepted outgoing-follow authors; own posts are excluded.

## Response schemas

Post contains exactly `id`, `author_id`, `author` (approved display name), `title` (string/null), `body`, `image_url` (checked relative URL/null), `status` (`published`/`draft`/retained `archived`), `audience`, `version`, `categories:[{id,name}]`, `created_at`, `updated_at`, `likes`, `dislikes`, `my_reaction` (-1/0/1). Only the author also receives `selected_follower_ids` (sorted, empty on non-selected audiences). Other viewers omit that key entirely, including selected recipients. No follower IDs, internal username, email or session fields appear in content serializers. Media ID/URL is opaque, not an access grant.

Comment contains exactly `id`, `post_id`, `user_id`, `username` (approved display name, retained compatibility key), `parent_comment_id` (null or ID), `body`, `image_url`, `version`, `created_at`, `updated_at`, `likes`, `dislikes`, `my_reaction`. A private commenter in a permitted public discussion contributes their display name, not private profile fields; an inactive commenter is excluded. Comments inherit parent-post permission; no separate comment audience or selection list exists.

Private comment activity retains `UserActivityComment` with all Comment fields plus `post:{id,author_id,author,title,image_url,categories,likes,dislikes,my_reaction}`; that post projection is hydrated from the same authorized snapshot. Preserve fields used by inherited views; no hidden parent title or bytes survive in activity.

Example creation and owner response (IDs/times synthetic):

```json
{"body":"Hello","audience":"selected","selected_follower_ids":[7],"category_ids":[]}
```

```json
{"data":{"id":101,"author_id":42,"author":"Alex Example","title":null,"body":"Hello","image_url":null,"status":"published","audience":"selected","version":1,"categories":[],"created_at":"2026-10-06T12:00:00Z","updated_at":"2026-10-06T12:00:00Z","likes":0,"dislikes":0,"my_reaction":0,"selected_follower_ids":[7]}}
```

The same post for selected viewer 7 omits `selected_follower_ids`; viewer 8 receives 404. Detail/body errors use the existing error envelope, e.g. `{"error":{"code":"STALE_CONTENT","message":"Content changed; refresh and retry"}}` with 409 after current ownership/access passes. No current content/version is included in the conflict body.

## Reads and feature parity

| Method/path | Query / response | Delivery owner |
|---|---|---|
| `GET /posts` | Pagination; optional `category_id`, `feed=all|following` (default all). Published authorized Post list; category AND Following. | B15 / A12 |
| `GET /posts/{id}` | Post detail; permitted owner may read own drafts/archived. | B15 / A12 |
| `GET /users/{id}/posts` | Pagination; full-profile permission AND published parent access, even for owner. | B16 / A13 |
| `GET /users/{id}/comments` | Pagination; full-profile permission AND published parent access; Comment list newest first. | B16 / A13 |
| `GET /posts/mine` | Pagination; `status=all|published|draft` default all; owner only, all also includes historical archived. | B15 / A12 |
| `GET /posts/liked`, `/posts/disliked` | Pagination; caller's history, current parent permission. Ignore no forged owner parameter: reject it. | B16 / A13 |
| `GET /users/activity` | Pagination; status filter applies to created posts only; data has `created_posts`, `liked_posts`, `disliked_posts`, `comments`, each `{items,pagination}`. Owner only; current parent permission. | B16 / A13 |
| `GET /posts/draft` | Latest owner's draft ordered `(updated_at DESC,id DESC)` as Draft below, or explicit `data:null`. Never silently replace other drafts. | B15 / A12 |
| `GET /posts/{id}/comments` | Pagination; parent must be readable or 404; oldest-first Comment list including nested parent IDs. | B16 / A13 |
| `GET /comments/{id}` | Comment detail under parent access; inactive commenter/denied parent 404. | B16 / A13 |
| `GET /categories`, `/categories/{id}` | Retain authenticated category metadata `{id,name,created_at}` (not private-content statistics); category missing 404. | B16 / A12/A13 |
| `GET /categories/view` | Retain array `{id,name,posts:[Post]}`; only published authorized posts, including owner. | B16 / A12/A13 |
| `GET /posts/{id}/nav` | Optional `category_id`, `feed=all|following`; source must be authorized and published, match filters, else 404; data `{category_id,prev_id,next_id}`, nullable; omitted category produces `category_id:null`. Older/newer by `(created_at,id)`; optional category supports uncategorized posts. | B16 / A13 |
| `GET /media/{id}`, checked `/static/uploads/...` | B13 byte responses; current owning post/comment/audience permission on each request; authorized historical DM/avatars unchanged. | B15/B16 / A12/A13 |

Draft shape is `id,title,body,image_url,category_ids,updated_at,audience,version,selected_follower_ids`; return empty arrays explicitly. Profile teaser access to `/users/{id}/posts|comments` returns 404, not an empty list/count; authorized profile with no permitted content returns empty 200. Profile/activity counts include only permitted content. Privacy teaser itself remains the approved 200 profile response.

## Mutations and lifecycle

| Method/path | Input | Success |
|---|---|---|
| `POST /posts` | Optional title/body/categories/image; audience/selections; `status=published|draft` default published. | 201 full owner Post; one durable post/media association. |
| `PATCH /posts/{id}` | Required `expected_version`; at least one of title/body/category_ids/image/remove_image/audience/selected_follower_ids/status. Omission preserves; arrays replace; explicit null title clears. | 200 full owner Post; all supplied fields change atomically. |
| `DELETE /posts/{id}?expected_version=N` | Empty body; required version; owner/current access. | 204 empty, post/descendants removed. |
| `POST /posts/draft` | Create fields above without status; optional compatibility `manual` boolean has no effect on completeness; never autosaves onto a different post. | 200 `{data:{id,version}}`; always creates a new draft. |
| `PUT /posts/draft/{id}` | Same partial-edit semantics as PATCH, `expected_version`; cannot supply status, must still be a draft. | 204 empty; effective change increments version. Reload detail/latest draft to obtain it. |
| `DELETE /posts/draft/{id}?expected_version=N` | Empty body, required version; owner and still-draft. | 204 empty. |
| `POST /posts/{id}/comments` | Optional body/image and nullable/omitted `parent_comment_id`; parent comment must be active, visible and on same post. | 201 Comment; comments have no status/audience fields. |
| `PATCH /comments/{id}` | Required `expected_version`; body/image/removal only, at least one change field. No parent/post/user reassignment. | 200 updated Comment. |
| `DELETE /comments/{id}?expected_version=N` | Empty body; matching version, comment author plus current parent access. | 204 empty; cascade child comments even if another author owns them. |
| `POST /posts/{id}/like|dislike`, `/comments/{id}/like|dislike` | Empty body; current parent access, serialize permission with reaction write. | 200 `{data:{post_id, reaction, likes_count, dislikes_count}}` (comment route substitutes `comment_id`); reaction is -1/0/1; same reaction removes, opposite switches. |

Every edit/delete compares supplied version in the permission-checked write transaction. Effective post title/body/media/category/status/audience/selection change increments post version and updated_at once; comment edit increments its version once. Exact no-op still checks current access/version and returns current state without increment or invalidation. Post reactions/comment creation do not change post edit version. Selected-grant removal on unfollow increments affected post versions once, preventing a stale owner form from restoring removed selections. IDs/versions retain the safe-integer ceiling; overflow fails before commit rather than wrapping.

Changing to `public`/`followers` clears selections atomically. Switching to `selected` requires supplying selections; staying selected may omit them to retain current grants. All selected grants are revalidated on any publish/republish and selection edit. The response never silently drops invalid submitted IDs. A follower leaving after validation cannot leave a committed dangling grant: serialize follow/selection writes and bind grant to accepted follow identity. Selecting inactive/expired follows fails as `INVALID_SELECTION`; a stale version returns STALE_CONTENT first after access. Zero grants after later unfollow are allowed for an already-stored selected post, visible only to author until edited; this is not permission to publish a new selected post without recipients.

`status:published→draft` hides discussion/media/counts/notices from everyone except author, retaining IDs/comments/reactions/attachments/grants. Draft→published uses current validation and permissions, keeps original created_at/order, does not generate duplicate historical notices. Archive remains owner-readable retained data; no new archive write workflow is introduced. Owner can edit/delete or explicitly change historical archived→draft/published under the same validation. New requests may not set `archived`.

Authors can mutate their own personal post/draft; comment authors can edit/delete only while parent readable. Another user's readable post/comment does not grant ownership. Post owner cannot edit/delete an individual foreign comment, but deleting their post cascades all descendants. Deleting a comment recursively deletes nested descendants and associated reactions/notices/media links under existing FK semantics. Delete unreferenced private objects only after commit and full avatar/post/comment/DM/pending reference checks; preserve legacy sources. Upload/validation/version/commit failure preserves previous content/bytes and emits no signal. Committed cleanup or signal failure is deferred/logged, not a false rollback response.

Lost create/reaction response has unknown outcome: do not automatically replay non-idempotent writes; refetch and offer explicit action. Lost edit/delete response also requires refetch; a retry may be stale/404 after successful commit. Do not introduce an idempotency-key service or silently replay a toggle.

## Access matrix and invalidation

For an active authenticated non-author viewing a published personal post:

| Author profile | Audience | Non-follower / pending | Accepted not selected | Selected current follower |
|---|---|---|---|---|
| public | public | Allow | Allow | Allow |
| public | followers | Deny | Allow | Allow |
| public | selected | Deny | Deny | Allow |
| private | public | Deny | Allow | Allow |
| private | followers | Deny | Allow | Allow |
| private | selected | Deny | Deny | Allow |

Active author retains personal post/draft/archive access regardless of audience; inactive viewer/author and anonymous viewers receive no content. An inactive viewer fails session authentication with 401; an inactive author is hidden with 404 from an active viewer. Pending is never accepted. For draft/archive, only active author reads/mutates. The same predicate protects detail, comments, reactions, attachment bytes, lists, totals, navigation, category projections, profile activity and notification targets. Full profile permission cannot broaden post audience. New followers see older followers-only posts; unfollow revokes dependent access/grants immediately; a new follow identity never restores selected grants. Profile private→public does not broaden a selected/followers audience; pending auto-accept grants followers access, not selection.

Preserve the [B10 notice shapes and read behavior](profiles-contract.md#durable-notifications-and-read-actions). Hidden/deleted/draft/archived targets disappear from list, total, unread/read-one and excerpts; stored hidden read state is retained while the target exists; read-all skips hidden rows. Parent post title may now be null, and inherited post-target comment alerts still do not invent a specific comment excerpt. Authorized comment-reaction excerpts remain plain text capped at 20 Unicode code points; image-only excerpt is `""`. Denied recipient cannot act via an old notice; target permission is rechecked. Private actor redaction remains name-only on an otherwise permitted thread. Comment/reaction notice insert/dedup is atomic with mutation; self-actions create no notice; preserve existing dedup identities, no notice on post creation or republication.

After successful content edits/deletes/publication/audience/reaction/comment changes, broadcast existing empty `{"type":"social.invalidate"}` to authenticated sockets (conservative existing fanout); no resource/version/selection/content in signals. Actual new notice also sends recipient-only `{"type":"notification.new"}` after commit. No-op/rollback is silent. Follow/privacy invalidation remains B12 plumbing and now invalidates audience/selection-dependent views too. Browser discards protected content immediately, refetches on signal/connect/reconnect/focus, coalesces superseded responses and uses existing visible-screen 60-second fallback. 401 clears session caches/socket; 5xx shows unavailable state without asserting logout or keeping denied cached bodies. Already downloaded content cannot be retracted. Message frames/indicators and Phase 5 behavior are unchanged.

## Fixture handoff and verification

[Fixture pack](fixtures/phase-3-contract.json) defines synthetic actors, reset state, exact request/response bodies, raw/multipart representations, response headers, matrix metadata and transition postconditions. Every case resets independently unless its explicit steps say otherwise; consumers model its prerequisite state rather than invent universal mock successes. No production handler/seed imports fixtures. All 18 matrix cells include detail/thread/media/feed examples; author/draft/inactive/anonymous, privacy/follow/selection transitions, nested deletion, bonuses, invalid writes, permission races and notice redaction/recovery have separate examples.

Run `python3 docs/social-network/fixtures/validate-phase-3.py`, fixture Biome, documentation link/anchor/graph/count checks and `git diff --check`. These validate the contract and fixture artifacts, not running API/migration/browser behavior. Owner approval and artifact checks unlock A12 and B15. A13/B16 retain their own direct prerequisites; runtime gates remain independent of A14. This package received one owner approval, not a duplicate Dev 1 sign-off.

Owner approval: recorded 2026-10-06. Fixture completeness/consistency checks passed; the tracker marks B14 complete. This approves the interface and handoff, not future runtime results.

## Draft verification record — 2026-10-06

Working tree on `asmyrogl/B14` based on main `e890eae` (A10/A11/B13 already complete):

- `python3 docs/social-network/fixtures/validate-phase-3.py` — passed: **246** HTTP cases; all **18** profile/audience/relationship cells across detail/thread/media/feed; exact six-step unfollow/refollow/reselection sequence; schema/redaction/error/signal/pagination checks; local links/anchors, parsed JSON examples and **36** ticket dependency/reverse-edge/status checks (**24 complete, 1 in progress, 11 unstarted**).
- Inline Python corruption probes also proved the validator rejects missing matrix coverage, recipient selection disclosure and reused follow identities.
- `bun x biome check docs/social-network/fixtures/phase-3-contract.json` — passed after fixture-only formatting.
- `bun x vitest run SPA/tests/unit/docs-consistency.test.js` — **10/10** passed.
- Whitespace checks include tracked and new artifacts. No API, migration, image, browser or socket checks were run for this documentation-only handoff. Those remain B15/B16/A14 verification gates.

At draft verification, owner approval was still pending and those checks did not unlock consumers. The subsequent approval/completion record below supersedes that draft gate state. Earlier local B13 evidence/context notes were preserved at `.tmp/b13-local-notes-before-b14.patch` before switching from the stale B13 checkout to merged main; no outdated status changes were applied to this branch.

## Owner approval and completion record — 2026-10-06

The owner approved all recommendations and the contract/data/fixture handoff with “I agree with all, implement.” Approval includes existing route extensions, owner-only selections, version-checked edits/deletes, incomplete/multiple drafts, publication/selection requirements, exact limits/paging and data-preserving upgrades. The owner is Dev 1; no second fixture approval is requested.

After recording approval, `python3 docs/social-network/fixtures/validate-phase-3.py` passed the 246 HTTP fixtures, all 18 matrix cells across four surfaces, the exact follow/reselection sequence, response/redaction/signal/pagination checks, links/anchors, JSON examples and the full 36-ticket dependency/reverse-edge/status graph. Counts are **25 complete, 0 in progress, 11 unstarted**. Fixture Biome, docs-consistency Vitest **10/10**, and tracked/new-artifact whitespace checks passed. These are documentation/fixture checks only; no application, SQL migration, image or realtime implementation is claimed. B14 is complete; B15 and A12 are eligible to start.
