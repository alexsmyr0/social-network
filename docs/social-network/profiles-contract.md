# Profiles, Following and Notifications — SN-B10

Prepared on 2026-10-02 from `408d1bc` on `asmyrogl/B10`. **Owner-approved contract and fixture handoff; B10 verification gate satisfied.** The [approved Phase 2–3 policies](phase-2-3-decisions.md) remain settled. This document defines approved concrete interfaces; runtime implementation belongs to its consumer tickets. Status lives in the [tracker](ticket-tracker.md). The [data plan](phase-2-data-plan.md) assigns migrations and inherited-route protection. [Machine-readable examples](fixtures/phase-2-contract.json) support independent A09/A10 fixtures.

## Scope and approved choices

SN-B10 publishes contracts only. SN-B11 implements profiles/follows, SN-B12 notifications/realtime, and SN-B13 retained content/media protection. SN-A09/A10 consume approved fixtures; SN-A11 exercises real services. The owner confirmed A07's Dev 2 review passed on 2026-10-02; the [acceptance record](phase-1-acceptance.md#dev-2-review-confirmation) unlocks this contract work.

On 2026-10-02, after a plain-language explanation of both proposed choice sets, the owner approved them in chat with “I agree with all implement”. Approval covers the HTTP choices and notification/media handoff: separate social profile routes, page/per_page lists, display-name substring search, fresh follow IDs and stale-action errors, version-checked privacy writes, resolved request history, authorized notification/badge filtering, payload-free socket signals, privacy-switch invalidation and shared image limits. The owner is Dev 1. On 2026-10-02 the owner removed the separate Dev 1 fixture-confirmation rule: this approval covers the contract and fixture handoff once, with fixture completeness/consistency checked by the ticket.

| Approved choice | Reason | Alternative / tradeoff |
|---|---|---|
| Keep `/users/{id}/profile`, add `/users` discovery and `/follows` mutations | Separate social profile from unchanged Phase 1 Account; explicit relationship resource | Nest every mutation below `/users/{id}`; equivalent policy, different client routes |
| Existing `page`/`per_page` envelope; display-name substring search | Matches retained pagination; simple People search | Cursor pagination avoids shifting pages under concurrent changes, but introduces another API convention |
| Never-reused follow IDs; removed IDs return `409 STALE_FOLLOW` | Old request cannot accept/cancel/unfollow a later relationship | Retaining terminal relationships permits successful repeated deletes but complicates the approved two-state table |
| Privacy writes include `expected_version` | Delayed privacy write cannot silently override another tab's choice | Last write wins requires less client state but can unexpectedly auto-accept new requests |
| Keep resolved follow-request notices as read history; content notices filtered when inaccessible | Preserves notices/read state; no obsolete action or hidden-content badge | Delete resolved requests instead; loses their visible history |
| Preserve empty `notification.new`; add empty `social.invalidate` | Existing socket compatibility; no protected object data in signals | Targeted object payloads save refetches but require additional disclosure checks |

## Common rules and validation

All HTTP paths below use `/api/v1`. Reuse the [auth contract](auth-contract.md#common-http-contract), cookie session, exact configured frontend Origin and `X-Requested-With: XMLHttpRequest` on writes. Reads require authentication. HTTP/media success and errors use `Cache-Control: no-store`; image success includes verified content type and `nosniff`. JSON success is `{ "data": ... }`, optionally `meta`; failure uses `error.code/message/fields`. No internal username, compatibility age/gender, password/hash, token, filesystem key/path or SQL error is serialized.

The complete code set is inherited `UNAUTHORIZED`, `ORIGIN_FORBIDDEN`, `CSRF_CHECK_FAILED`, `BAD_REQUEST`, `VALIDATION_ERROR`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`, plus `SELF_FOLLOW`, `STALE_FOLLOW` and `STALE_PROFILE` below. Retained content upload validation adds `INVALID_IMAGE` in B13; avatar errors remain `INVALID_AVATAR`.

JSON write bodies have the existing 16 KiB limit and strict single-object, valid UTF-8, no unknown/repeated keys or trailing value rules. POST and JSON PATCH actions require `application/json`; DELETE and notification read actions require an empty body without requiring Content-Type. Numeric IDs are positive decimal integers no greater than `9007199254740991` (JavaScript's exact integer limit); signs, exponent notation, whitespace and overflow fail `400 BAD_REQUEST`. Unknown/repeated query parameters fail `400 BAD_REQUEST` on these new/extended routes. Unsupported method is `405 METHOD_NOT_ALLOWED` with `Allow`.

Validation order: method → write Origin/header → session → body/query structure → field validation → resource/participant/privacy checks → transaction. Missing/revoked session is `401 UNAUTHORIZED`; lookup failure is 500/503, never a false logout. Missing/inactive user, forbidden list/avatar and nonparticipant follow/notice access are `404 NOT_FOUND`. A private profile itself returns its permitted teaser with 200. A hidden object must not leak through error fields or counts.

Lists accept `page` (default 1, range 1–1000000) and `per_page` (default 20, range 1–50); invalid values are rejected rather than clamped. Success uses `meta.pagination = {page, per_page, total, total_pages}`. Empty lists have `total: 0`, `total_pages: 0`, `data: []` (notifications use `data.notifications: []`). An out-of-range page returns empty items and current totals. Authorization filters precede counts and LIMIT/OFFSET. Items and totals come from one read snapshot. Separate requests do not promise a stable snapshot; clients reset to page 1 after changes.

## Profile and discovery reads

| Method / path | Inputs | Success and access |
|---|---|---|
| `GET /users` | Optional `q`, pagination | 200 array of People entries; active accounts including self; sort normalized display name ascending, then ID ascending |
| `GET /users/{id}/profile` | None | 200 full Profile for owner/public/accepted follower; otherwise name-only teaser |
| `GET /users/{id}/followers` | Pagination | 200 accepted followers only; same access as full profile |
| `GET /users/{id}/following` | Pagination | 200 accepted outgoing follows only; same access as full profile |
| `GET /users/{id}/avatar` | None | 200 bytes only for permitted full-profile viewers and existing avatar; otherwise 404 |
| `GET /users/me/follow-requests` | Pagination | 200 current incoming pending requests only; newest `(created_at, id)` first |
| `PATCH /users/me/privacy` | `{"visibility":"private","expected_version":1}` | 200 owner Profile with committed visibility/version; stale version 409 |

`q` trims Unicode surrounding whitespace, permits at most 100 Unicode code points, and rejects control characters with `400 VALIDATION_ERROR`, `fields.q = INVALID_TEXT` or `TOO_LONG`. Empty/omitted `q` means browse all. Match a literal substring of Unicode-lowercased display name; `%`, `_`, apostrophes and backslashes are ordinary search characters, not SQL patterns. No accent folding or fuzzy search is promised. Search only nickname when present, otherwise `first_name + " " + last_name`; email, DOB and internal username are never searchable. Return display name without lowercasing its presentation.

Every People entry contains `id`, `display_name`, `access` (`full` or `teaser`), and `relationship`. Full entries additionally contain `avatar_url` (nullable); teaser entries omit it entirely. Directory entries never contain email/DOB/about-me. Followers/following lists use identical People entries and ascending normalized display-name/ID order. Access to the list owner does not grant full access to each listed person: private list members still use teasers. Accepted active relationships count toward the authorized owner's `followers_count`/`following_count`; pending requests never count. List membership is visible to permitted viewers even if a member's own profile is private, but that member's details remain redacted.

Profile example, viewer 7 following private user 42:

```json
{
  "data": {
    "id": 42,
    "display_name": "Alex Example",
    "access": "full",
    "relationship": {"state": "accepted", "follow_id": 201},
    "profile": {
      "email": "alex@example.com",
      "first_name": "Alex",
      "last_name": "Example",
      "date_of_birth": "1998-03-14",
      "nickname": null,
      "about_me": null,
      "avatar_url": "/api/v1/users/42/avatar",
      "visibility": "private",
      "followers_count": 1,
      "following_count": 0
    }
  }
}
```

The same private user viewed by a pending requester:

```json
{
  "data": {
    "id": 42,
    "display_name": "Alex Example",
    "access": "teaser",
    "relationship": {"state": "pending", "follow_id": 201}
  }
}
```

Teasers contain exactly those four top-level keys: numeric routing identity plus display name and controls; no `profile`, avatar, visibility, lists, counts, registration fields or activity. `relationship` describes **viewer → displayed user**, never the reverse: `self`/`none` use `follow_id: null`; `pending`/`accepted` use the current ID. Only owner Profile includes `profile.version` (initially 1). Full non-owner profiles omit it. Nullable Phase 1 fields retain their existing meaning. Account responses from register/login/`/users/me` and the owner-only `/users/{id}` compatibility read keep their Phase 1 shape; the social endpoint is separate.

Pending request items are `{id, created_at, requester}`; `id` is follow ID, requester is a People entry projected for the recipient. A private requester can therefore appear without an avatar or details. Accepted incoming requests disappear from this list. Profile posts/comments are a Phase 3 addition; there is no placeholder activity payload or general profile editor here.

Privacy accepts only `public`/`private` and an integer `expected_version >= 1` within the ID limit. Missing/invalid values: `400 VALIDATION_ERROR`, field code `REQUIRED`/`INVALID_CHOICE`/`INVALID_VERSION`. Check version before treating equal visibility as a no-op. Same current value/version returns 200 without bumping version; an actual switch increments it once. Version mismatch returns `409 STALE_PROFILE` without applying anything; reload owner Profile before another explicit write.

Public → private retains accepted followers. Private → public changes **all current pending incoming follows to accepted in the same transaction**, retaining IDs and recording acceptance time. Errors/rollback leave visibility, version, relationships and notices unchanged. UI must explain automatic acceptance before submitting the approved private → public change.

## Follow state machine and stale actions

One directional pair has at most one row: `pending` or `accepted`. No self-follow. Removing a relationship deletes its row; a later attempt receives a fresh never-reused ID. The number is identity, not authorization.

| Method / path | Request | Success / repeated outcome |
|---|---|---|
| `POST /follows` | `{"user_id":42}` | 201 Follow: immediately accepted if target public, otherwise pending. Same existing pair returns 200 same Follow without creating another notice |
| `DELETE /follows/{id}` | Empty | Sender only: cancel pending or unfollow accepted; 204 empty response. Absent/removed ID is `409 STALE_FOLLOW`; do not touch any replacement row |
| `PATCH /follow-requests/{id}` | `{"decision":"accept"}` or `{"decision":"decline"}` | Recipient only. Accept: 200 accepted Follow retaining ID. Decline: 204, row removed. Accept same already-accepted ID: 200 current Follow. Decline already-accepted ID: `409 STALE_FOLLOW` |

Follow is `{id, follower_id, followed_id, state, created_at, accepted_at}`; timestamps are UTC RFC3339 strings, `accepted_at: null` when pending. Unknown/inactive target is 404. Self POST returns `400 SELF_FOLLOW`, `fields.user_id = SELF_FOLLOW`; missing/nonpositive user ID is `400 VALIDATION_ERROR` with `REQUIRED`/`INVALID_ID`. Bad decision returns `400 VALIDATION_ERROR`, `fields.decision = REQUIRED`/`INVALID_CHOICE`. Current row acted on by the wrong participant returns 404; deleted or nonexistent syntactically valid ID returns the same 409 stale error, disclosing no pair or current ID.

```json
{
  "error": {"code": "STALE_FOLLOW", "message": "Relationship changed; refresh before acting"}
}
```

Errors/retries never act by pair alone. Example: cancel 201, retry explicitly creates 202; accepting/cancelling 201 returns 409 and leaves 202 pending. Repeated decline/delete is stale, not a successful new mutation. On 409 or lost response, refetch profile/incoming requests/notifications; show current state. Never automatically replay an old creation POST after a relationship has ended. Infrastructure failure stays retryable/unavailable without asserting success. Disable duplicate UI submissions.

Concurrent operations serialize their state decisions within write transactions, not a pre-transaction privacy read. Public → private racing creation: either accepted follow commits first and stays accepted, or privacy commits first and request is pending. Private → public racing creation: either pending is auto-accepted, or creation sees public and is accepted. Accept versus cancel: accept first lets sender subsequently unfollow the same accepted ID; cancel first makes acceptance stale. Accept versus decline: first state change wins; later decline of accepted is stale. Unique pair constraint makes simultaneous creation return one 201 and existing-state 200 responses. All affected future selected-post associations are removed on unfollow; B14/B15 add those tables later, with no future-table dependency in Phase 2.

## Durable notifications and read actions

| Method / path | Inputs | Result |
|---|---|---|
| `GET /notifications` | Pagination | 200 `{data:{notifications:[Notice],unread_count:N},meta:{pagination:...}}`; unread total across all currently visible pages, not just current page |
| `PATCH /notifications/{id}/read` | Empty | Recipient and visible notice only; 204, including repeat; missing/foreign/hidden 404 |
| `PATCH /notifications/read-all` | Empty | 204; mark currently visible recipient notices read atomically; no effect on another recipient or hidden stored notices |

Sort newest `(created_at, id)` first. Types retain `post_like`, `post_dislike`, `comment`, `comment_like`, `comment_dislike`; add `follow_request` only. No public-follow or follow-accepted alert is introduced. Notice shape: `id`, `type`, `created_at`, `is_read`, `actor` (People identity projected for recipient), `target`, `actions`. Omit legacy internal `actor_username` and `recipient_id`; clients already know their own recipient. `actor.relationship` is recipient → actor, not the incoming request state.

For follow requests: `target = {kind:"follow_request",follow_id, state}`. State is `pending`, `accepted`, `declined`, `cancelled` or `unfollowed`; resolved states belong to notice history, not extra follow-table states. Only the matching current pending request has `actions:["accept","decline"]`; every resolved target has `actions:[]`. Actor is never expanded beyond current profile access. Store one notice per `(recipient_id, follow_id)`; accept/decline/cancel/unfollow/auto-accept reconcile that notice in the triggering transaction and mark it read. An accepted then removed follow changes history state to `unfollowed`. Cancelled/declined then retried creates a different notice with a different follow ID; old IDs cannot operate the retry. Merely marking a pending notice read does not accept/decline it or remove its controls.

For content: target is `{kind:"post",post_id,title}` for post notices (including inherited `comment` notices with no comment ID), or `{kind:"comment",post_id,comment_id,title,excerpt}` for comment reactions. Titles use currently authorized post title (nullable once B15 allows omission); excerpts are plain text capped at 20 Unicode code points. No new excerpt is fabricated for old `comment` notices: omit excerpt when a specific comment was never stored. Preserve authorized notice/read history and deduplication; do not infer an old event's comment from the latest comment on a post.

Re-evaluate content access on list, total, unread and read-one. Hidden/deleted/draft targets produce no row, count, excerpt, navigation link or unread badge; retain stored hidden read state so restored access can reveal the original state. A private actor on an otherwise authorized public thread is a name-only actor, not a reason to hide the whole thread's notice. Mark-read-all does not clear inaccessible notices. Follow-request history remains recipient-visible after resolution because it records that recipient's own request; it grants no profile/media access.

SN-B12 rebuilds notification target constraints, preserves existing IDs/types/read flags, backfills pending requests created before its migration, and inserts/reconciles notices with relationship state changes. Hook invocation happens only **after successful commit**. Rollback/duplicate creation cannot emit a new-notice frame. Failure to signal after commit does not undo durable state or turn a successful HTTP response into a failure; reconnect recovers by reads.

## Socket signals and invalidation

Keep `/ws`, its Origin/session admission and revocation guarantees. Reuse `{"type":"notification.new"}` with no payload for newly inserted notices, only to the recipient's valid session sockets. Add `{"type":"social.invalidate"}` with no payload for profile/follow/request/read-state changes and content-visibility invalidation. No IDs, email, names, excerpts, counts, relation state or presence are in these frames. No sequence numbers, acknowledgement or replay service.

Send `social.invalidate` after relationship commits to both participants; after notification read writes to that recipient; after privacy commits to owner and affected accepted/pending participants. Because public viewers and inherited feeds can also hold affected content, send the same empty invalidation to all authenticated sockets on actual privacy switches. Do not emit it for a no-op privacy write or rollback. B12 owns signal plumbing; B13 uses it for protected content/media state. Other public viewers may infer a generic app change, never an identity or object from this frame.

On first connection, reconnect, window focus and invalidation, A09/A10 discard affected protected caches and refetch current displayed profiles/lists/request inbox/notifications/unread state; do not keep denied data visible during revalidation. Keep a 60-second fallback refetch while a protected screen is visible, following the retained notification safety net, since signals can drop without disconnect. Coalesce bursts and discard in-flight responses superseded by a newer invalidation. 401 clears protected state/socket; 5xx/network failure shows unavailable state and retry, without claiming logout or retaining stale protected details. Existing DM/message frames remain compatible; B13 redacts identity projections and protects media without deciding Phase 5 chat rules. Message indicators remain separate.

## Fixture handoff and gates

The [JSON fixture pack](fixtures/phase-2-contract.json) contains exact HTTP bodies, status/header expectations, prerequisite state and postconditions. Fixture actors are synthetic, with fixed clock `2026-10-02T12:00:00Z`; they are not production seeds or API handlers. Consumers must model transitions, not return the same success for every request. No fixture is wired into the production app.

| Required cases | Consumers |
|---|---|
| Owner/public/follower full Profile; outsider/pending teaser; nullable fields/fallback names; authorized/denied avatars and lists; private members in authorized list | A09 / B11 |
| Name-only search, literal query characters, limits, pagination, inactive users, absent/revoked session, origin/header denial | A09 / B11 |
| Immediate public follow, private request, duplicate/self-follow, accept/decline/cancel/retry/unfollow, wrong actor, old-ID actions, both privacy switches and races | A09/A10 / B11/B12 |
| Notice history/read-one/read-all, private actor redaction, hidden-content badge filtering, cross-recipient denial, post-commit signals, offline/reconnect/multiple sessions | A10 / B12 |
| Retained feed/detail/discussion/activity/categories/navigation/chat identities and all raw/protected media access; preserved versioned data and recoverable media | B13 / A11 |

Owner approval: **recorded on 2026-10-02** for both choice sets above. Fixture completeness/consistency: **checked**. A07 prerequisite: **complete**, based on the owner's recorded Dev 2 review confirmation. Document/fixture checks are recorded after execution; runtime migrations, API behavior and socket tests remain future consumers' gates.

## Verification record

On 2026-10-02, working tree on `asmyrogl/B10` based on `408d1bc`: local Markdown link/anchor checks, inline JSON parsing, 91 HTTP fixture envelope/redaction/follow-state checks, five signal/recovery examples, five race examples, and tracker totals passed. `bun x vitest run SPA/tests/unit/docs-consistency.test.js` passed 10/10. Fixture formatting was normalized with Biome, then checked; whitespace checks include new artifacts. These are documentation/fixture checks only, not API, migration, browser, image or socket validation. Owner interface approval is recorded above; fixture completeness/consistency checks passed.

Approval finalization on 2026-10-02, working tree based on B10 draft commit `28685a7`: 675 local links/anchors, fixture envelope/redaction/follow-state and tracker checks passed; `bun x biome check docs/social-network/fixtures/phase-2-contract.json`, `git diff --check`, and docs-consistency Vitest 10/10 passed. Owner approval metadata agrees across contract, data plan, fixture pack, context and tracker. The subsequently removed separate Dev 1 confirmation gate is recorded below.

On 2026-10-02 the owner identified themselves as Dev 1 and instructed removal of the duplicate fixture-approval gate across active guidance and future contracts. Existing owner approval plus documentation/fixture checks satisfies B10. No separate Dev 1 review is claimed. The tracker marks B10 complete; B11 and A09 are now eligible to start.

Single-approval policy recheck on 2026-10-02: 677 local links/anchors, 91 HTTP fixtures, tracker totals (18 complete, 0 in progress, 18 unstarted), 36-ticket dependency/reverse-edge checks, fixture Biome and whitespace checks passed; docs-consistency Vitest passed 10/10.
