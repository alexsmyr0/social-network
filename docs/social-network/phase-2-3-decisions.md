# Phase 2–3 — Approved Product and Architecture Decisions

Recorded from the owner's planning interview on 2026-10-01. This record governs [Phase 2 and Phase 3](roadmap.md); it does not claim implementation. The owner requested ticket authoring only, followed by questions for later phases. The [tracker](ticket-tracker.md) remains the status authority.

## Approval and scope

The owner approved the product choices below and all three architecture recommendations: extend the existing SQLite model, centralize permission checks with protected backend media, and persist notifications before signalling through the existing WebSocket. Vue, Go, SQLite, `/api/v1`, cookie sessions, the same-origin proxy and two images remain the foundation.

Existing features must be preserved, including inherited bonuses. Port them into the Vue application in the relevant phase and adapt their permissions; keeping source files alone does not complete that work. Existing features are not authorization to preserve insecure access paths. New profile editing beyond privacy, blocking/moderation, category administration, and other unimplemented extras are not implicitly added.

New tickets target roughly three Phase 1-sized work slices per coherent outcome, generally within the requested 2–3× scope. Their prose remains compact. Planning Phases 2–3 now is explicitly authorized despite the earlier next-phase-only rule. Runtime implementation still requires the preceding phase's acceptance.

## Profiles, discovery and following

| Topic | Approved behavior |
|---|---|
| New profile | Public by default; owner may switch public/private afterward. |
| Public profile | Signed-in users may view registration information except password, permitted activity/posts, and followers/following. Password hashes, session tokens and internal compatibility fields are never profile information. |
| Private profile | Owner and accepted followers may view profile details. A non-follower sees only display name and follow/request controls; no avatar, email, birthdate, about-me, activity, follower lists or their counts. |
| Discovery | A searchable People page searches display names. Private-account results use the same minimal identity and controls; direct profile links do not broaden access. |
| Following a public account | Immediate accepted follow. Relationships are directional, not mutual friendships. |
| Following a private account | Pending request; only the recipient accepts or declines. A pending request grants no follower access. |
| Public → private | Existing accepted followers stay accepted. New followers need approval. |
| Private → public | Pending incoming requests become accepted automatically. |
| Cancellation and rejection | Sender can cancel a pending request. After rejection, sender can request again. There is at most one pending/accepted relationship per directional pair. |
| Unfollow | Accepted relationship ends and follower-dependent access is removed. Per-post selections for that relationship are removed too. Following again does not restore those selections. |

The display-name teaser is an owner-approved limited discovery exception to the assignment's private-profile wording. The source [requirements](requirements.md#profile) remain unchanged. Email and date of birth are part of an authorized full profile because the assignment expressly includes registration information; they are not searchable directory fields.

Self-follow, another user's request decision, duplicate submission and stale request actions need explicit contract outcomes. A cancelled/rejected request followed by a new request must not let an old notification act on the new request. SN-B10 records the concrete errors and identity/version handling before implementation.

## Posts, audiences and activity

The three required post audiences are Public, Followers only (the assignment's “almost private”), and Selected followers (its “private”). Selection belongs to an individual post, not a special account type or reusable circle.

| Author profile | Post audience | Signed-in non-follower | Current follower not selected | Selected current follower |
|---|---|---|---|---|
| Public | Public | Allow | Allow | Allow |
| Public | Followers only | Deny | Allow | Allow |
| Public | Selected followers | Deny | Deny | Allow |
| Private | Public | Deny | Allow | Allow |
| Private | Followers only | Deny | Allow | Allow |
| Private | Selected followers | Deny | Deny | Allow |

This matrix concerns published personal posts viewed by someone other than the author. Authors retain access to their own personal content, including drafts. Unauthenticated users do not gain social-content access from the word “Public.” Profile visibility and post audience both constrain access; one cannot broaden the other. The later [Phase 4 decision](phase-4-decisions.md#group-content-and-existing-features) defines group content separately: current membership is required even for the author.

The owner explicitly chose private-profile restrictions to override a public post audience. The assignment states both rules without resolving their interaction. Record this interpretation in acceptance evidence and revisit it if the later official audit gives a contrary interpretation; do not silently change the supplied requirements or claim an official ruling.

| Topic | Approved behavior |
|---|---|
| Follower changes | New accepted followers can see older followers-only posts. Unfollowing removes access immediately where following was required, including associated comments and attachments. |
| Selected followers | Only chosen current followers may view a selected-audience post. After unfollow/refollow, the author must select that person again. |
| Audience edits | Authors may change a published post's audience in either direction and edit its selections. Current permissions apply to lists, direct links, interactions and media. Comments/reactions remain stored subject to those permissions. |
| Feed | Default shows all posts the viewer may access, newest first. Preserve category filters and add a Following filter. |
| Profile activity | Permitted profile viewers see authored posts and comments only when they can also access the underlying post. Liked/disliked history and drafts remain in the owner's private activity area. |
| Titles and categories | Both optional; retain title display, category selection and filtering. A published post still needs text or an image/GIF. |
| Composer default | Public, visibly selected and changeable before publishing; author-profile restrictions still apply. |
| Unpublish/republish | Moving a post back to drafts hides the whole discussion from others while retaining comments/reactions. Republishing applies the chosen audience and revalidates current selected followers. |
| Existing mutations | Preserve owner post/comment editing and deletion, attachment replacement/removal, drafts and publication controls. New privacy rules constrain access to those operations. |

Comments and their images inherit the parent post's permissions. A comment author's private profile does not make another author's public thread private; only their display name and otherwise permitted profile fields may be disclosed. Profile activity combines the activity owner's profile restriction with the parent post restriction. Owner activity is not a bypass for reading someone else's now-inaccessible post.

Permission changes govern subsequent reads/writes. Connected screens should discard/refetch affected protected state; logout clears user-specific caches. Neither server checks nor browser refreshes can retract material already viewed or saved. Draft contents and audience selections must not leak through counts, category summaries, navigation, notifications or media URLs.

## Approved architecture

### Extend the current data model

Use new numbered migrations with the existing tooling. Add profile visibility, one directional follow table containing pending/accepted states, post audience, and per-post selected-follower associations. Enforce uniqueness and current-follow eligibility. Do not introduce separate request/follower stores, a new database, or future group/event tables in these phases.

Upgrades preserve existing social-network accounts, sessions, content, categories, reactions, notifications and media associations. The Phase 1 fresh-database decision applies to refusing unversioned forum databases; it does not authorize resetting an existing versioned social-network database at each phase. SN-B10/SN-B14 must spell out compatible backfills, foreign keys, constraints and failure recovery. Existing published content must receive explicit audience/status mappings rather than silently disappearing.

Keep SQL in `internal/db/`, HTTP behavior in `internal/handlers/`, and route wiring in `internal/router/`. Profile changes, follow transitions and affected selections/notifications must commit consistently under concurrent requests. Schema/API details are written in the contract handoffs before their consumers start.

### Shared authorization and private media

Centralize the profile/post access rules and reuse them across reads, mutations, queries and media. Filter before pagination, totals and previous/next navigation. A permitted profile must not reveal a post excluded by its audience. Unauthorized direct requests and indirect summaries must agree.

Extend backend-owned private file storage used by [avatars](backend-avatars.md) to post/comment attachments. Media responses authenticate and check the owning resource on every request; possession of a URL does not grant access. Preserve JPEG/PNG/GIF and existing single-attachment, image-only, replacement and removal flows. Validate file contents and bound resource use; the contract records exact limits and errors.

The retained [frontend static route](../../cmd/frontend/routes.go) can serve legacy `/static/uploads/` bytes without a resource check. Phase 2 must account for this before accepting profile privacy. SN-B13 migrates or protects existing attachment references and stops raw static paths from bypassing authorization. Preserve recoverable bytes and associations; missing/unmappable files require an explicit report and recovery path, not silent deletion. Cleanup must recognize every retained media owner, so the existing avatar orphan sweep cannot delete newly migrated content files. Preserve later-phase DM media while changing shared storage/routes.

### Durable notifications and one WebSocket

Extend the current notification store and session-owned socket. Save a notification in the same database transaction as its triggering change; signal only after commit. The browser fetches authorized current state on signals and reconnect. Preserve unread counts, individual/all-read actions, and comment/like/dislike alerts; add private-profile follow requests in Phase 2. Do not add a queue or guaranteed event replay service.

Signals must not carry protected excerpts that bypass current access checks. Notification reads, badges and actions re-evaluate recipient permissions and request state. Follow/profile/audience changes invalidate affected displayed data. Lost socket signals cannot lose the stored notification; reconnect/refetch recovers state. Message indicators remain distinct from general notifications. Group/event notifications and adapted chat behavior remain later work.

### Alternatives considered

| Choice | Rejected alternative and tradeoff |
|---|---|
| One follow-state table | Separate request and accepted-follower tables require coordinating transitions across stores. |
| Backend private media files | SQLite image BLOBs would change the established storage approach and increase database size. Public static URLs cannot enforce the approved privacy rules. |
| Stored notifications plus refresh signals | Guaranteed event replay requires additional delivery machinery. The approved design restores state from the database instead. |

## Feature preservation and ticket ownership

These are code-inspection findings, not fresh runtime verification. The current Vue router contains only Phase 1 routes; retained vanilla views are migration sources.

| Existing capability / evidence | Delivery ownership |
|---|---|
| [Categories and filtered feed](../../SPA/features/feed/feed.page.js), category summaries and post navigation | Privacy boundary in SN-B13; audience-aware queries and Vue flows in SN-B15/B16 and SN-A12/A13. Category administration is not an established routed feature. |
| [Post/comment reactions](../../internal/db/reactions.go), toggle/remove/switch and counts | SN-B16 and SN-A13; protect inherited access in SN-B13. |
| [Drafts](../../internal/db/post_drafts.go), publishing/unpublishing, [owner activity](../../SPA/features/activity/activity.page.js) | SN-B15/B16 and SN-A12/A13; retain private liked/disliked and comment history. |
| [Post editing/deletion](../../internal/handlers/posts.go), [comment editing/deletion and nesting](../../internal/db/comments.go) | SN-B15/B16 and SN-A12/A13; preserve existing deletion behavior and document its descendant/attachment effects in SN-B14. Retain nested-comment API support without inventing category/admin features. |
| JPEG/PNG/GIF, image-only content, replacement/removal | SN-B13 storage/read migration; SN-B15/B16 mutation flows; SN-A12/A13 UI. |
| [Notifications](../../internal/handlers/notifications.go), unread/read controls and socket delivery | SN-B12 and SN-A10, then content-event adaptations in SN-B16/SN-A13. |
| [Read-only profiles](../../SPA/features/profile/profile.page.js) | SN-B11 and SN-A09; Phase 3 adds permitted posts/activity. A general profile editor was not found as an existing feature. |
| [DMs, images, presence, history and roster](../../SPA/features/chat/), reconnect and unread behavior | Preserve source and compatibility now; discuss and ticket their social-network adaptation in Phase 5. |

## Contract handoffs and implementation gates

The choices above are settled. SN-B10 and SN-B14 translate them into exact requests/responses, examples, schema/migration mappings and test fixtures. They are bounded contract work, not a second interview about framework, privacy policy or storage strategy. The owner is Dev 1; one owner approval covers the contract and fixture handoff, with ticket checks establishing fixture completeness/consistency. New public-interface decisions not covered here require owner approval before dependent implementation. Future artifacts are explicitly named in those tickets rather than linked as existing files.

SN-A09/A10 and SN-A12/A13 may pass frontend gates against approved contract fixtures; production cannot ship mock responses. SN-A11 and SN-A14 require real multi-user browser/API/media evidence through both images. SN-A07 still gates Phase 2 execution. Phase 3 execution starts after SN-A11. Shared runtime/CI extensions retain B's ownership under SN-B07; acceptance supplies scenarios through that harness rather than introducing another deployment design.

Planning validation covers ticket graph, references, scope and decision fidelity. It does not complete a feature or satisfy an application acceptance gate. Subsequent group approvals and ticket authorization are recorded in [Phase 4 decisions](phase-4-decisions.md); Phase 5 is explicitly pending and Phase 6 remains roadmap-only. This record does not authorize application implementation in this planning session.
