# Phase 5 integrated acceptance — SN-A21

Implementation on `chbaikas/A21`, based on merged main `c5c5a75` (A18–A20 and B21–B23 included). The [events and messaging contract](events-chat-contract.md), its [fixture pack](fixtures/phase-5-contract.json), the [Phase 5 data plan](phase-5-data-plan.md) and the [Phase 5 decisions](phase-5-decisions.md) control expectations. Status lives in the [tracker](ticket-tracker.md). The local gate passed on the working tree described below. **The hosted gate has not run**: it needs this branch pushed and a pull request, which this record does not claim, so the ticket stays in progress until a hosted `make check` passes.

## Execution boundary

The [A21 journeys](../../SPA/tests/e2e/) use the existing [B07 two-image harness](shared-runtime.md#browser-acceptance-hook) through `playwright.integration.config.ts` (`a21-*.test.js`, shared helpers in [`support/real-service.js`](../../SPA/tests/e2e/support/real-service.js)). Each journey registers unique accounts over real HTTP into disposable SQLite/media storage; independent browser contexts own real session cookies and sockets. No HTTP, group, event, message or notice response is mocked and no socket frame is synthesized; the one place a socket is touched is Playwright's pass-through `routeWebSocket`, which drops real server frames and then closes the connection so recovery is observable. Container recreation refuses any project outside the isolated `sn-b07-test-*` convention. Docker was already running; this work did not start the daemon. No application code, schema or contract changed.

The [upgrade check](../../scripts/test-upgrade.sh) is a second isolated stack. It builds the backend image of the last revision before Phase 5 with `git archive` (`025c849`, migration 000007), seeds earlier-phase data **through that image's own HTTP and WebSocket interfaces**, then recreates both containers from the current images on the same volume and verifies the result. No SQL touches the volume. The seed first proves the image really is the legacy one: Phase 5 routes (`/chats/unread`, `/group-chats`) are not served.

```bash
make test-browser PLAYWRIGHT_ARGS=a21   # 13 real-service journeys
make test-upgrade                       # legacy seed, then current images on the same volume
make check                              # complete local gate; test-images runs both
```

## Coverage

| Gate bullet | Executable evidence |
|---|---|
| Event creation notifies exactly the current members | The creator schedules with the keyboard. Each other member gets exactly one `group_event` notice, the creator, an invitee, a pending requester and an outsider get none; an open member page shows it live and the notice opens the event. A repeated create is a distinct event with new notices; a later joiner gets the events but no retroactive notice. |
| Responses persist and change | Keyboard answer then change (versions 1, 2); another member's answer updates an open page live; a stale version is `409 STALE_EVENT_RESPONSE` even when it repeats the choice, a wrong generation is `409 STALE_MEMBERSHIP`, an invalid choice is `400`; responses write no notice; events are immutable (`405`); past events stay readable and answerable. |
| Outsiders and departed members lose event and chat access at once; stored contributions remain | Invitee, requester and outsider get `404` on every event and room route and see only the members-only message in the browser. Removal clears an open event page and an open room page without reload; hidden event notices and answers leave counts and rosters; readmission restores the same notice (not duplicated), starts a new answer at version 0 and makes the old generation stale. A departed author's events and room messages stay for members. |
| Delivery matrix with real sockets | Public and private recipients, follow in either direction, mutual, a pending request and a stranger. Only accepted pairs send (`404` otherwise, no roster row); a live frame reaches a public recipient or one who follows the sender; a private recipient who does not follow the sender gets the message stored with **no live frame**, then sees it on reload, and gets it live after turning the profile public; presence appears only when profile access exists (`is_online` omitted otherwise). Roster rows carry no profile fields. The pair-by-pair 36-cell replay is [B22's](backend-direct-messages.md); this ticket covers every distinct rule outcome through the browser. |
| Strangers cannot read history or images | Stranger, pending requester and third parties get `404` on history, sends, uploads and committed or staged media through the API and `This conversation isn’t available.` in the UI. After unfollowing, participants keep history and committed image bytes while sending, uploading and the composer are off immediately on an open page (`Read only` in the roster); refollowing restores sending with the same history. A staged image is the uploader's only, bound to one recipient, cannot be claimed twice or redirected. |
| Indicators distinct from notifications, survive reload and restart, clear only on read | Message and notification counters change independently (a pending follow-request notice is unchanged by messages); the cursor is monotonic, rejects invented IDs (`400 INVALID_ID`), never moves back, and later commits stay unread; fetching history does not read, opening a conversation or room does; per-room counts are separate from the DM total. Exact retries return the original (`200`), a changed payload under a nonce is `409 MESSAGE_CONFLICT`, a send without a nonce is refused. |
| Group rooms | Only members read and write; every member session of the sender and recipients gets the frame; the room has no image control; text bounds (2000 code points accepted, 2001 refused); `STALE_MEMBERSHIP` after readmission; the whole history is readable after readmission with the cursor at the latest message (nothing unread); leaving behaves like removal; the creator cannot leave. |
| Offline sending and recovery | A message to an unconnected recipient is stored and shown unread on next sign-in. With the sender's browser offline the send fails with its nonce kept and retries into exactly one message; real server frames dropped and the socket closed are recovered by the reconnect refetch in order and once. A removal frame dropped by the same route leaves the room visible until reconnect, then denies it. |
| Restart and recreation | Both containers recreated with retained data: roster, unread totals, room summaries and cursors, histories, event details and answers, notices, image bytes and denials are identical; sessions stay valid; retry nonces and response versions persist; a page opened before recreation reconnects and receives a live room message. Sign-out afterwards still clears everything. |
| Permissions never widen each other | A shared group opens no private chat or profile; a follow opens no room or event; leaving a group keeps private chats and loses room and events; a profile toggle changes live delivery only. |
| Earlier-phase upgrade | See below. |
| Keyboard, 360px and desktop | Keyboard-only paths: scheduling an event and answering it, writing and sending a private message (with emoji), sending an image, opening the room from the group navigation and writing in it. The event list, detail and form, the Messages page, a conversation with the emoji picker, the group navigation and a room are then checked at 360px and 1280px with long unbroken text and emoji: no horizontal overflow, 44px controls; screenshots (`.tmp/a21-*.png`) were inspected. |
| Preserved features | The full prior integration suite (A07/A11/A14/A17/B07/B13, 37 journeys) runs alongside in the same gate; the earlier DM image, presence and history journeys are re-proved by the messages journeys and the upgrade check. |

## Upgrade through both images

Seeded through the legacy image: six accounts (one with an avatar), a private profile with an accepted follow request, a group with a creator, admitted members, an accepted invitation, a **removed** member, a pending invitation and a pending join request, personal and group posts with images, a comment with an image, a draft, a reaction, legacy direct messages with images (the legacy socket is the only way to send and needs a connected recipient) including a pair with no follow relationship, a staged image that was never sent, a read and an unread notice, and a revoked session.

After the current images run on the same volume the check verifies:

- All 19 earlier-phase reads (records, notices with read flags, groups in every membership state, drafts, feeds, profiles) equal their pre-upgrade bodies; every image's bytes and its access status for every account are unchanged, and the avatar hash is unchanged.
- Live sessions still work; the revoked session is still `401`; a fresh sign-in works.
- Legacy messages keep IDs, bodies, times and images, have `client_id: null` and count zero unread. A pair with a follow still messages; the pair with no relationship is readable by both and read-only, and a third party gets `404`. The never-sent staged image is still its uploader's and can be sent with a nonce.
- Phase 5 works on the old data: membership IDs are preserved; an event notifies exactly the pre-upgrade members (not the removed member, the pending invitee or the pending requester); the room exists and is empty with cursors at the start; the pending invitation and request still resolve, and the newly admitted read the whole room with nothing unread and no old event notice; the removed member stays out.
- Recreating both containers again changes nothing (room, event and legacy-message state are identical).

## Verification record — 2026-10-26

Working tree on `chbaikas/A21`, based on `c5c5a75`, not yet committed when the gate ran.

The first focused runs found only test-expectation defects, all corrected without application changes: a public follow creates no notice (a pending follow request is the unread notice the message-independence check uses); an open room reads what it shows, so the unread assertions leave the room first and the restart snapshot is taken after the room is open; layout accounts need an email-safe name; Vitest picked up `SPA/tests/upgrade` (now excluded in `vitest.config.ts`); and a sanity threshold on the snapshot comparison was one too high (19 reads).

Focused runs passed: `make test-browser PLAYWRIGHT_ARGS=a21` 13/13 (events 1, private messages 5, group chat 3, cross-feature/restart/layouts 4) and `make test-upgrade` seed 1/1 plus verify 1/1.

`make check` passed with **exit 0** in 8m49s on the final tree: Biome, gofmt, vet, Go and race suites, Vitest **2989/2989** (107 files), native Playwright **92/92**, both image builds, backend and media smoke, integration Playwright **50/50** (37 earlier-phase journeys plus 13 A21), stopped-backend outage handling, upgrade seed and verify, and disposable cleanup. No retries. Log: `.tmp/a21-final-check.log`. The 360px and desktop screenshots (`.tmp/a21-*.png`) were inspected.

One earlier full run reported native Playwright 91/92: `a03-shell` "completes registration against a contract fixture on desktop" timed out once on a fixture-only page (no stack, no A21 file). It passed 27/27 in each of three isolated repeat runs, and in the full runs before and after; it is recorded rather than hidden, and the passing run above is the gate result.

Hosted verification: not run. It needs this branch pushed and a pull request; until a hosted `make check` passes, the ticket stays in progress.

## Boundaries and gaps

- **Hosted gate pending.** The ticket's external gate needs a hosted `make check` on a pushed branch. CI uses a shallow checkout; `scripts/test-upgrade.sh` fetches the pinned revision by SHA when it is missing, so no workflow change was made (B owns CI). That fetch path is exercised only on a hosted run.
- One upgrade source: the Phase 4 head (schema 7), which carries data created under Phases 1–4. Older heads (schema 1–6) and migration failure injection are covered by the Go migration suites ([migrations](backend-migrations.md), [content and media](backend-content-media.md#upgrade-and-recovery-handoff), B21–B23 records), not re-run through images here.
- The legacy frontend image is not rebuilt: the frontend stores no data, and the legacy phase uses the current frontend as a proxy in front of the legacy backend.
- Group-chat images, event editing/cancellation and blocking are outside the approved Phase 5 boundary and are asserted absent (no room image control, `405` on event mutation). Phase 6 final delivery is not started and nothing here is Phase 6 evidence.
