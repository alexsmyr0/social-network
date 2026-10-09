# Groups, Membership and Group Content — SN-B17

Prepared 2026-10-09 on `asmyrogl/B17`, based on merged main `e331ca0`. **Owner-approved contract and fixture handoff; B17 verification gate satisfied.** [Phase 4 product and storage decisions](phase-4-decisions.md) are already approved and are not reopened here. [Phase 3 acceptance](phase-3-acceptance.md) is complete. Status lives in the [tracker](ticket-tracker.md).

B17 changes documentation and fixtures only. B18 implements group schema, discovery, membership transitions and transactional notices; B19 applies membership to posts, comments, reactions, media and aggregate consumers; A15/A16 build Vue flows against the fixtures; A17 performs real-service acceptance. [Data mappings and recovery](phase-4-data-plan.md) and [executable HTTP examples](fixtures/phase-4-contract.json) are part of one approval package. Events, group chat, moderator roles, ownership transfer, group deletion and personal-to-group conversion remain outside it.

## Approved concrete choices

| Choice | Recommendation and alternative |
|---|---|
| Routes | New resources `/groups`, `/group-invitations/{id}`, `/group-join-requests/{id}`, `/group-memberships/{id}` and `/users/me/group-invitations`, mirroring `/follows` and `/follow-requests`. Alternative: nest every action below `/groups/{id}`; equivalent policy, longer client routes. |
| Request identities | Invitation, join-request and membership IDs come from never-reused `AUTOINCREMENT` sequences. Resolved invitations/requests are **deleted**; history lives only in notices (`group_state`). A deleted or unknown ID is `409 STALE_*`. Alternative: retain terminal rows with a state column, which adds states, revival questions and no stronger protection. |
| Membership generation | The membership ID is the generation. Leaving or removal deletes the row; a fresh admission creates a new ID, so `DELETE /group-memberships/{old id}` cannot remove a returned member (`409 STALE_MEMBERSHIP`). No separate counter is needed. |
| One removal/leave route | `DELETE /group-memberships/{id}` is leave when the row is the caller's, removal when the caller is the group's creator and the row is another member's. Alternative: two routes; more surface for the same rule. |
| Duplicate actions | Same inviter→invitee and requester→group pairs are idempotent (`200`, same ID, no new notice). Different inviters may each hold one pending invitation for the same person. Repeating a decision after resolution is stale, never an idempotent success, so a replay cannot recreate access. |
| Role-dependent fields | `member_count` appears only for members; nonmembers see title, description, creator `{id, display_name}` and their own pending entries. Member entries reuse B10 People redaction (teaser/no avatar for private profiles). Alternative: show counts to everyone, which discloses membership aggregates the owner did not approve. |
| Denial outcome | Members-only reads/writes by nonmembers, departed users and invitees return the uniform `404 NOT_FOUND`; wrong-role actors on an existing entry also return 404 and an unknown/resolved ID returns the pinned `409`. No new FORBIDDEN code. |
| Group content scope | Reuse `POST /posts` and every Phase 3 route with optional `group_id`; Post and drafts gain nullable `group:{id,title}` and group posts report `audience:"group"`. `group_id` is create-only (`IMMUTABLE` otherwise) and cannot combine with `audience`/`selected_follower_ids` (`GROUP_SCOPE`). Alternative: a parallel `/groups/{id}/posts` API that duplicates adapters. |
| Signals | Existing empty `social.invalidate` and recipient-only `notification.new` only. Entry/membership signals go to the users named by the transaction plus current members when membership changed; group creation and content changes keep the existing all-authenticated fanout. No new queue, socket, database or service. |
| Bounds | JSON group bodies 16 KiB; title 1–100 and description 1–1000 Unicode code points after trimming; `q` ≤100; Phase 2 paging rules (`page` 1–1,000,000, `per_page` 1–50, strict). |

The owner approved all choices below on 2026-10-09 by stating “I approve”. That single approval covers this contract, the [data plan](phase-4-data-plan.md) and the [fixture pack](fixtures/phase-4-contract.json). The owner is Dev 1; no second fixture review is requested. Existing privacy, ownership, media-storage, notification and framework choices remain binding.

## Transport, errors and field rules

Prefix every route with `/api/v1`. Preserve the [auth/session/origin policy](auth-contract.md#session-cookie-and-origin-policy), [Phase 2 envelopes and ID limits](profiles-contract.md#common-rules-and-validation), `Cache-Control: no-store`, and the [content contract](content-contract.md) rules for posts, comments, media and notices. Writes need a valid session, allowed Origin/Referer and `X-Requested-With: XMLHttpRequest`. Validation order: method → write origin/header → session → strict body/query → field validation → current resource and role checks → serialized write transaction. Missing/revoked/inactive session is `401`; an infrastructure outage is 500/503, never a false denial. Unsupported method returns `405` with exact `Allow` before origin checks.

JSON bodies are strict single objects (unknown/repeated keys, trailing values, wrong types and non-objects are `400 BAD_REQUEST`; wrong content type `415`; over 16 KiB `413`). Action routes (`join-requests` POST, membership DELETE) take no body; a body is `400 BAD_REQUEST`. IDs are positive decimals within `9007199254740991`; malformed IDs are `400`. Unknown/repeated query keys fail `400`. Missing/blank required fields use `400 VALIDATION_ERROR` with `fields.<name>`: `REQUIRED`, `TOO_LONG`, `INVALID_TEXT`, `INVALID_ID`, `INVALID_CHOICE`, `GROUP_SCOPE`, `IMMUTABLE`.

New error codes, each with the exact message pinned by the fixtures:

| Status / code | Meaning |
|---|---|
| `409 STALE_INVITATION` | Invitation ID is absent, cancelled, refused, accepted, or superseded. Never retried automatically. |
| `409 STALE_JOIN_REQUEST` | Request ID absent or resolved. |
| `409 STALE_MEMBERSHIP` | Membership ID absent (already left/removed, or replaced after return). |
| `409 ALREADY_MEMBER` | Invitee/requester is already a current member. |
| `409 CREATOR_CANNOT_LEAVE` | The creator tries to leave; the creator also cannot be removed. |
| `400 SELF_INVITE` | `fields.user_id = SELF_INVITE`. |

Text: trim surrounding Unicode whitespace; normalize `\r\n` to `\n`; titles reject every control character; descriptions allow newline/tab. Title and description are required and nonempty (`REQUIRED`). Duplicate titles are allowed. Creating a group is not idempotent: a lost response is refetched through `GET /groups?membership=member`, never replayed.

## Reads

| Method/path | Result and access | Delivery owner |
|---|---|---|
| `GET /groups` | Pagination; optional `q` (literal case-insensitive title substring, same text rules as People `q`) and `membership=all|member` (default all). All active-creator groups, newest `(created_at,id)` first; Group entries. | B18 / A15 |
| `GET /groups/{id}` | Group for any signed-in user; unknown ID 404. | B18 / A15 |
| `GET /groups/{id}/members` | Members and creator only (others 404); pagination; People entries plus `membership:{id,role,joined_at}`, ordered by normalized display name then user ID; inactive accounts excluded. | B18 / A15 |
| `GET /groups/{id}/join-requests` | Creator only (everyone else 404); pending requests newest first. JoinRequest items. | B18 / A15 |
| `GET /users/me/group-invitations` | Caller's pending invitations newest first. Register before the generic `/users/{id}` handler. | B18 / A15 |

**Group** is `{id, title, description, created_at, creator:{id,display_name}, viewer, [member_count]}`. `creator` never contains avatar, access or private fields. `viewer` is `{role, membership_id, invitations, join_request}`: `role` is `creator`, `member` or `none`; `membership_id` is null for `none`; `invitations` is the caller's own pending invitations `[{id,created_at,inviter:{id,display_name}}]` oldest first; `join_request` is `{id,created_at}` or null. Members always have empty `invitations` and null `join_request`, because admission resolves them. `member_count` (active members) is present only when `role` is not `none`.

```json
{"data":{"id":301,"title":"Chess Club","description":"Weekly games and tactics.","created_at":"2026-10-08T12:00:00Z","creator":{"id":42,"display_name":"Alex Example"},"viewer":{"role":"none","membership_id":null,"invitations":[],"join_request":null}}}
```

**Membership** is `{id, group_id, user_id, role, joined_at}`. **Invitation** is `{id, created_at, group:{id,title,description,creator}, inviter, invitee}`; **JoinRequest** is `{id, created_at, group, requester}`. Participants are B10 People entries projected for the viewer, so a private inviter appears name-only to a stranger.

```json
{"data":{"id":602,"created_at":"2026-10-09T12:00:00Z","group":{"id":301,"title":"Chess Club","description":"Weekly games and tactics.","creator":{"id":42,"display_name":"Alex Example"}},"inviter":{"id":7,"display_name":"Ada Lovelace","access":"full","relationship":{"state":"self","follow_id":null},"avatar_url":null},"invitee":{"id":99,"display_name":"Robin Example","access":"full","relationship":{"state":"none","follow_id":null},"avatar_url":null}}}
```

## Mutations, identities and stale actions

| Method/path | Input | Success |
|---|---|---|
| `POST /groups` | `{title, description}`; any signed-in user. | 201 Group with `viewer.role:"creator"`; one group, one creator membership. |
| `POST /groups/{id}/invitations` | `{user_id}`; caller is a current member (creator included); target is an active nonmember. | 201 Invitation (new ID, invitee notice). Same inviter→invitee pending: 200 same ID, no notice. |
| `PATCH /group-invitations/{id}` | `{decision:"accept"|"refuse"}`; invitee only. | accept: 200 Membership; refuse: 204. |
| `POST /groups/{id}/join-requests` | Empty body; caller is a signed-in nonmember. | 201 JoinRequest (creator notice). Existing pending: 200 same ID. |
| `PATCH /group-join-requests/{id}` | `{decision:"accept"|"refuse"}`; creator only. | accept: 200 Membership; refuse: 204. |
| `DELETE /group-memberships/{id}` | Empty body; own row (leave) or, for the creator, another member's row (removal). | 204. |

Errors by order: bad shape → 400; unknown group, nonmember inviter, inactive/unknown target, wrong participant → `404 NOT_FOUND` with no body detail; target already a member → `409 ALREADY_MEMBER`; absent/resolved entry → the matching `409 STALE_*`. Roles never leak through error fields. A wrong participant acting on a current entry is 404; the same actor on an absent ID is 409 (the B10 convention). The creator's authority is scoped to that group's membership rows only.

Every admission and departure path names its decision-maker and commits all effects atomically with its notice changes:

| Path | Decision-maker | Atomic effects |
|---|---|---|
| Accept invitation | Invitee | Insert one membership; delete **all** the invitee's pending invitations and join request for that group; notice → `accepted` for the winner, `superseded` for the others, all read. |
| Accept join request | Creator | Insert one membership for the requester; delete the request and the requester's pending invitations; request notice `accepted`, invitation notices `superseded`. |
| Refuse invitation / request | Invitee / creator | Delete only that entry; notice `refused` and read; other entries stay pending. Refusal is not a ban: a new request or invitation is allowed. |
| Leave | Ordinary member | Delete the membership; delete that member's pending invitations as inviter (notices `cancelled`); retain posts, comments, drafts, reactions and media records. |
| Remove | Creator | Same effects as leave for the removed member. Removal is not a ban. |
| Creator departure | Nobody | Always `CREATOR_CANNOT_LEAVE`; ownership transfer and group deletion are not part of this scope. |

A resolved or cancelled invitation can never become valid again, even if its inviter returns: its row is gone and a fresh invitation is a new ID. Return after removal needs a fresh request (creator decision) or a fresh invitation (any current member), never creator-only permission and never an old identity. Repeating an old accept, refuse or removal after any of these is stale.

Serialized outcomes (the fixture `races` replay both orders against a reference model):

| Race | Outcomes |
|---|---|
| accept vs refuse the same invitation; leave vs remove | First committer wins; the second is `409 STALE_*`. |
| accept invitation vs inviter leaves | Leave first → invitation cancelled, accept is `409 STALE_INVITATION`. Accept first → invitee stays a member after the inviter leaves. |
| two invitations, or invitation vs request, for one person | One membership; the other path is `409 STALE_*`. Never two memberships. |
| duplicate invitation/request creation | One `201`, one `200` with the same ID; one notice. |
| removal vs member post/comment/reaction/invite | Write committed before removal stays stored; a write after removal is `404` and commits nothing. Invitations created just before removal are cancelled by it. |

## Notices and actions

Extend the [B10 notice shape](profiles-contract.md#durable-notifications-and-read-actions) with two types. The actor is a People entry projected for the recipient.

| Type | Recipient / actor | Target and actions |
|---|---|---|
| `group_invitation` | Invitee / inviter | `{kind:"group_invitation", invitation_id, group:{id,title}, state}`; `pending` → `actions:["accept","refuse"]` |
| `group_join_request` | Creator / requester | `{kind:"group_join_request", request_id, group:{id,title}, state}`; `pending` → `actions:["accept","refuse"]` |

States: invitations `pending|accepted|refused|cancelled|superseded`; requests `pending|accepted|refused|superseded`. Only a pending notice has actions; resolved notices are read and have `actions:[]`. Marking one read never resolves it. One notice exists per `(recipient, type, entry ID)` and is inserted in the transaction that creates the entry; a duplicate entry creates none. Actions address the exact entry ID (`PATCH /group-invitations/{id}` or `/group-join-requests/{id}`) and recheck the decision-maker; another user's notice or ID cannot authorize admission. Group invitation/request notices belong to the recipient and are always listable, including after membership loss; they reveal only public group metadata. No notice is added for accept/refuse/removal results.

Content notices (`post_like`, `comment`, …) for group posts and comments require the recipient's **current** membership at list, count, unread, read-one, read-all and excerpt time, and no new notice is inserted for a recipient who is not currently a member. Hidden rows keep their stored read state while the group object exists; read-all skips them.

## Group content extension

Group content reuses the Phase 3 contracts unchanged except for these additions (B19 implements):

- Post and Draft gain `group: {id,title} | null`. Group posts report `audience:"group"` and omit `selected_follower_ids` for everyone; personal posts keep `group:null`. The comment-activity `post` projection also includes `group`.
- `POST /posts` and `POST /posts/draft` accept optional `group_id` (decimal in multipart). The caller must be a current member (otherwise 404). `audience`/`selected_follower_ids` with a group → `400 VALIDATION_ERROR` `GROUP_SCOPE`. `PATCH`/`PUT` may not send `group_id` (`IMMUTABLE`, also for converting a personal post) nor personal audience fields on group posts. The database keeps an inert stored audience for group posts, never consulted for access.
- `GET /posts` adds optional `group_id` (current members only, else 404). Without it, the home feed contains the viewer's readable personal posts plus published posts of groups the viewer currently belongs to, newest first, with `category_id` and `feed=following` (accepted-outgoing-follow authors) combined by AND; membership is still required for group posts. `GET /posts/{id}/nav` and `GET /posts/draft` accept the same optional `group_id`; `GET /posts/draft` without it returns only personal drafts.
- All post, comment, reaction, media, activity, category, navigation and notice routes use one shared predicate: group posts → current membership of the viewer (drafts additionally require authorship); personal posts → the Phase 3 profile/audience rules. The two never widen each other.

Author edits/deletes of group content additionally require current membership. The creator's removal power adds no edit/delete permission over others' content. Departed authors' stored posts/comments stay visible to remaining members with the author's display name; the departed author loses every read and write path, including their own drafts, activity, media and direct links, and regains them only through fresh admission.

### Access matrix

Published group post, any author profile (including private) or follow relationship:

| Viewer relationship to the group | Detail / thread / media / group feed / home feed / counts |
|---|---|
| Creator or ordinary member | Allow |
| Pending invitee, pending requester, nonmember follower of the author, departed member, outsider | Deny (`404`; group feed `404`; home feed and totals omit it) |
| Departed author (their own post) | Deny |
| Remaining member viewing a departed author's post | Allow |

Draft group post: only its author, and only while currently a member. Other members, the creator, nonmembers and the departed author get 404. Comments inherit the parent post decision. Interactions by the departed (comment, edit, delete, react, post, invite) are `404` and commit nothing; stored contributions and reactions are retained.

Personal-post rules still decide personal posts: shared membership never makes a followers-only or selected post readable. Membership never grants profile access: a private author's group post is readable by a member, but `/users/{id}/profile` stays a teaser and `/users/{id}/posts|comments` stay `404` unless the viewer has full profile access; when they do, only group posts the viewer is a member of appear. Member lists, authorship and attribution show display names with B10 teaser/avatar redaction.

| Surface | Rule |
|---|---|
| `GET /posts/mine`, `/users/activity`, `/posts/liked`, `/posts/disliked` | Own activity includes group contributions only while a member; counts and items filter before paging. |
| `GET /users/{id}/posts|comments` | Full profile access AND the underlying post's current rule. |
| `GET /categories/view`, categories, navigation, totals | Filtered before aggregation; no hidden title, body, image, excerpt or count. |
| `GET /media/{id}`, `/static/uploads/…` | Parent post/comment predicate on every request; aliases and guessed IDs stay 404; bytes of departed authors stay stored. |

## Signals and invalidation

Frames carry no payload and keep the [B10/B14 socket contract](profiles-contract.md#socket-signals-and-invalidation). After commit only:

- New invitation/request: `notification.new` to the notice recipient; `social.invalidate` to the actor and recipient.
- Admission, refusal, leave or removal: `social.invalidate` to the union of users named by the changed memberships, entries and notices, plus every active member after the commit when a membership row was inserted or deleted (so member lists, feeds and permissions refresh).
- Group creation and group-content changes: the existing all-authenticated `social.invalidate`. Notice reads: the recipient. Exact no-ops, duplicates, denials and rollbacks send nothing.

Clients discard protected group lists, members, posts, comments and notices on signal, connect, reconnect and focus; keep the 60-second visible-screen fallback; coalesce superseded responses; and show no stale membership success. `401` clears session caches and socket; 5xx shows an unavailable state, not logout. Already downloaded content cannot be retracted. Message frames and Phase 5 behavior are unchanged.

## Fixture handoff and verification

The [fixture pack](fixtures/phase-4-contract.json) defines synthetic actors (creator 42, member 7 with a private profile, invitee 8, requester 9, nonmember follower 10, departed author 11, departed member 12, outsider 99), reset state, exact request/response bodies, headers, notice states, expected state subsets and signals. Every case resets independently; sequences and races state their own prerequisites. It contains an eight-role × four-post access matrix across detail, thread, media, group feed and home feed, the complete stale/duplicate/denial catalogue, five multi-step journeys (obsolete invitation after inviter return, removal then return by request, return by member invitation, refusal is not a ban, creator retention), twelve two-order races and four recovery examples. No production handler or seed imports fixtures.

Run `python3 docs/social-network/fixtures/validate-phase-4.py`, fixture Biome, documentation link/anchor/graph/count checks and `git diff --check`. These validate the contract and fixtures with an independent access oracle and state machine, not running API, migration, browser or socket behavior. Owner approval (recorded 2026-10-09) and these checks unlock B18 and A15; B19, A16 and A17 retain their own direct prerequisites.

## Draft verification record — 2026-10-09

Working tree on `asmyrogl/B17` based on main `e331ca0` (A14 complete):

- `python3 docs/social-network/fixtures/validate-phase-4.py` — passed: **389** HTTP cases with exact schema/redaction/error/signal/pagination checks; 68 state-machine cases replayed through an independent reference model (statuses, error codes, resulting state, notice states, signal recipients); the full **8 roles × 4 posts** access matrix across detail, thread, media, group feed and home feed against an independent policy oracle; five multi-step journeys (23 mutating steps); **12** two-order races; four recovery examples; local links/anchors, parsed JSON examples and the **36**-ticket dependency/reverse-edge/status graph (**30 complete, 1 in progress, 5 unstarted**).
- Inline corruption probes proved the validator rejects a flipped matrix cell, wrong signal recipients, a leaked `member_count`, a successful stale replay, a denied read returning 200, an altered pinned error message, a contradicted race order, a leaked feed item and an avatar on a teaser entry.
- `python3 docs/social-network/fixtures/validate-phase-3.py` (**246** cases) and `bun x vitest run SPA/tests/unit/docs-consistency.test.js` (**10/10**) still pass; `bun x biome check docs/social-network/fixtures/phase-4-contract.json` and `git diff --check` pass.
- No API, migration, image, browser or socket checks were run; Docker was not touched. These remain B18/B19/A15–A17 gates.

Owner approval was still pending at this draft record; the completion record below supersedes that gate state.

## Owner approval and completion record — 2026-10-09

The owner approved every concrete choice, this contract, the data plan and the fixture handoff with “I approve”. The owner is Dev 1; no second fixture approval is requested. Approval covers the new resource routes, delete-on-resolve request identities with membership-ID generations, the single leave/remove route, idempotent duplicate pairs and stale replays, role-dependent fields, uniform 404 denials, the create-only `group_id` content extension, signal recipients and bounds. It approves the interface and handoff, not future runtime results.

After recording approval, `python3 docs/social-network/fixtures/validate-phase-4.py` passed again (389 HTTP cases, 68 model-replayed cases, the 8 × 4 access matrix, 5 journeys, 12 races, links/anchors and the 36-ticket graph with counts **31 complete, 0 in progress, 5 unstarted**), as did the Phase 3 validator, docs-consistency Vitest, fixture Biome and `git diff --check`. These are documentation/fixture checks only; no application, migration, browser or socket validation is claimed. B17 is complete; B18 and A15 are eligible to start.
