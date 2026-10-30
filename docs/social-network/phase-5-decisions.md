# Phase 5 — Events and Messaging: Analysis and Proposed Decisions

**Current status:** owner approved the complete B20 package on 2026-10-18; see [approval record](#owner-approval--2026-10-18). Proposed/pending statements below preserve the earlier analysis history.

Recorded on 2026-10-11 at the request to analyze and ticket Phase 5. This extends the [Phase 4 decisions](phase-4-decisions.md) for [events and messaging](roadmap.md#phase-5-boundary-and-exit). Unlike Phases 2–4, **no product choice below has owner approval**: the earlier DM questions were never answered, and the owner interview did not cover events or group chat. Every row marked *Proposed* is a recommendation that [SN-B20](track-b.md#sn-b20--publish-event-and-messaging-contracts) must put to the owner in its single approval gate. Tickets, not this record, carry the work; status lives in the [tracker](ticket-tracker.md).

## What the assignment requires

| Source | Requirement |
|---|---|
| [Groups](requirements.md#groups) | Any group member creates an event with title, description and day/time. Every member chooses an option; at least Going and Not going. |
| [Chat](requirements.md#chat) | Private messages need a follow relationship in at least one direction. The recipient receives a message instantly over WebSockets if they follow the sender or have a public profile. Users can send emojis. Each group has a common chat room for its members. |
| [Notifications](requirements.md#notifications) | Group members are notified when an event is created. Notifications must be visible on every page and look different from new private messages. |
| [App](requirements.md#app) | WebSockets handle real-time connections for private chat. |

## Current state (code inspection, not fresh runtime verification)

| Finding | Evidence | Consequence |
|---|---|---|
| No event or group-chat code exists anywhere. | No event tables in `internal/db/migrations/sqlite/`; `/api/v1` has no event or group-chat route. | New tables, routes and Vue views. Migrations continue after 000007. |
| Social DMs check no follow relationship. Any two active accounts can message while the recipient is online. | `socialCreateMessage` in [social_chats.go](../../internal/db/social_chats.go) verifies only that both users are active. | This is a privacy gap against the supplied rule, not a feature to preserve. Fix it before the chat UI ships. |
| Sending is online-only and the roster lists every active user. | `handleDMSend` rejects `RECIPIENT_OFFLINE` ([ws.go](../../internal/handlers/ws.go)); `GetChatRoster` ([messages.go](../../internal/db/messages.go)) selects all active users. | Both are forum behavior, not requirements. The approved offline and roster treatment is an open decision. |
| Unread state exists only in the browser. | `moveToTopForMessage` in [chat.roster.logic.js](https://github.com/alexsmyr0/social-network/blob/cc5161c/SPA/features/chat/chat.roster.logic.js) keeps a client tally; no server read state exists. | Unread counts reset on reload, which is incompatible with offline sending. |
| DM images are readable by sender or recipient indefinitely. | Media check in [media.go](../../internal/db/media.go); staged DM uploads have no expiry. | Access after relationship loss is an open decision. |
| The shared socket accepts only `dm.send`. Presence is broadcast to every connection and filtered per viewer at write time. | `readPump` and `writeSessionMessage` in [ws.go](../../internal/handlers/ws.go). | Reuse the write-time recheck pattern for message and group-chat frames. |
| The `notifications` type CHECK lists only post, follow and group types. | Migration 000006 rebuilt the table for group types. | An event notice needs another data-preserving rebuild. |
| The Vue app has no chat or event view. The vanilla [chat feature](https://github.com/alexsmyr0/social-network/tree/cc5161c/SPA/features/chat/) is a migration source. | `SPA/src/app/router.js`. | Presence, roster, history, unread and DM image behavior move into Vue in SN-A19. |

## Proposed decisions (all pending owner approval)

| Topic | Proposed behavior | Alternative and trade-off |
|---|---|---|
| Who may message | Sending requires an accepted follow in either direction, checked on every send. A pending request does not qualify. | Mutual-only is stricter but contradicts the source wording. |
| Instant delivery | A permitted message is always stored. Amended 2026-10-29, pending owner approval: a live frame goes to every online recipient of a permitted message; offline recipients see it, with an unread count, on their next fetch or reconnect. | Originally approved: push live only if the recipient follows the sender or has a public profile. The audit's realtime check does not fix who follows whom, so a withheld frame could read as a failure. |
| Offline sending | Allowed. The message is stored and shown on reconnect. The `RECIPIENT_OFFLINE` rejection is removed. | Keeping online-only is simpler but loses messages to disconnected users. |
| After both users unfollow | New sends are rejected. Existing history and attachments stay readable to both participants only, and sending resumes after a follow is restored. | Hiding history on relationship loss would remove a user's own sent record. |
| Roster | Lists existing conversations plus people the viewer may message. It no longer lists every account. Online dots use the existing profile-visibility filter. | Keeping the all-user roster exposes accounts the viewer cannot message. |
| Unread indicators | Server-side read cursor per conversation and per group room. Message badges are separate from the notification badge. | Browser-only counts are lost on reload. |
| Group chat | One persisted room per group, members only. Departed or removed members lose read, send and media access; their stored messages remain for current members. Re-admission restores access to the whole room. | Hiding departed members' messages would contradict the Phase 4 contribution rule. |
| Group chat content | Text and emoji only. Images stay a DM feature. | Adding group images reuses the DM pipeline but expands scope beyond the assignment. |
| Emoji | Unicode emoji inside the message body with an accessible picker. Bounded length is counted in code points. No emoji asset storage. | Image or shortcode emoji need extra storage and parsing. |
| Events | Fixed options Going and Not going. One response per member, changeable. Creator and title/description/time are immutable in this phase. | Edit, cancel and a Maybe option are extra scope. |
| Event visibility | Members only, including responses. Counts and lists reflect current members. A departed member's stored response is not shown. | Counting departed responses leaks membership history. |
| Event notices | Persisted in the creation transaction for every current member except the creator. Later joiners get no retroactive notice and see the event in the group. | Retroactive notices flood new members. |
| Realtime | Reuse the single session-owned socket. Add message frames. Membership and relationship changes send a payload-free `social.invalidate`. Every delivery rechecks current permission. No new queue, socket or service. | A separate chat socket duplicates auth and lifecycle code. |

## Ticket ownership

| Area | Backend | Frontend |
|---|---|---|
| Contracts, fixtures, approvals | SN-B20 | Consumed by SN-A18 and SN-A19 |
| Group events and event notices | SN-B21 | SN-A18 |
| Private messages under relationship rules | SN-B22 | SN-A19 |
| Group chat and shared realtime delivery | SN-B23 | SN-A20 |
| Real-service acceptance | Harness support from B | SN-A21 |

DM image preservation and presence belong to SN-B22 and SN-A19. Deleting any existing chat capability remains unauthorized.

## Questions the owner still has to answer

1. Approve or change every *Proposed* row above in SN-B20's single gate.
2. Event times: store an absolute instant and display it in each viewer's local zone (recommended), or store a creator-local wall time.
3. Message size: the recommended bound is 2000 code points per message, with image size limits reused from DMs.
4. Whether blocked, muted or reported conversations are wanted. None is proposed.

Phase 6 stays roadmap-only. Writing these tickets does not authorize implementation before the preceding SN-A17 acceptance gate.

## B20 concrete approval package — 2026-10-15

The owner reported A17 completed and explicitly instructed B20 to proceed on 2026-10-15. Fetching origin still resolved to `08aea11`, whose published record contained the earlier upgrade-evidence gap. The [tracker](ticket-tracker.md) records the explicit owner completion report; B20 does not manufacture commit/test evidence or rewrite A17's historical results.

Prepared [events/chat contract](events-chat-contract.md), [data mappings](phase-5-data-plan.md), [fixture pack](fixtures/phase-5-contract.json) and [independent artifact validator](fixtures/validate-phase-5.py) on `asmyrogl/B20`. **All thirteen product rows above remain proposed.** Recommended answers to the remaining questions: absolute UTC instants displayed locally, 2000 code points per message, no blocking/muting/reporting. No event edit/cancel, additional options, group images, new service or socket.

The concrete choices/alternatives in the contract include UUID send deduplication across HTTP/socket/restart, monotonic persisted unread cursors, read bootstrap, event response versions and membership generations, private history/media retention and non-live recipient recovery. They also propose correcting the migration dependency to B21 → B22 so schema 9 cannot ship without schema 8. The current ticket graph is unchanged until that proposal is approved, then its reverse edges and audit are updated together.

One owner approval covers every product row, these concrete choices, the data plan and the fixtures. Approval is **pending**, not inferred from the instruction to start B20 or the A17 completion report. No second Dev 1 fixture approval will be requested. Artifact checks are documented in the [contract verification record](events-chat-contract.md#approval-and-verification-record); no runtime validation is claimed.

## Owner approval record — 2026-10-17

The owner reported SN-B20 merged ([PR #38](https://github.com/alexsmyr0/social-network/pull/38), `8bb01e5`) and told Track A to start SN-A18. This is recorded as the single owner approval of every proposed row, the concrete choices, the data plan and the fixture handoff as merged; consumers may start. The earlier DM-delivery, offline and history proposals are therefore approved in the form the [contract](events-chat-contract.md) pins. No second Dev 1 review is requested. At that checkpoint the pack's `review_status` and validator were unchanged. B21 synchronized them with the explicit confirmation on 2026-10-18 below.

## Owner approval — 2026-10-18

The owner explicitly approved the full B20 handoff: every thirteen-row product proposal, all concrete contract interfaces, UTC event instants, 2000-code-point messages, no blocking/muting/reporting, data mappings and fixtures, including B21 → B22 migration ordering. Earlier pending/proposed statements describe the historical preparation checkpoint; this approval supersedes them. B21 implementation is authorized; no second Dev 1 fixture gate applies.
