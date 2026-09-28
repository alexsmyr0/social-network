# PLAN-D01 — Persistent Chat Roster UI

## 0. Phase 2 Spawning Note

D01 is **frontend-only**. The backend (C05) is already implemented and wired — `internal/handlers/chats.go` (HandleChatRoster) is registered at `/api/v1/chats` in `internal/router/router.go:281-288`. The ticket-tracker still shows `[ ]` for C05 but the code is shipped; flag this discrepancy but do **not** spawn a backend agent. Phase 2 spawns **one** frontend implementation agent.

## 1. Source-of-Truth Review

Constraints relevant to D01:

- **`docs/PRD.md:129-132,180`** — Roster visible at all times for authenticated users; lists all other users; shows online/offline; presence updates without refresh (D04 wires the live update — D01 only handles initial load).
- **`docs/SDS.md:203-227`** — Endpoint contract: `GET /api/v1/chats` returns `{data:[{user_id,username,is_online,last_message_at,last_message_preview,last_sender_id}]}`; `last_*` fields nullable.
- **`docs/SDS.md:229-232`** — Sorting: history-having users first by `last_message_at DESC`, then no-history users by `username ASC`. **Backend already orders** — frontend must render in array order, never re-sort.
- **`docs/SDS.md:475-484`** — Roster visible on every authenticated route; selecting a user is a separable behavior (D02).
- **`docs/audit.md:45-51`** — Auditor will confirm: section shows online users; users with messages are sorted "discord-style"; users with no messages sorted alphabetically.
- **`docs/requirements.md:51-56`** — Section to show online/offline users; only-online send constraint is D02's concern, not D01's.
- **`AGENTS.md`** — Vanilla JS ES2026+, ES modules, event delegation, vertical-feature, Vitest tests in `SPA/tests/`, no new deps, HttpOnly cookie session via `credentials:'include'`.

D01 explicitly does **not** depend on C04 (presence broadcast) or D04 (live WS wire-up). It performs a single initial fetch on auth-shell mount. Live presence updates are D04's job.

## 2. Codebase Discovery

### Persistent shell mount points (already exists from A04)

`SPA/features/shell/shell.views.js:31-44` already renders the chat aside with `#roster-list` mount target inside `[data-chat-roster]`.

### Where to initialize the roster

Hook into `runRouteInitializer` in `SPA/core/app/create-app.js:159-163` so that whenever `match.route.access === 'protected'`, the roster init is invoked. The init function self-guards via `data-roster-bound="true"` on `[data-chat-roster]`.

### Backend endpoint contract (verified)

- **URL**: `GET /api/v1/chats`
- **Auth**: session cookie required
- **Method**: only GET allowed
- **Response envelope**: `{ "data": [...] }`
- **Item shape**:
  ```json
  {
    "user_id": 12,
    "username": "maria",
    "is_online": true,
    "last_message_at": "2026-04-09T14:20:00Z" or null,
    "last_message_preview": "see you soon" or null,
    "last_sender_id": 7 or null
  }
  ```
- **Order**: backend already sorts. Frontend must render in received order.

### Existing patterns to mirror

- `SPA/features/feed/feed.page.js`: `init*` factory pattern with `windowRef/documentRef/fetchRef` injection and a `data-*-bound` idempotency guard.
- `SPA/core/api/constants.js`: `API_BASE = '/api/v1'`.
- Test helper: `SPA/tests/unit/helpers/browser-mock.js`.

### Not in scope

- `internal/` — all backend (C05) is done.
- WebSocket subscription / `presence.update` handling — owned by D04.
- Selection-side-effects (history loading, composer) — owned by D02. D01 only emits a `chat:user-selected` CustomEvent.

## 3. Files to Create / Modify

### Create

- **`SPA/features/chat/chat.roster.api.js`** — `fetchRoster(fetchRef) → Promise<RosterEntry[]>`. Calls `GET /api/v1/chats`. Returns `[]` on non-OK.
- **`SPA/features/chat/chat.roster.views.js`** — Pure render: `renderRosterItem`, `renderRosterList`. Escape via existing helper.
- **`SPA/features/chat/chat.roster.page.js`** — Initializer: `initChatRoster({windowRef, documentRef, fetchRef})`. Guards via `data-roster-bound`. Delegated `click` + `keydown` listener emitting `chat:user-selected` CustomEvent.
- **`SPA/features/chat/chat.roster.css`** — Roster row styling.
- **`SPA/tests/unit/features/chat/chat.roster.api.test.js`** — Fetch happy + non-OK + envelope unwrap.
- **`SPA/tests/unit/features/chat/chat.roster.views.test.js`** — Pure render + escape tests.
- **`SPA/tests/unit/features/chat/chat.roster.page.test.js`** — Init / fetch / paint / event-emission tests.

### Modify

- **`SPA/core/app/create-app.js`** — Import `initChatRoster`; in `runRouteInitializer`, invoke when `match.route.access === 'protected'`.
- **`SPA/features/shell/shell.views.js`** — (Optional) tidy `#roster-list` placeholder; minimal change to preserve mount.
- **`SPA/index.html`** — Load `chat.roster.css` (mirror `auth.css`/`shell.css`).
- **`docs/ticket-tracker.md`** — Mark D01 done after gate; flag C05 already-shipped status.

## 4. API Contract (verified)

```
GET /api/v1/chats
→ 200 { "data": [...RosterEntry] }
→ 401 { "error": { "code": "UNAUTHORIZED" } }
```

Frontend renders `data` in array order. Treat `last_message_*` `null` as "no history".

## 5. Component Design

### Module shape

```
features/chat/
  chat.roster.api.js
  chat.roster.views.js
  chat.roster.page.js
  chat.roster.css
```

### State (minimal — no live updates in D01)

```js
const state = { entries: [], selectedUserId: null, loaded: false };
```

Native `Proxy` is overkill for one-shot render; reserve for D04. Add comment so D04 knows.

### DOM shape

```html
<ul class="chat-roster" data-roster-list>
  <li class="chat-roster__item"
      data-roster-user-id="12"
      data-roster-username="maria"
      data-roster-online="true"
      tabindex="0"
      role="button"
      aria-pressed="false">
    <span class="chat-roster__presence chat-roster__presence--online" aria-label="online"></span>
    <span class="chat-roster__name">maria</span>
    <span class="chat-roster__preview">see you soon</span>
  </li>
</ul>
```

Empty roster: `<p class="chat-panel__empty">No other users yet</p>`.
Fetch error: `<p class="chat-panel__empty">Unable to load chats</p>`.

### Selection contract (consumed by D02)

Single delegated listener on `[data-chat-roster]` for `click` + `keydown` (Enter/Space). On hit:

1. Update `aria-pressed="true"` and `is-selected` class on chosen row, clear siblings.
2. Update `state.selectedUserId`.
3. Dispatch `new CustomEvent('chat:user-selected', { detail: {userId, username, isOnline}, bubbles: true })`.

Every row clickable regardless of `is_online`.

### Idempotency guard

Check `data-roster-bound="true"` on `[data-chat-roster]`. Set on first run.

## 6. Verification Checklist

- **Roster visible on authenticated routes** — DOM present on every protected route; survives navigation.
- **Presence state shown per user** — `data-roster-online` + visible indicator + `aria-label`.
- **Roster order matches backend** — DOM order equals response `data[]` order; no client sort.
- **All rostered users selectable** — Online and offline rows both dispatch `chat:user-selected`.
- **No new deps** — `package.json` and `go.mod` unchanged.
- **Vanilla JS ES2026+** — ES module syntax, no frameworks.
- **Event delegation** — Single listener on `[data-chat-roster]`.
- **Feature-vertical layout** — All new code under `SPA/features/chat/`.
- **HttpOnly session preserved** — `credentials:'include'`; no localStorage.
- **Vitest tests pass** — `bun run policy` green.
- **`make test` green** — Backend unaffected.
- **Biome clean** — `bun x biome check SPA/features/chat SPA/tests/unit/features/chat`.

## 7. Test Plan

### `chat.roster.api.test.js`
1. `fetchRoster` calls `/api/v1/chats` with `credentials:'include'` + `Accept: application/json`.
2. Returns `data` array on `{ok:true}`.
3. Returns `[]` on non-ok.
4. Returns `[]` on rejected fetch.

### `chat.roster.views.test.js`
1. Renders one `<li>` per entry, in input order.
2. Online has `data-roster-online="true"` + online class; offline has offline class.
3. Entries with `last_message_preview === null` render no preview text.
4. Empty input renders empty-state paragraph.
5. Username + preview HTML-escaped.

### `chat.roster.page.test.js`
1. No-op when `[data-chat-roster]` absent.
2. First call: sets `data-roster-bound`, fetches once; second call: no-op.
3. After fetch resolves, `#roster-list` contains one row per entry.
4. Click offline row → `chat:user-selected` with `isOnline:false`.
5. Click online row → `isOnline:true`.
6. Keyboard Enter on focused row emits event.
7. `aria-pressed="true"` flips on selected row, clears on siblings.

### `create-app.test.js` extension
8. Booting authenticated triggers `fetchRef('/api/v1/chats')` once.
9. Navigating between two protected routes does not re-fetch.

## 8. Implementation Sequencing

1. `chat.roster.api.js` + test → green.
2. `chat.roster.views.js` + test → green.
3. `chat.roster.page.js` + test → green.
4. Wire into `create-app.js`.
5. Add `chat.roster.css` and load in `index.html`.
6. Extend `create-app.test.js`.
7. Run `make test`, `bun run policy`, `bun x biome check`. All green.

## 9. Risks / Watch-outs

- **Idempotency**: navigating between protected routes must not double-fetch or double-bind. Check guard on every call.
- **Shell rebuild**: if `cacheAuthShellNodes` reruns, the bound attr is gone; init naturally re-runs because the guard check fails.
- **Selection state survival**: D02/D04 may lift `selectedUserId` into shared `chat.state.js`. Document hand-off in code comment.
- **Time formatting**: skip `last_message_at` rendering in D01; defer relative-time to D02/D04 with Temporal API.
- **Ticket-tracker mismatch**: C05 is `[ ]` but shipped. Flag in PR.

## Critical Files

- SPA/features/shell/shell.views.js
- SPA/core/app/create-app.js
- internal/handlers/chats.go
- SPA/features/feed/feed.page.js
- SPA/tests/unit/helpers/browser-mock.js
