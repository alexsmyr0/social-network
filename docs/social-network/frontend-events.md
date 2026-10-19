# Group events — SN-A18

Implemented on `chbaikas/A18`, based on merged main `8bb01e5` (B20 included). The [events and messaging contract](events-chat-contract.md#events), its [fixture pack](fixtures/phase-5-contract.json) and the [Phase 5 decisions](phase-5-decisions.md) control the implementation; the owner reported SN-B20 merged and told A to proceed on 2026-10-17. Status lives in the [tracker](ticket-tracker.md). This ticket verifies the Vue frontend with fixtures. Real persistence, authorization and delivery belong to SN-A21; event storage and notices are [SN-B21](track-b.md#sn-b21--implement-group-events-responses-and-event-notices). Private messages and group chat are SN-A19/SN-A20.

## Delivered behavior

**Events** (`/groups/:id/events`) are a section of the group view, offered and requested only after the server-reported role is creator or member. The list is paginated in the server's order (start time, then ID) and includes past events, which stay readable and answerable. Each card shows the start in the viewer's own time zone, a "Past" badge, the creator's name, the counts and the viewer's own answer ("You: Going" or "No answer yet"). Nonmembers, invitees, requesters and departed members see "Only members can see group events." and no event request is made.

**Detail** (`/groups/:id/events/:eventId`) shows the title, start, creator, description and counts, the answer control and the answers list. The route asks the group first. The event is requested only while the server confirms membership, and it must belong to the group in the path; any other answer is the same "This event isn't available." state.

**Answers.** Going and Not going are toggle buttons that show the viewer's current choice and the count for each option. A write sends the viewer's current `membership_id` and the `expected_version` of the answer the page showed (0 when there was none). Choosing the selected option again is not a write. One write is in flight per event, the result is worded as saved only after a confirmed success, and the page then re-reads the event. A stale version, a stale membership generation, a lost response and a removed membership each get their own plain message and a refetch; nothing is retried. The answers list shows names and choices only, never an avatar, profile field or membership history, and a returning member starts with no answer.

**Scheduling** (`/groups/:id/events/new`) validates title (1–100 code points, no control characters), description (1–1000, newline and tab allowed) and the start as the contract does before anything is sent, then moves focus to the first problem. The start is a `datetime-local` wall time read in the viewer's zone and sent as a whole-second UTC instant. A wall time the zone skips at a clock change is refused rather than silently moved. Creation is not idempotent, so a lost response is never resent: the draft stays, focus returns to the message, and scheduling stays blocked until a successful event-list or detail read reconciles the result. The block survives leaving and reopening the form; failed reads do not unlock it. A link to the event list lets the member check before deliberately trying again. A server `VALIDATION_ERROR` is mapped back to the fields. On success the creator lands on the new event with a notice, provided the original route, account and membership are still current. A completion after navigation has no redirect or confirmation effect.

**Notices.** `group_event` notices appear in the existing global panel as "Scheduled an event" with "See the event in {group}" linking to the event. They carry no actions and no event text, so nothing protected can leak through an excerpt. They are read through the existing read controls. The server hides notices for a group the recipient no longer belongs to and restores the same notice after fresh admission; the panel follows through the normal signal lifecycle.

## Membership loss and protected state

Every event read uses `useSocialResource`. A signal, reconnect, focus, route or account change refetches, and a failed, missing or denied read discards the event at once, so a removed member's open page never keeps showing it. Switching accounts discards event, list and answers before refetching. The group the page asks about uses the same lifecycle through `useGroup`.

One deliberate exception: the event detail, its answers and the group behind them use `retain`, which keeps the shown data only while a refetch is in flight. The server also sends the `social.invalidate` signal to the member who just answered. A hard discard would unmount the answer buttons under the member's hands, drop focus and erase the confirmation message. Retained data is replaced or discarded by the very next response, and never survives an error, a 404, a route change or an account change. The list and the form gate behave as in A15/A16: the list is discarded on every signal, and the scheduling form keeps the member's draft through a re-read (as the group composer does) but closes and discards the draft the moment a response says the viewer is no longer a member. A new membership generation also clears the draft. Event-title confirmations are hidden during membership checks and cleared on lost or unavailable access, so readmission never restores an old confirmation.

## Files

| Area | Files |
|---|---|
| Strict event client (normalization, name-only people, pinned conflicts, group-bound events) | `SPA/src/api/events.js`; `group_event` notice type in `SPA/src/api/social.js` |
| Shared guarded writes and messages | `SPA/src/features/events/event-state.js` (provided as `eventsKey` in `main.js`) |
| Validation, time and labels | `SPA/src/features/events/event-utils.js` |
| Views | `EventsSection.vue`, `EventCard.vue`, `EventPage.vue`, `EventDetail.vue`, `EventResponseControl.vue`, `EventResponses.vue`, `EventCreatePage.vue` in `SPA/src/features/events/` |
| Group integration | `SPA/src/features/groups/GroupPage.vue` (`events` section), `use-group.js` (`groupSections`) |
| Routes and notices | `SPA/src/app/router.js` (`group-events`, `group-event-new`, `group-event`), `NotificationCenter.vue` |
| Layout | `SPA/src/styles/events.css` (user text wraps anywhere; 44px controls) |
| Test model and helpers | `SPA/tests/fixtures/phase5/event-backend.js` (a stateful model extending the Phase 4 group model), `SPA/tests/fixtures/phase4/browser.js`, `SPA/tests/unit/src/features/groups/harness.js`; frontend evidence only, never imported by `SPA/src` |

SN-A19 keeps the notification lifecycle and adds only a `subscribe` hook for message frames; it keeps message indicators separate from the notification badge ([frontend messages](frontend-messages.md)). No Go, schema or shared-runtime changes are needed. The native Playwright configuration includes A18. SN-B07 remains the shared image/CI owner.

## Verification record

Commands on the A18 working tree based on `8bb01e5`, 2026-10-17:

```bash
bun run test:a18
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a18-events
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-images
python3 docs/social-network/fixtures/validate-phase-5.py
git diff --check
```

- **Client replay: 85/85** event-owned approved cases (every event route, role, validation, paging and method case, plus the 26 event-notice reads) replay through the real client functions: 83 assert the exact method, path, JSON body, credentials and write header; the other two (a repeated query key and an unsupported verb) are server-only and check outcome mapping. Further checks cover name-only creators and responders, malformed bodies, an event of a foreign group, lost responses, and notices that keep only the event ID and public group metadata with no actions.
- **Test model conformance: all 85 event-owned cases**, the `events-notices` and `event-response-version` journeys and the `remove-response`, `concurrent-response` and `remove-event-create` races in both orders replay against the stateful model with exact statuses, bodies, pinned messages, resulting state, unchanged-state snapshots and signal recipients (95 checks).
- **Interaction checks: 36 event checks plus 27 unit checks** for validation, time and labels. They cover role-gated access (outsider, invitee, requester, departed) without any event request, the list (order, past events, counts, empty, outage, paging, beyond-last page), detail and answers (first answer and change with the version the viewer saw, one write for a double click, no success before commit, stale answer, lost response, removed member, stale membership generation, no restored answer after rejoining, live counts, removal clearing the page, account switching, the signal sent back to the responder keeping buttons, message and focus), scheduling (field-by-field errors and focus, one write with the member's generation, no notification claim for a sole member, double submit, lost response kept as a draft, server errors mapped back, losing membership mid-draft, stale generation, draft kept through re-reads, no draft carried across accounts) and notices (navigation, no actions or event text, read controls, membership loss hides the notice).
- `bun run test:a18`: **957/957** (22 files), including the Phase 2–4 group, notification, social and shell regressions.
- **Browser: 12/12 A18 journeys.** Keyboard scheduling and answering with focus staying on the control and a reload check; a new event reaching another member's notices live and opening the event; live counts, a stale tab and removal clearing the page; direct routes for an outsider, invitee, requester and departed member; sign-out for the next account; outage and reconnect refetch; a lost scheduling response never resent or duplicated; time-zone display and the absolute instant sent from New York; 360px/1280px layouts with no horizontal scroll and 44px controls on the list, detail and form. Screenshots `.tmp/a18-events-{360,1280}.png`, `.tmp/a18-event-{360,1280}.png` and `.tmp/a18-event-new-{360,1280}.png` were inspected with a 126-character unbroken title.
- Native `make test` returned **exit 0**: builds, Biome, gofmt, vet, Go suite, scoped race suite, Vitest **2349/2349** (94 files, statements 91.72%) and Playwright **74/74**, including the 12 A18 journeys.
- `validate-phase-5.py` passes (215 HTTP cases, 36 DM cells, 64 group cells, 44-ticket graph and links) and `git diff --check` passes; the pack and validator are B20's and were not edited.

Docker was already running. `make test-images` returned **exit 0**: both image builds, backend smoke, legacy-media recovery/participant access/static denial, two-image transport/outage smoke and **37/37** existing real-service journeys passed. These are earlier-phase regression checks. Hosted CI and real Phase 5 event acceptance remain unverified by this ticket and belong to SN-A21.

## Findings resolved during verification

- A hard re-read on every signal unmounted the answer buttons. The server signals the responder too, so every answer would have dropped keyboard focus and erased its confirmation. The detail, answers and group now retain their data while a refetch is in flight; a regression test sends the signal back to the responder and requires the same button node, focus and message.
- Source arrays rebuilt from the group object re-fired on every group refetch. Event views now key their reads on primitive IDs, so a group refresh no longer discards a screen.
- A `datetime-local` field can never hold an impossible date such as 30 February, so the only unreal wall time that reaches validation is one a clock change skips. Both are refused with the same message, and the clock-change case is tested in a zone that has one.
- Answer buttons announced a bare name and count run together; they now read "Going, 3 so far" with their pressed state.
- Existing group tests that listed the group sections were updated for the new Events tab.
- A sole member's new event claimed "Other members have been notified". The confirmation now mentions notices only when the group has other members.
- The answer status cleared itself with `display: none` and switched its role between `status` and `alert`. Both stop some screen readers announcing; the region now stays in the tree with a fixed `status` role.

## Review corrections — 2026-10-18

Follow-up to review of `aa37ace` on `chbaikas/A18` fixes four reproduced P2 issues: duplicate creation after an uncertain response, a protected title left in the creation confirmation, a late redirect after navigation, and a removed member’s draft returning after readmission.

The shared event write state now blocks uncertain creation per group until a successful list/detail read started after the uncertain outcome. Failed reads, another group’s reads and late reads from a previous account cannot unlock it. The form guards both submission and completion effects; membership loss clears its fields and the detail page clears protected confirmation text.

Verification on the corrected working tree:

- `bun run test:a18`: **965/965**, including four new interaction cases, stronger retry/readmission assertions in two existing cases and four reconciliation concurrency checks.
- `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a18-events`: **12/12** A18 browser journeys.
- Full native `make test`: **exit 0**, including build, Biome, gofmt, vet, Go suite/race checks, Vitest **2357/2357** and Playwright **74/74**.
- `validate-phase-5.py` and `git diff --check` pass.

This remains frontend fixture evidence; no new real-service Phase 5 acceptance or image verification is claimed.
