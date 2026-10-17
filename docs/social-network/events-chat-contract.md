# Events and Messaging Contract — SN-B20

Prepared 2026-10-15 on `asmyrogl/B20`, based on `08aea11`. **Approval package; owner approval recorded 2026-10-17 below.** The owner reported A17 complete and explicitly instructed proceeding on 2026-10-15. Fetching origin still returned `08aea11` with the earlier open-gap record; that report is the execution authorization, not fresh upgrade evidence. B20 does not alter A17's historical evidence or mark it verified. Status lives in the [tracker](ticket-tracker.md).

This contract, [data plan](phase-5-data-plan.md), [policy alternatives](phase-5-decisions.md#proposed-decisions-all-pending-owner-approval), [fixture pack](fixtures/phase-5-contract.json) and [validator](fixtures/validate-phase-5.py) form **one owner approval package**. B21 implements events; B22 implements DMs; B23 implements group chat. A18–A20 consume the fixtures; A21 owns real-service acceptance. No SQL, API, socket, dependency or Vue changes belong to B20.

## Decisions presented for approval

Every policy row in the [Phase 5 proposals](phase-5-decisions.md#proposed-decisions-all-pending-owner-approval) is retained as proposed, with its alternative. This package recommends all thirteen rows, plus absolute event instants displayed in the viewer's local zone, 2000-code-point messages, and no blocking/muting/reporting workflow. Concrete choices below are proposals too; consumers wait for the single approval.

| Choice | Recommendation | Main alternative / cost |
|---|---|---|
| Transport | Keep `/chats/{user_id}/messages`, `/images`, `dm.send`, `dm.message`; add group routes/frames on the same socket. | Rename all chat APIs: needless adapter churn. |
| Retries | Required UUID `client_id` for message sends, unique per sender and channel kind; exact retry returns same ID, changed payload gets `409 MESSAGE_CONFLICT`. | No deduplication: uncertain delivery may duplicate messages. |
| Response concurrency | Event response `expected_version`; group mutations/read cursors carry current `membership_id`. | Last writer wins can overwrite newer answers or execute a delayed action after readmission. |
| Cursor bootstrap | Existing DMs start read through migration-time latest message. First admission/readmission starts group cursor at room's current latest ID; history remains available. | Mark all historical messages unread: large false backlog. Browser-only legacy unread cannot be recovered. |
| Event responses after rejoining | Stored response belongs to membership generation; departure hides it; fresh admission requires a new choice (version 0). | Restore old answer automatically, potentially misrepresenting new membership. |
| Event time | RFC3339 absolute instant with offset, whole seconds, normalized UTC; past events are readable/respondable, no scheduling service or cutoff. | Creator-local wall time is ambiguous across zones/DST; future-only creation is an extra restriction. |
| Paging | Events, responses, roster and room summaries use existing page envelope; messages retain `before_id`, ascending within each returned page. | New opaque cursors add another convention. |
| Withheld live DMs | No recipient frame or send-triggered recipient invalidation when instant-delivery predicate fails. Focus, 60-second recovery, opening and reconnect fetch stored data. | A recipient-specific unread signal would bypass the intended live-delivery restriction. |
| Migration dependency | After approval, make B22 depend on B21's numbered migration before its runtime gate; frontend events/DMs still proceed independently from fixtures. | Authoring B21/B22 in parallel still works, but numbered migrations cannot be independently delivered out of order. |

## Common transport and validation

HTTP prefix `/api/v1`. Reuse [auth and origin policy](auth-contract.md#session-cookie-and-origin-policy), [B10 envelopes/IDs/paging](profiles-contract.md#common-rules-and-validation), [group resource visibility](groups-contract.md#transport-errors-and-field-rules), and private-media authorization. Responses use `Cache-Control: no-store`. Writes require allowed Origin/Referer, `X-Requested-With: XMLHttpRequest`, valid active session. WebSocket handshake uses existing session/origin enforcement and logout revocation; socket frames have no custom-header requirement. Sender identity always comes from session, never input.

HTTP order: method (405 with exact Allow) → write origin/header → session (401) → strict structure/size/query → fields → resource permission → serialized transaction. JSON must be one strict object: unknown/duplicate keys, trailing data, wrong types, null required objects → 400 BAD_REQUEST; wrong content type → 415; body >16 KiB → 413. Unknown/repeated query keys → 400. IDs are positive safe integers ≤9007199254740991; `expected_version` additionally permits 0. Reject overflow, floats and coercion. All writes recheck permission under `BeginSocialWrite`; reads use one snapshot and filter before totals/paging. Infrastructure failure is 500/503, never a false 404.

New text normalizes CRLF to LF and trims Unicode edge whitespace. Titles: 1–100 code points, no controls. Event descriptions: 1–1000, tab/LF allowed. Message bodies: 0–2000, tab/LF allowed; DM needs body or image, group needs nonblank body. Reject all other Unicode control characters and invalid Unicode. Count Unicode code points (Go runes / JS `Array.from`), not bytes or visual emoji clusters. Unicode emoji, variation selectors, modifiers and ZWJ sequences are ordinary text; accessible picker inserts Unicode, no asset/shortcode parser. Old message bodies are never trimmed, truncated or revalidated on upgrade/read.

`starts_at` requires a valid calendar instant in years 0001–9999, explicit Z or ±HH:MM offset and whole seconds (no fractional seconds); output UTC `YYYY-MM-DDTHH:MM:SSZ`. A local datetime with no zone is `INVALID_TIME`. New client IDs are lowercase canonical UUID v4 strings. 16 KiB socket text-frame limit; malformed/unknown frames → `chat.error INVALID_PAYLOAD`; larger frames close with 1009, no state. Socket errors below use HTTP-equivalent code semantics but no HTTP status.

Error envelope: `{"error":{"code":"NOT_FOUND","message":"Not found"}}`. Validation: `400 VALIDATION_ERROR`, message `Validation failed`, `fields` mapping to `REQUIRED|TOO_LONG|INVALID_TEXT|INVALID_TIME|INVALID_ID|INVALID_CHOICE|INVALID_UUID|CONTENT_REQUIRED`. Auth/origin/body/media errors retain earlier contracts. New pinned errors:

| HTTP / code | Exact message / use |
|---|---|
| 404 NOT_FOUND | `Not found` — resource missing, inactive target, wrong participant or nonmember; no identifying fields. |
| 409 MESSAGE_CONFLICT | `Message retry differs from original` — same sender/client_id with different canonical content, recipient/group or membership generation. |
| 409 STALE_EVENT_RESPONSE | `Event response changed; refresh and retry` — expected response version differs. |
| 409 STALE_MEMBERSHIP | `Membership changed; refresh before acting` — current member supplied an old membership ID. Nonmember is 404 first. |
| 422 INVALID_IMAGE | `Invalid image` — corrupt/mismatched/unsupported image content. |

## Events

Permission: active viewer's **current membership** in a visible group, not follows, personal profile visibility, creator authority or event authorship. Outsider, invitee, requester, departed/removed member and departed event author receive 404 on every event/response route. Group creator has ordinary event rights. A member sees departed creators' events; shared membership never exposes private profile fields or avatars.

| Method/path | Input | Success / effects | Owner |
|---|---|---|---|
| GET `/groups/{id}/events` | `page`, `per_page` | 200 Event array; `(starts_at ASC,id ASC)`, includes past events. | B21/A18 |
| POST `/groups/{id}/events` | `{membership_id,title,description,starts_at}` | 201 Event; insert event and notices atomically. | B21/A18 |
| GET `/groups/{id}/events/{event_id}` | No query | 200 Event, event must belong to path group. | B21/A18 |
| GET `/groups/{id}/events/{event_id}/responses` | `page`, `per_page` | 200 Response array; current active membership generations only; `(user_id ASC)`. | B21/A18 |
| PUT `/groups/{id}/events/{event_id}/response` | `{membership_id,choice,expected_version}` | 200 Event; own response only, choice `going|not_going`; compare version (absent = 0), insert/update and increment by 1. | B21/A18 |

Event exact fields: `{id,group_id,creator:{id,display_name},title,description,starts_at,created_at,options:["going","not_going"],counts:{going,not_going},viewer_response:null|{choice,version}}`. Counts and viewer response use current active membership generation; creator gets no automatic choice. Response: `{user:{id,display_name},choice,version}`; no avatar, email, profile access or membership history. Missing/inactive accounts never receive notices or contribute responses; retained event/message attribution uses `{id,display_name:"Unavailable account"}` for an inactive author. Group visibility otherwise retains B18's active-creator rule.

An old expected version, even repeating the same choice, is 409 with no write. Refresh before deciding again. Events are immutable: no edit/delete/cancel/extra-option routes (405 with allowed methods). Event creation has **no** automatic replay guarantee: an explicit repeat creates a distinct event and distinct notices. On uncertain response, fetch list/detail before offering deliberate retry.

### Event notices and invalidation

New type `group_event`, actor = event creator projected using existing People redaction; target `{kind:"group_event",event_id,group:{id,title}}`, `actions:[]`. Reuse Notice's existing outer fields; there is no invitation state or response action on a notice. Navigate to event detail and fetch it with current membership.

Creation transaction takes current active-member snapshot, inserts one event and one notice for **each member except creator**, unique `(recipient_id,type,event_id)`. No automatic response. Commit before recipient-only empty `notification.new` and empty `social.invalidate` to current group members. Later joiners get list/history, no retroactive notice. Response writes signal empty `social.invalidate` to current members after commit; they create no notices. Failures emit neither success nor signals. Event notices require current membership at list/count/unread/read-one/read-all/excerpt time. Hidden rows retain read state; read-all skips them; readmission restores the same notice, no duplicate. Departed creators' event notices remain useful; inactive actors retain existing notice suppression. Leaving/removal signals include the former member so open protected views clear.

## Private messages

`can_send = active distinct participants AND (accepted sender→recipient OR accepted recipient→sender)`. Pending requests never qualify. `recipient_live = can_send AND recipient_online AND (accepted recipient→sender OR recipient_public)`; sender receives committed echo on all own sessions. Evaluate both predicates again at each queued delivery; a later relationship/privacy change may suppress a queued recipient frame. Presence separately requires B10 profile visibility (recipient public OR viewer follows recipient); private recipient merely following sender does not expose presence. Omit `is_online`, do not report false for hidden presence.

History/attachments remain participant-only after both users unfollow. A messageable pair with no history can fetch empty history and cursor 0; a nonmessageable pair with no history gets 404 and no roster row. Unknown/inactive/self target is 404. Upload requires current can_send; staged bytes readable by uploader only. Send rechecks same uploader/recipient/kind binding inside its transaction; claimed images cannot be stolen or reused in another new message. An exact deduplicated retry may return its already-claimed image. Existing staged DM retention and participant-only committed media stay unchanged; no expiry or group images added.

| Method/path | Input | Success / atomic effects | Owner |
|---|---|---|---|
| GET `/chats` | `page`, `per_page` | 200 Roster array, existing conversations plus messageable active users; history first by latest ID DESC, then no-history users by normalized display name ASC/user ID ASC. | B22/A19 |
| GET `/chats/{user_id}/messages` | optional `before_id`, `limit` 1–50 (default 10) | 200 `{messages:[DM],has_more,next_before_id}`; IDs < exclusive bound, choose newest limit then return ascending; next = first returned ID iff has_more, else null. | B22/A19 |
| POST `/chats/{user_id}/messages` | `{client_id,body,image_url?}` | 201 DM for new message, 200 same DM for exact replay. Same transaction as socket send. | B22/A19 |
| POST `/chats/{user_id}/images` | multipart single `image` file | 200 `{image_url}`; existing private staging. | B22/A19 |
| PUT `/chats/{user_id}/read` | `{through_id}` (0 allowed) | 200 `{through_id,unread_count}`; validate belongs to this pair (0 = no-op), advance monotonically. | B22/A19 |
| GET `/chats/unread` | No query | 200 `{unread_count}` across viewer's active-participant conversations, independent of roster page. Match before generic target routes. | B22/A19 |

Roster fields: `{user_id,username,last_message_at,last_message_preview,last_sender_id,can_send,unread_count,read_through_id,[is_online]}`. Keep inherited `username` field containing display name, never internal username. Last fields null without history; preview first 200 code points of stored body, or `[image]` for image-only. No profile/email/avatar fields. Private history cannot introduce a third party's roster entry, preview, count or media.

DM fields: `{id,sender_id,recipient_id,sender_username,body,created_at,client_id,[image_url]}`; image key omitted when absent, legacy `client_id:null`. An empty input `image_url` is canonicalized to absence before deduplication. Committed body/image data is returned only to participants. New sends return canonical body. No message edit/delete/read-receipt/typing API.

Images reuse validated JPEG/PNG/GIF, ≤5 MiB bytes, dimensions ≤4096 each, GIF ≤100 frames and ≤64,000,000 cumulative canvas pixels, existing total multipart bound 10 MiB. Reject missing/extra files, unknown/repeated parts (400), oversize 413, malformed multipart 400, wrong form content type 415, decoded image mismatch 422. Third-party media and wrong-recipient claims are 404, with no bytes or reassignment. Denied send leaves staged image intact for uploader recovery; committed references/bytes survive sweep/restart.

Unread counts incoming messages with `id > read_through_id`; own sends never count. Fetching history, socket delivery and sending do not mark read. Mark only after visible rendering, using largest rendered ID; cursor never decreases, never accepts another pair's ID or an invented/future ID (400 VALIDATION_ERROR, `through_id:INVALID_ID`). Session-independent cursor persists across tabs and restart; new commits beyond the requested cursor remain unread. Notification read operations and message cursor operations cannot change each other's counts.

## Group rooms

One logical room per existing/new group; no explicit room-creation workflow. Current active membership is required for list, history, sends, cursor and queued delivery. Private author profiles add no extra fields. Leave/removal hides all room data and stops queued frames, even for own messages. Contributions stay stored; fresh admission can read entire room. Old membership IDs cannot mutate the new generation.

| Method/path | Input | Success / effects | Owner |
|---|---|---|---|
| GET `/group-chats` | `page`, `per_page` | 200 Room array for current memberships; `(group_id ASC)`, including empty rooms. | B23/A20 |
| GET `/group-chats/unread` | No query | 200 `{unread_count}` across current rooms only. | B23/A20 |
| GET `/groups/{id}/messages` | same `before_id`, `limit` | 200 `{messages:[GroupMessage],has_more,next_before_id}`; same ordering as DMs. | B23/A20 |
| POST `/groups/{id}/messages` | `{membership_id,client_id,body}` | 201 GroupMessage, exact retry 200; text/emoji only. | B23/A20 |
| PUT `/groups/{id}/messages/read` | `{membership_id,through_id}` | 200 `{through_id,unread_count}`; monotonic within this membership, ID must be in this room (0 no-op). | B23/A20 |

Room: `{group:{id,title},membership_id,last_message:null|GroupMessage,read_through_id,unread_count}`. GroupMessage: `{id,group_id,sender_id,sender_username,body,created_at,client_id}`. No `image_url` accepted or emitted. Each join creates a new membership-scoped cursor at admission-time latest room ID (0 if empty), preserving all history without old backlog. Admission transaction initializes cursor in B23; lazy first fetch must not skip intervening messages. Unread excludes own sends. Current members receive one committed message frame per active session, including sender. No message rows enter notification lists or counters.

## Socket frames, recovery and retries

Existing single session-owned socket, `{type,payload}` envelope. Payloads are strict; `dm.send` adds required client_id; legacy sends without it fail validation rather than creating non-deduplicated messages. This is an intentional Phase 5 interface change for the inactive vanilla client. Preserve DM images, Unicode, roster, history, presence and reconnect capabilities in Vue.

| Direction / type | Payload | Meaning |
|---|---|---|
| client `dm.send` | `{recipient_id,client_id,body,image_url?}` | Same command and outcomes as HTTP send. |
| server `dm.message` | DM | New committed message; sender all sessions, eligible recipient sessions only. |
| client `group.send` | `{group_id,membership_id,client_id,body}` | Same command as group HTTP send. |
| server `group.message` | GroupMessage | Committed room message, current members only. |
| server `chat.ack` | `{kind:"dm"|"group",target_id,client_id,message_id,duplicate}` | Requesting socket only, after commit or exact retry; no rebroadcast on duplicate. |
| server `chat.error` | `{code,message,[client_id],[fields]}` | Requesting socket only; client_id echoed only if syntactically valid. No target/content disclosure. |
| server `chat.read` | `{kind,target_id,through_id,unread_count}` | Cursor change to all viewer's own sessions only; no other participant read receipts. |
| server `social.invalidate` | Omitted | Existing relationship/membership/privacy invalidation; no IDs/excerpts. |
| server `notification.new` | Omitted | Event notice recipients only; no message count or content. |

Fresh send: commit → ack on requesting socket (HTTP uses response instead) → message fanout. Exact retry: permission and generation rechecked first, return original message/ack with duplicate true, no new row/image claim/fanout/unread increment. Reusing nonce with different target/body/image/generation is MESSAGE_CONFLICT; dedupe check for same payload precedes image claiming, but follows current permission. Nonce scoped by sender and kind, not session; HTTP/socket retries share result across restart. Different nonce means deliberate distinct send. Lost ack: refetch history, or retry same payload and nonce while allowed; never mint a new nonce automatically. HTTP sends have no socket ack but do fan out.

Frame buffers remain bounded/nonblocking; no delivery or ack is proof of durable read. Clients merge by `(kind,target_id,message_id)`, sort by ID, and never add unread by counting socket frames. Cross-session fanout ordering need not match commit ordering; recover from authoritative summaries/history. Reconnect/open/focus/60-second safety recovery fetches both summaries, totals, history and current permissions; it must not only fetch `before_id` because that pages older messages. Fetch newest then page backwards until last known ID reached; dedupe. No durable socket queue or replay log. On 401/logout clear all protected resources/blob URLs/cursors/socket and ignore late responses by session generation. On empty invalidation recheck permission, purge denied group/DM composer state and hidden presence, keep accessible participant DM history; stale membership requires refetch, no automatic re-submit.

Delivery authorization must cover queued `dm.message`, `group.message`, `chat.ack`, `chat.read`, errors and presence: valid unrevoked session, own command identity for ack/error, current member/generation for group frames and recipient live predicate for DM message. Invalidation has no private payload. A frame queued before removal but written after it is suppressed; B22/B23 must serialize permission admission with revocation through the actual socket write (not a check followed by an unlocked write). A message committed before revocation stays stored even if its delivery is suppressed. Tests cover both transaction orders and the queued-write gap. Revocation also clears pending client buffers; no automatic replay after readmission.

## Fixture and verification handoff

Run `python3 docs/social-network/fixtures/validate-phase-5.py`. The pack contains concrete HTTP/frame examples, all 36 directed-follow × profile × online DM cells, role/surface group cells, field and paging bounds, explicit expected states for unfollow/refollow, removal/readmission, events/notices, nonce retries, cursor recovery and both race orders. The validator recomputes results with an independent reference model and checks shapes, coverage, links and full ticket graph. Fixtures are test-only; no production import.

B20 validates artifacts only. B21 must exercise migrations/events/notices and races; B22 must replay matrix on actual sockets and retained DM media; B23 must prove session fanout, removal ordering and membership cursors; A18–A20 replay fixtures in Vue. A21 runs real-service multi-user, offline/reconnect, image, permission, upgrade, keyboard/mobile and prior-phase regression journeys through B07 harness. No application, browser, SQL migration or image validation is claimed here.

## Approval and verification record

**Owner approval — 2026-10-17.** The owner reported this package merged ([PR #38](https://github.com/alexsmyr0/social-network/pull/38), `8bb01e5`) and instructed SN-A18 to start. That statement is recorded as the single owner approval of all proposed policy rows, concrete interfaces, data mappings and the fixture handoff as merged; no second Dev 1 review. The fixture pack's `review_status` and the validator are B20's artifacts and were not edited, so they still read "draft". A17's completion report authorized the preparation without inventing missing local/hosted evidence. The proposed B21 → B22 dependency correction is part of this package; applying it to the B tickets and graph remains B-track work.

Artifact verification on 2026-10-15, working tree based on `08aea11`:

- `python3 docs/social-network/fixtures/validate-phase-5.py` passes: **215 HTTP cases**, all **36 DM delivery cells**, **64 group role/surface cells**, **6 sequential journeys**, **8 races in both orders**, **12 write-time delivery cases**, **12 image-bound cases**, **8 socket examples** and additive upgrade/preservation mappings. It checks exact modeled bodies/effects/signals, required coverage/schema fields, all **44 tickets**, summary counts, reverse dependencies/cycles and local links/anchors. The model is artifact consistency evidence, not backend/socket/migration execution.
- Eight independently corrupted packs are rejected: missing DM cell, wrong HTTP result, leaked signal payload, wrong retry identity, changed retained message, schema drift, queued-frame admission after readmission, missing group cell. This confirms the validator can fail; no corrupted pack is retained.
- `bunx biome check docs/social-network/fixtures/phase-5-contract.json`, Python source compilation, changed-document whitespace checks and `bunx vitest run SPA/tests/unit/docs-consistency.test.js` (**10/10**) pass. No full application gate or Docker check is appropriate for this documentation/fixture ticket.

Review recommendations together: all thirteen policy rows; absolute event instants and 2000-code-point text; UUID retries shared by HTTP/socket; retained DM history/media; membership-scoped group/event response generations and read cursors; migration bootstrap and B21 → B22 dependency correction. Alternatives are in the tables above and the policy record. No recommendation is recorded as approved yet.
