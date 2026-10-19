# Private messages — SN-A19

Implemented on `chbaikas/A19`, based on merged main `56331f6` (B20 and B21 included). The [events and messaging contract](events-chat-contract.md#private-messages), its [fixture pack](fixtures/phase-5-contract.json) and the [Phase 5 decisions](phase-5-decisions.md) control the implementation; the owner approved the package on 2026-10-17 and confirmed it in full on 2026-10-18. Status lives in the [tracker](ticket-tracker.md). This ticket verifies the Vue frontend with fixtures. Relationship enforcement, offline storage, cursors and image binding on the server belong to SN-B22; group chat is [SN-A20](track-a.md#sn-a20--build-group-chat) and real-service acceptance is SN-A21.

## Delivered behavior

**Roster** (`/messages`) lists the viewer's conversations followed by the people they may message now, in the server's order (latest message first, then name), and never every account. Each row shows the name, a last-message preview (`You: …` for the viewer's own, "Image" for an image-only message), the time, the server's unread count and a "Read only" tag once messaging is no longer allowed. Presence appears only on rows where the server reported `is_online`, which it does only when the viewer may see that profile; a missing field means "hidden", never "offline". A stranger, a pending requester or an account with no relationship never appears. The profile page of someone the viewer follows links to the conversation.

**Indicator.** A "Messages" link with a count is in the navigation on every page. It is a coral square beside the ink-circle notification button, has its own count from `GET /chats/unread`, an accessible name that says "Messages, N unread messages" and never the word "notification". Its count is always the server's: message frames refetch it, they never add to it. An unknown total is shown as "—", never as a stale number. Reading notices does not move it and reading messages does not move the notification badge.

**Conversation** (`/messages/:id`) shows the partner's name and presence, the newest 30 messages in ascending ID order, "Load earlier messages" for older history, and a composer. A stranger, a pending requester, yourself, a missing account and a relationship that ended with no history are one and the same "This conversation isn't available." state: no name, no history, no composer, no image request. When the relationship ended but history exists, the history stays readable, the composer is off with an explanation, and the roster says "Read only".

**Sending.** Enter sends (Shift+Enter adds a line). Text is normalized as the contract does (CRLF → LF, trimmed), counted in code points (2,000, so 2,000 emoji are fine and 2,001 are refused), and refused with a message before any request if it has hidden control characters. Each message gets a lowercase v4 `client_id` that is reused only to retry that very message. Sends in one conversation run one after another, so rapid sends are committed and shown in the order they were written. The reply, the socket echo and a refetch all describe the same message and merge by ID: no duplicate, no reorder. While a send is in flight or failed, the message is listed below the committed ones as "Sending…" or failed with the reason. Failures are named: a lost or unconfirmed response is retryable (the same nonce makes an exact replay return the original, never a second message); a refused send (relationship lost), a conflict and a rejected body are not, and offer Discard only. A message the server now reports as committed ends its pending entry whether it arrived by reply, echo or refetch.

**Emoji and images.** The picker is a labelled group of buttons that inserts the Unicode character at the cursor, opens with focus on the first emoji, closes on Escape and returns focus to its button. A JPEG, PNG or GIF (up to 5 MiB) is staged with `POST /chats/{id}/images`, previewed, and claimed by the send by URL; an image alone is a valid message. A denied send leaves the staged image for the uploader. Private images are read with the session and shown from local object URLs, which are revoked when the account changes.

**Reading.** A conversation is marked read only after its messages are rendered on a visible page, with the largest committed ID shown, and only when an incoming message is newer than the known cursor. Fetching, receiving and sending never mark anything read. A hidden tab marks nothing until it is visible.

**Live delivery.** The notification state still owns the single session-owned socket; it now also tells subscribers about each parsed frame and each connection. The message state handles `dm.message` (append to the open conversation by ID), `chat.read` (another tab read: refetch the total), `presence.snapshot` and `presence.update`, and ignores everything else and anything malformed. A message the server withheld from live delivery (the recipient neither follows the sender nor is public) arrives with no frame and appears on the next focus, 60-second read, reconnect or reopening. A reconnect (and any invalidation) refetches the roster, the total and the open conversation, paging back from the newest message until the last known one is reached, so more than a page of missed messages is recovered once and in order.

## Membership loss and protected state

Every read uses `useSocialResource`. The conversation retains its last confirmed data while a refetch runs, so a signal or focus change does not unmount the composer under the person's hands; a failed, missing or denied read, a route change or an account change discards it at once. A conversation the server no longer shows at all also drops its draft, attachment and pending messages. An empty invalidation clears live presence until the server's filtered snapshot follows.

Drafts, attachments, pending and failed messages, presence and cached images belong to the signed-in account. Logout or an account change discards all of them and revokes every object URL; a response, send or upload that finishes afterwards is dropped by generation and cannot paint, merge or complete into the next account.

A deliberate choice: a send whose outcome is unknown does not trigger an immediate re-read. During an outage that read would fail and discard the conversation, taking the failed message and its Retry with it. The nonce makes a retry safe, and the next focus, reconnect or 60-second read reconciles anything already stored.

The sends use `POST /chats/{id}/messages`, not `dm.send`: the contract gives both the same command and outcomes and shares the nonce, HTTP returns the committed message, and HTTP sends still fan out to the sender's other tabs and to a live recipient. No Go, schema or shared-runtime change is needed; the frontend CSP already allows `blob:` images.

## Files

| Area | Files |
|---|---|
| Strict client (roster, history, send, upload, read, unread, private image read; name-only rows, checked media, pair-only history) | `SPA/src/api/chats.js` |
| Shared socket subscription | `SPA/src/features/notifications/notification-state.js` (`subscribe`) |
| Message state, drafts, outbox and retry, presence, read marking, badge total | `SPA/src/features/messages/message-state.js` (provided as `messagesKey` in `main.js`) |
| Conversation loading, merging, gap recovery and older paging | `SPA/src/features/messages/use-thread.js` |
| Text rules, nonces, merging, emoji, labels | `SPA/src/features/messages/message-utils.js` |
| Private image cache | `SPA/src/features/messages/message-images.js`, `ProtectedImage.vue` |
| Views | `MessagesPage.vue`, `ConversationPage.vue`, `MessageBadge.vue` in `SPA/src/features/messages/` |
| Reusable by SN-A20 | `MessageList.vue`, `MessageComposer.vue` (images optional), `EmojiPicker.vue`, `message-utils.js` |
| Routes and shell | `SPA/src/app/router.js` (`messages`, `conversation`), `App.vue`, `ProfilePage.vue` |
| Layout | `SPA/src/styles/messages.css`; `main.css` (frame column and navigation gap) |
| Test model and helpers | `SPA/tests/fixtures/phase5/chat-backend.js` (a stateful model extending the event model, ported from the pack's reference model), `SPA/tests/fixtures/phase5/browser.js`, `SPA/tests/unit/src/features/messages/harness.js`; frontend evidence only, never imported by `SPA/src` |

SN-A20 reuses the list, composer and picker, and adds per-group counts to the same indicator.

## Verification record

Commands on the A19 working tree based on `56331f6`, 2026-10-19:

```bash
bun run test:a19
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-e2e PLAYWRIGHT_ARGS=a19-messages
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test-images
python3 docs/social-network/fixtures/validate-phase-5.py
git diff --check
```

- **Client replay: 93/93.** All 86 private-message HTTP cases of the approved pack replay through the real client functions: each asserts the exact method, path, JSON or multipart body, credentials and write header, or (for seven server-only cases such as repeated query keys) the outcome mapping. Further checks cover name-only roster rows, presence only when reported, malformed rosters, history that is unordered, inconsistent or between other people, a send reply that is not the viewer's own message with the same nonce, unchecked media URLs, lost responses and private image reads.
- **Test model conformance: 142/142.** The model replays every private-message HTTP case with exact statuses, bodies, signals (including payloads) and resulting state, the three DM journeys and four races in both orders, the write-time delivery cases and a presence check. A mutation of the live predicate makes the application matrix fail.
- **Delivery matrix in the application: 73 checks.** For each of the 36 cells the sender's page shows the history, enables the composer exactly when sending is allowed, shows presence exactly when the profile is visible, and the recipient's page receives a permitted message live exactly when the live predicate holds and otherwise shows it after the next read.
- **Interaction checks: 55, plus 14 state, 8 utility and 4 image-cache checks.** They cover the roster and indicator (strangers, outage, unknown count, presence rules), conversation access (stranger, pending, self, missing, bad route), reading (once, largest ID, hidden tab, frames never add counts), sending (one nonce, response/echo merge, Enter, rapid serialized sends, all four lost-response outcomes, discard, rejection, relationship loss, stale page, draft survival), text (2,000/2,001 code points, CRLF, control characters, plain-text rendering), emoji keyboard operation, images (stage, preview, claim, remove, wrong type, 422, denied send), live delivery (partner, own other tab, other conversation, foreign frame, withheld delivery), history (paging, failed paging, 35- and 1,235-message gaps after reconnect, reconnect banner, offline recipient) and account changes (cleared drafts and images, late responses, pending sends, sign-out, a lost session). Five notification-state checks cover the new subscription hook.
- **Browser: 9/9 A19 journeys.** Keyboard-only conversation with the emoji picker and focus kept in the box; live messages with separate indicator and notification badge; an offline send that fails, keeps its nonce and retries once, then a dropped socket whose missed messages are recovered in order; five rapid sends; relationship loss with readable history; strangers and pending requesters; sign-out clearing messages, drafts and images; keyboard image staging and sending; 360px/1280px layouts with a 360-character unbroken message and 44px controls (screenshots `.tmp/a19-messages-{360,1280}.png` and `.tmp/a19-conversation-{360,1280}.png` were inspected).
- `bun run test:a19`: **1268/1268** (29 files); native `make test` returned **exit 0**: builds, Biome, gofmt, vet, Go suite, scoped race suite, Vitest **2750/2750** (102 files, statements 92.46%) and Playwright **83/83**.
- `validate-phase-5.py` passes (215 HTTP cases, 36 DM cells, 64 group cells, 44-ticket graph and links); the pack and validator are B20's and were not edited. Docker was already running; `make test-images` returned **exit 0**: both image builds, backend smoke, legacy-media recovery, two-image transport/outage smoke and **37/37** existing real-service journeys (earlier-phase regression checks). Hosted CI and real Phase 5 messaging acceptance remain unverified by this ticket and belong to SN-B22 and SN-A21.

## Findings resolved during verification

- One more navigation link widened the whole page on phones and at 1280px: the page frame's single `auto` grid column grew to its widest child. The column is now `minmax(0, 1fr)` and the navigation gap scales more gently.
- The unread total looped on an unconfirmed 401. Handling a 401 re-reads every registered view, including the total, which asked again. It is now handled once, like the notification state.
- An immediate re-read after an unconfirmed send discarded the whole conversation during an outage, taking the failed message and its Retry with it. An unknown outcome now waits for the next read; the nonce keeps a retry safe.

- Final branch review reproduced a reconnect gap after 1,235 missed messages: the 40-page recovery cap silently omitted five messages. Recovery now pages until it reaches the last known message, rejecting non-progressing pages; the regression covers both 35 and 1,235 missed messages.

- During final review, running native and image browser suites concurrently caused an integration trace `ENOENT`: native Playwright cleans the parent `test-results` directory used by integration traces. The native gate passed; the full image gate was rerun sequentially on the final source. Keep these existing gates sequential, as `make check` does.
