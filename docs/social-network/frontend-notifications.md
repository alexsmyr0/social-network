# Global Notifications and Request Review — SN-A10

Implemented on `chbaikas/A10`, based on merged `main` / `origin/main` revision `f8f8aa8`, using the [owner-approved profile contract](profiles-contract.md) and [fixture handoff](fixtures/phase-2-contract.json). Status and dependencies live in the [tracker](ticket-tracker.md). This is frontend-only verification; real delivery, persistence, authorization and image acceptance belong to SN-A11.

## Application behavior

The authenticated shell exposes Notifications on Home, People, profiles and both relationship-list routes. The panel has All notices and Follow requests lists, independent pagination, a server-reported unread count, individual/all-read controls and accept/decline controls using incoming follow IDs. Reading a pending notice preserves its request actions. Accepted, declined, cancelled and unfollowed requests remain read history without obsolete controls. Writes use the shared per-person duplicate guard and reconcile notices, request lists and mounted social views from server responses; uncertain writes are never replayed.

The panel follows the existing Commonplace typography, paper/forest/coral palette and bordered controls. Keyboard users can open it, operate list/read/decision/paging controls and close with Escape; opening and decisions focus the panel heading, read actions retain a stable focus destination and closing returns focus to the trigger. Route changes and account switching close the panel. At 360px the header wraps; the panel scrolls independently within the viewport, with 44px button targets and names that wrap.

Content notices preserve post/comment reaction types, permitted titles and contracted comment excerpts. Vue renders text without HTML interpretation. Teaser actors are normalized to exactly their permitted identity/relationship fields, so private avatars and registration data never enter notice state. Content notices have no links to inherited/unported content views; SN-A13 will supply authorized content navigation.

## Realtime and protected state

`notification-state.js` owns one same-origin `/ws` connection for the current authenticated account. Ordinary session checks and route navigation retain that socket. First connection, reconnect, `notification.new`, `social.invalidate`, window focus and visible-screen 60-second fallback refetch notices/requests and invalidate mounted profiles/lists. Socket signals are triggers only: no frame payload becomes displayed user data. Unrelated DM/message frames are left to Phase 5; the notice counter stays separate.

Invalidations synchronously discard protected records and unread counts, supersede older responses and coalesce same-tick bursts. Failed reads show unavailable state without keeping old notice excerpts or fabricating zero unread. A 401 from any social surface clears notices and closes the socket before session confirmation; network/5xx failure does not imply logout. Repeated notice 401s with a still-valid session settle as unavailable rather than recursively refetching or repeatedly reopening the socket. Reconnect uses 1/2/4-second exponential backoff bounded at 30 seconds, plus the fallback reads. Logout/account changes and disposal cancel timers, listeners and socket callbacks and discard previous-user writes/reads.

## Commands and ownership

```bash
bun run test:a10
make test-e2e PLAYWRIGHT_ARGS=a10-notifications
make test
```

If the execution environment makes the default Go cache read-only, the existing gate can run with workspace-local cache variables:

```bash
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test
```

| Area | Owner files / handoff |
|---|---|
| Approved notice/request/read/decision HTTP transport and normalization | `SPA/src/api/social.js` |
| Shared outgoing and incoming relationship duplicate guards and reconciliation | `SPA/src/features/social/social-state.js` |
| Session-owned socket, reconnect, protected notices/requests and read controls | `SPA/src/features/notifications/notification-state.js` |
| Global panel, keyboard behavior, responsive presentation | `NotificationCenter.vue`, `SPA/src/styles/notifications.css`, `SPA/src/app/App.vue` |
| Application lifecycle and dependency provision | `SPA/src/main.js` |
| Future permitted content navigation | A13 extends the notice target rendering; reuse the A10 state/read lifecycle |
| Future chat indicators | Phase 5; keep separate from notification counts and share the established session-owned socket |

Production imports no fixture handlers, users or seeds. `SPA/tests/fixtures/phase2/fixture-backend.js` models persistent notice history, current actor access, recipient isolation, pending decisions, privacy auto-acceptance, pagination and hidden-content filtering. API tests replay all 27 approved notification/request HTTP examples and check normalized response/request envelopes; component/state/browser tests model transitions and recovery instead of unconditional success. The fixture model is a test stand-in, not evidence of backend authorization.

## Verification record

On 2026-10-04, the working tree on `chbaikas/A10` based on `f8f8aa8` passed:

- `bun run test:a10`: **174/174** focused checks (27 approved HTTP fixture cases, request/read transport and normalization, 17 lifecycle/recovery tests, 10 panel interaction tests and A09 regressions/production-fixture policy).
- `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test`: **exit 0**. Both binaries and the Vite bundle built; Biome, gofmt, vet, Go suite and scoped race suite passed; Vitest **845/845** with coverage thresholds satisfied; native Playwright **32/32**, including **7 A10 journeys**.
- A10 browser journeys covered request signals, keyboard accept/decline and stable focus, read-all preserving pending actions, stale-ID retry protection, reconnect after a missed privacy transition, all authenticated routes with one socket, outage/retry, logout/login as another user, independent pagination and 360px/desktop bounds/44px controls.
- Visual inspection of `.tmp/a10-360px.png` and `.tmp/a10-desktop.png` confirmed wrapping names, readable controls, panel scrolling and consistency with the existing Commonplace UI. The browser checks also verified that neither the panel nor the document horizontally overflows at either viewport.
- Documentation link/anchor, tracker counts and whitespace checks passed after the final evidence update.

Initial checks exposed environment restrictions (read-only default Go cache and sandboxed localhost listeners), a browser-test selector using “Email address” instead of the actual “Email” label, and a reconnect constructor retry that could be started twice. Workspace cache settings/local-listener execution, the corrected selector and the single pending reconnect guard resolved those failures; the final gate above passed without skips. The initial mobile header overflow was corrected and pinned with a document-width browser assertion.

Docker/image and hosted checks were not run for this frontend fixture ticket; they are not its completion gate. Real Phase 2 delivery, persistence, multi-user authorization and container acceptance remain SN-A11.


### Pre-PR review — 2026-10-05

A fresh review on `chbaikas/A10`, still based on the latest fetched `origin/main` (`f8f8aa8`), found a timer-cleanup race: disposing the notification state while 401 session confirmation was pending allowed the completed confirmation to restart the fallback interval. A new fake-timer regression reproduced the leak before the fix; `startFallback()` now refuses to start after disposal or without a current account owner.

The corrected working tree passed `bun run test:a10` **175/175**, followed by `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make test` **exit 0** (build, Biome, gofmt, vet, native Go and scoped race suites, Vitest **846/846**, Playwright **32/32**, including all seven A10 browser journeys). Coverage: statements 87.06%, branches 85.49%, functions 88.23%, lines 87.04%; all repository thresholds passed. The fresh native gate log is local at `.tmp/a10-pr-review-gate.log`. Final local links/anchors (140), tracker totals and whitespace checks passed. These results supersede the earlier counts for the submitted tree; the 2026-10-04 record remains historical. Hosted/image checks remain distinct from this frontend-only native verification.
