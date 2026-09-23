# Frontend Baseline and Documentation Inventory

Deliverable of [SN-A01](track-a.md#sn-a01--frontend-baseline-and-documentation-inventory). Discovery only: nothing here selects a framework, removes a file or authorizes a deletion.

Revision inspected: branch `chbaikas/A01`, rebased onto `main` at `100094a`. Checks executed 2026-09-22.

Discovery first ran against a checkout that included a since-removed commit, `6262f7b`, which had prematurely deleted inherited documentation. That commit was taken out of `main` at the owner's direction before this ticket closed; findings that changed as a result are marked where they appear, and the sequence is recorded in [§5.7](#57-the-removed-6262f7b-commit).

**How to read this.** Statements marked **Observed** were read in the code or produced by a command recorded in [§5](#5-baseline-check-results). Statements marked **Unverified** are inferences that a later ticket must confirm. Dev 2 should start at [§3](#3-contract-assumptions-dev-2-handoff), which lists every auth and upload assumption with its source line.

---

## 1. What exists today

**Observed.** The frontend is a vanilla-JS SPA in [SPA/](../../SPA/), served by a Go static+proxy server in [cmd/frontend/](../../cmd/frontend/). There is no build step: [SPA/index.html](../../SPA/index.html) loads [SPA/main.js](../../SPA/main.js) as a native ES module and every import is a relative browser path.

### 1.1 Topology

| Concern | Owner | Evidence |
|---|---|---|
| Static SPA delivery + history fallback | Go frontend server, port 3000 | [routes.go:98-104](../../cmd/frontend/routes.go#L98-L104), [server.go:23-43](../../cmd/frontend/server.go#L23-L43) |
| `/api/` and `/ws` reverse proxy to `:8080` | Same server, one `httputil.NewSingleHostReverseProxy` | [routes.go:78-90](../../cmd/frontend/routes.go#L78-L90) |
| Legacy `/static/` and `/errors/` trees | Same server, `./web/static`, `./web/errors` | [routes.go:46-70](../../cmd/frontend/routes.go#L46-L70) |
| CSP and security headers | Frontend server middleware | [routes.go:23-41](../../cmd/frontend/routes.go#L23-L41) |

The SPA fallback is conditional, not a blanket catch-all: [`isNavigationRequest`](../../cmd/frontend/server.go#L45-L77) serves `index.html` only for GET requests to extensionless or `.html` paths that accept HTML, and returns a real 404 otherwise. **Observed** — this is what keeps a missing `.js` import from silently returning an HTML document.

### 1.2 Routing

**Observed.** Routes are a static table in [routes.js:3-42](../../SPA/core/router/routes.js#L3-L42), compiled to regexes at module load. Eight routes exist:

| id | path | access |
|---|---|---|
| `login` | `/login` | public-only |
| `register` | `/register` | public-only |
| `feed` | `/` | protected |
| `post-detail` | `/posts/:id` | protected |
| `create-post` | `/create-post` | protected |
| `edit-post` | `/edit-post/:id` | protected |
| `activity` | `/activity` | protected |
| `profile` | `/profile/:id` | protected |

Two legacy path rewrites are baked into [`normalizePathname`](../../SPA/core/router/routes.js#L80-L101): `/view-post/:id` and `/post/:id` both normalize to `/posts/:id`. **Observed.** SN-A02 must decide explicitly whether these survive; they are currently invisible redirects with no test naming them as a product requirement.

**There is no `/chat` route.** Chat is not routed at all — the roster and conversation panels are markup inside the authenticated shell ([shell.views.js:34-47](../../SPA/features/shell/shell.views.js#L34-L47)) and are re-initialized on *every* protected route render ([create-app.js:278-282](../../SPA/core/app/create-app.js#L278-L282)). **Observed.** This is the single most consequential structural fact for a framework port: chat lives in the layout, not in the route tree.

Navigation is delegated, not per-link: one document-level `click` listener intercepts `a[data-link]` ([create-app.js:384-412](../../SPA/core/app/create-app.js#L384-L412)), and one document-level `submit` listener intercepts auth forms ([create-app.js:414-431](../../SPA/core/app/create-app.js#L414-L431)).

### 1.3 Auth boot sequence

**Observed**, from [`boot`](../../SPA/core/app/create-app.js#L438-L449):

1. `GET /api/v1/users/me` with `credentials: 'include'` → `isAuthenticated = response.ok` ([create-app.js:34-52](../../SPA/core/app/create-app.js#L34-L52)).
2. `handleLocationChange()` matches the route and applies access rules.
3. The `#loading-overlay` is faded and removed.
4. If authenticated, the notification centre and the chat WebSocket start.

Access enforcement is in [`enforceRouteAccess`](../../SPA/core/app/create-app.js#L54-L72): an unmatched route redirects to `/` (authenticated) or `/login`; `protected` without a session → `/login`; `public-only` with a session → `/`. **Observed.**

Session *state* lives in a Proxy store slice, not in the app closure: [session.js](../../SPA/core/state/session.js) over [app-state.js](../../SPA/core/state/app-state.js) and [store.js](../../SPA/core/state/store.js). Four slots: `isAuthenticated`, `currentUserId`, `onlineUserIds`, `hasPresenceSnapshot` ([app-state.js:23-28](../../SPA/core/state/app-state.js#L23-L28)).

A global 401 interceptor wraps every feature fetch: `appFetch` calls `onUnauthorized()` on a 401, which clears the session, stops notifications and chat, and redirects to `/login` ([create-app.js:93-105](../../SPA/core/app/create-app.js#L93-L105), [create-app.js:123-132](../../SPA/core/app/create-app.js#L123-L132)). **Observed.** Note the asymmetry: `appFetch` is passed to feature initializers, but the auth form submit and logout use the *raw* `fetchRef` ([create-app.js:357-377](../../SPA/core/app/create-app.js#L357-L377), [create-app.js:422](../../SPA/core/app/create-app.js#L422)) — deliberate, since those paths handle their own non-OK responses.

### 1.4 Socket ownership

**Observed.** Exactly one WebSocket exists per session and it is owned by the app shell, not by a feature: `createChatSocket` is constructed in [create-app.js:153](../../SPA/core/app/create-app.js#L153) and opened/closed only alongside the session lifecycle.

The socket never touches the DOM for rendering. Inbound frames are re-published as DOM `CustomEvent`s on the shared `documentRef` ([chat-socket.js:53-84](../../SPA/core/realtime/chat-socket.js#L53-L84)), and slices subscribe to those events without holding a socket reference. The mapping is frozen in [`WS_EVENTS`](../../SPA/core/realtime/chat-socket.js#L20-L26):

| Server frame | DOM event |
|---|---|
| `presence.snapshot` | `chat:presence-snapshot` |
| `presence.update` | `chat:presence-update` |
| `dm.message` | `chat:dm-message` |
| `notification.new` | `chat:notification-new` |
| `chat.error` | `chat:error` |

Outbound goes the other way: the composer dispatches `SEND_MESSAGE_EVENT`, the shell listener builds the `dm.send` payload and calls `chatSocket.send` ([create-app.js:200-224](../../SPA/core/app/create-app.js#L200-L224)). Reconnect is exponential backoff, 1s base to 30s cap ([chat-socket.js:31-32](../../SPA/core/realtime/chat-socket.js#L31-L32)).

**This event-bus indirection is the most portable thing in the codebase** and is the strongest reuse candidate in [§2](#2-reuse-candidates).

---

## 2. Reuse candidates

Classified by how much of each module survives a framework port. "DOM-free" was measured by counting lines matching `innerHTML`/`querySelector`/`addEventListener`/`createElement`/`classList`/`dataset`/`documentRef` per file. **Observed** — the count is reproducible with the command in [§5.6](#56-supporting-commands).

### 2.1 Portable as-is (zero DOM references)

These import no DOM API and are pure logic or pure string-building. A framework port can import them unchanged or transliterate them mechanically.

| Module | Role |
|---|---|
| [core/state/store.js](../../SPA/core/state/store.js) | Proxy reactive store — likely superseded by the framework's own state layer |
| [core/state/app-state.js](../../SPA/core/state/app-state.js), [session.js](../../SPA/core/state/session.js) | Session slots and identity resolution |
| [core/router/routes.js](../../SPA/core/router/routes.js) | Route table + `normalizePathname` legacy rewrites |
| [core/api/session.api.js](../../SPA/core/api/session.api.js), [constants.js](../../SPA/core/api/constants.js) | `API_BASE` and `/users/me` |
| [features/*/\*.api.js](../../SPA/features/) (activity, chat ×2, notification, post ×2) | Endpoint URL construction, payload shaping, response unwrapping |
| [core/utils/throttle.js](../../SPA/core/utils/throttle.js), [html.js](../../SPA/core/utils/html.js), [core/ui/pagination.js](../../SPA/core/ui/pagination.js) | Small pure helpers |
| [features/post/post.reactions.logic.js](../../SPA/features/post/post.reactions.logic.js), [chat/chat.roster.logic.js](../../SPA/features/chat/chat.roster.logic.js), [feed/feed.state.js](../../SPA/features/feed/feed.state.js) | Domain logic — reaction toggling, roster ordering, feed paging state |

**The `.api.js` layer is the highest-value reuse target.** It encodes the live backend contract and is independent of any rendering approach.

### 2.2 Portable logic, disposable markup (`*.views.js`)

**Observed.** The files below have zero matches for the DOM APIs in §2. They build markup strings rather than manipulating DOM nodes. Their markup is throwaway in a framework port, but the *structure* they encode (field names, data attributes, ARIA roles, empty/error states) is a specification worth translating rather than rediscovering.

Files: [auth.views.js](../../SPA/features/auth/auth.views.js), [shell.views.js](../../SPA/features/shell/shell.views.js), [feed.views.js](../../SPA/features/feed/feed.views.js), [post.views.js](../../SPA/features/post/post.views.js), [post-detail.views.js](../../SPA/features/post/post-detail.views.js), [profile.views.js](../../SPA/features/profile/profile.views.js), [activity.views.js](../../SPA/features/activity/activity.views.js), [notification.views.js](../../SPA/features/notification/notification.views.js), [chat.roster.views.js](../../SPA/features/chat/chat.roster.views.js), [chat.conversation.views.js](../../SPA/features/chat/chat.conversation.views.js).

Unlike these string builders, [post-card.views.js](../../SPA/features/post/post-card.views.js#L170-L177) creates and mutates DOM nodes; it belongs in §2.3. Its [upload-URL allowlist](../../SPA/features/post/post-card.views.js#L102-L116) is security logic worth carrying over deliberately (see [§3.4](#34-uploads)).

### 2.3 Rewrite required (DOM-dependent modules)

These are mostly `init*Page` functions that query, mutate and bind directly against rendered markup; `post-card.views.js` constructs DOM nodes. They are the actual porting cost. Ordered by matching-line count:

| Module | Matching lines | Lines | Notes |
|---|---|---|---|
| [features/post/post.page.js](../../SPA/features/post/post.page.js) | 66 | 766 | Largest single file; owns detail + create/edit forms |
| [features/activity/activity.page.js](../../SPA/features/activity/activity.page.js) | 61 | 488 | |
| [features/chat/chat.conversation.page.js](../../SPA/features/chat/chat.conversation.page.js) | 45 | 566 | Scroll pagination + composer + upload |
| [features/feed/feed.page.js](../../SPA/features/feed/feed.page.js) | 34 | — | |
| [core/app/create-app.js](../../SPA/core/app/create-app.js) | 33 | 475 | Router, access control, shell, socket wiring, delegation |
| [features/notification/notification.page.js](../../SPA/features/notification/notification.page.js) | 31 | — | |
| [features/chat/chat.roster.page.js](../../SPA/features/chat/chat.roster.page.js) | 20 | — | |
| [features/profile/profile.page.js](../../SPA/features/profile/profile.page.js) | 19 | — | |
| [core/realtime/chat-socket.js](../../SPA/core/realtime/chat-socket.js) | 17 | — | DOM refs are **event dispatch only**, not rendering — cheap to port |
| [features/post/post.reactions.bindings.js](../../SPA/features/post/post.reactions.bindings.js) | 14 | — | |
| [core/shared/image-picker.js](../../SPA/core/shared/image-picker.js) | 10 | — | Preview/`URL.createObjectURL` lifecycle |
| [features/auth/auth.handlers.js](../../SPA/features/auth/auth.handlers.js) | 9 | — | DOM refs are inline error rendering + submit-button busy state |
| [features/post/post-card.views.js](../../SPA/features/post/post-card.views.js) | 6 | — | Builds a DOM article and attaches a click listener; preserve its upload-URL allowlist |

**Unverified:** that `create-app.js` has no framework-agnostic core worth extracting. Its access-control rules and the outlet-preservation logic ([create-app.js:75-88](../../SPA/core/app/create-app.js#L73-L91), [create-app.js:229-257](../../SPA/core/app/create-app.js#L229-L257)) may be reusable as pure functions, but this was not tested.

### 2.4 CSS

**Observed.** 4,377 lines of vanilla CSS across 14 files. [assets/css/tokens.css](../../SPA/assets/css/tokens.css) (138) and [design-system.css](../../SPA/assets/css/design-system.css) (581) are framework-neutral and are strong reuse candidates. Feature stylesheets are coupled to the current class names — [post-card.css](../../SPA/features/post/post-card.css) is 1,111 lines alone — and their fate follows the markup rewrite.

---

## 3. Contract assumptions (Dev 2 handoff)

Every assumption the frontend makes about the backend. **All Observed** unless marked. Dev 2 (SN-B02 auth contract, SN-B0x storage) should treat each row as a constraint to either honor or explicitly break.

### 3.1 Base path and transport

- `API_BASE = '/api/v1'` — [constants.js:1](../../SPA/core/api/constants.js#L1).
- **Exception:** [auth.handlers.js:5-6](../../SPA/features/auth/auth.handlers.js#L5-L6) hardcodes `/api/v1/users/login` and `/api/v1/users/register` instead of using `API_BASE`. [create-app.js:40](../../SPA/core/app/create-app.js#L40) and [create-app.js:363](../../SPA/core/app/create-app.js#L363) likewise hardcode `/api/v1/users/me` and `/api/v1/users/logout`. Four literals to update if the base path changes.
- Every request sends `credentials: 'include'`. The SPA reads no token and sets no `Authorization` header — **auth is cookie-only end to end.**
- WebSocket URL is derived from `location`, not configured: `wss:` if the page is HTTPS, else `ws:`, always same-origin `/ws` ([chat-socket.js:37-41](../../SPA/core/realtime/chat-socket.js#L37-L41)). A cross-origin frontend container would break this.

### 3.2 Endpoints the SPA calls

| Method | Path | Caller |
|---|---|---|
| GET | `/users/me` | [session.api.js](../../SPA/core/api/session.api.js#L18), [create-app.js:40](../../SPA/core/app/create-app.js#L40) |
| POST | `/users/login`, `/users/register` | [auth.handlers.js](../../SPA/features/auth/auth.handlers.js#L5-L6) |
| POST | `/users/logout` | [create-app.js:363](../../SPA/core/app/create-app.js#L363) |
| GET | `/users/:id/profile` | [profile.page.js](../../SPA/features/profile/profile.page.js) |
| GET | `/users/activity` | [activity.api.js](../../SPA/features/activity/activity.api.js) |
| GET/POST | `/posts` | [post.api.js](../../SPA/features/post/post.api.js), [feed.page.js](../../SPA/features/feed/feed.page.js) |
| GET/PATCH/DELETE | `/posts/:id` | [post.api.js](../../SPA/features/post/post.api.js), [activity.api.js](../../SPA/features/activity/activity.api.js) |
| GET/POST | `/posts/:id/comments` | [post.api.js](../../SPA/features/post/post.api.js) |
| PATCH/DELETE | `/comments/:id` | [activity.api.js](../../SPA/features/activity/activity.api.js) |
| POST | `/posts/:id/:type`, `/comments/:id/:type` (reactions) | [post.reactions.api.js](../../SPA/features/post/post.reactions.api.js) |
| GET | `/categories` | [post.api.js](../../SPA/features/post/post.api.js) |
| GET | `/notifications` | [notification.api.js](../../SPA/features/notification/notification.api.js) |
| GET | `/chats` | [chat.roster.api.js](../../SPA/features/chat/chat.roster.api.js) |
| GET | `/chats/:userId/messages` | [chat.conversation.api.js](../../SPA/features/chat/chat.conversation.api.js) |
| POST | `/chats/:userId/images` | [chat.conversation.api.js:55](../../SPA/features/chat/chat.conversation.api.js#L55) |
| WS | `/ws` | [chat-socket.js](../../SPA/core/realtime/chat-socket.js#L37-L41) |

### 3.3 Auth assumptions

1. **Session detection is `GET /users/me` response-ok**, nothing more ([create-app.js:48](../../SPA/core/app/create-app.js#L48)). Any non-2xx — including 500 — reads as "logged out".
2. **Identity shape:** `payload.data.id`, must be a finite number ([session.api.js:25-26](../../SPA/core/api/session.api.js#L25-L26)). `0` means unresolved; a failed lookup is deliberately not cached so the next caller retries ([session.js:38-57](../../SPA/core/state/session.js#L38-L57)).
3. **Login accepts either username or email in one field.** The SPA routes the value to `email` if it contains `@`, else `username` ([auth.handlers.js:94-109](../../SPA/features/auth/auth.handlers.js#L94-L109)). The inline comment asserts "the backend rejects usernames containing `@`" — **Unverified against current backend code; SN-B02 must confirm or drop this heuristic.**
4. **Registration payload:** `first_name`, `last_name`, `gender`, `username`, `email`, `password`, and `age` as an integer ([auth.handlers.js:111-128](../../SPA/features/auth/auth.handlers.js#L111-L128)). `age` is omitted entirely if it does not match `/^-?\d+$/`.
5. **Error envelope:** the SPA reads `responseBody.error.message` and falls back to a generic string ([auth.handlers.js:186-195](../../SPA/features/auth/auth.handlers.js#L186-L195)).
6. **Logout finalizes on ok *or* 401** ([create-app.js:353-355](../../SPA/core/app/create-app.js#L353-L355)) — an already-dead session still logs the user out locally. A network throw does *not* finalize ([create-app.js:374-376](../../SPA/core/app/create-app.js#L374-L376)).
7. **401 on any feature request is a global logout signal** (§1.3).

> **Requirement gap — flagged for SN-A02/SN-B02, not resolved here.** The [authentication requirement](requirements.md#authentication) asks for Email, Password, First Name, Last Name, **Date of Birth**, and optional **Avatar/Image**, **Nickname** and **About Me**. The inherited form collects **Age** and **Gender** and a required **Username**, and has no avatar, nickname or about-me field ([auth.views.js:89-149](../../SPA/features/auth/auth.views.js#L89-L149)). Age→DOB is a data-model change, not a form change. This is recorded as a finding; the fix belongs to the registration ticket.

### 3.4 Uploads

1. **Four image-capable post/comment operations plus DM upload.** `POST /posts` and `PATCH /posts/:id` use multipart built by [`buildPostMultipartFormData`](../../SPA/core/shared/utils.js#L33-L50) when an image is selected ([post.api.js:125-190](../../SPA/features/post/post.api.js#L125-L190)). `POST /posts/:id/comments` and `PATCH /comments/:id` also accept a multipart `image` field ([post.api.js:198-214](../../SPA/features/post/post.api.js#L198-L214), [activity.api.js:142-162](../../SPA/features/activity/activity.api.js#L142-L162)). These operations send JSON when no new image is selected. DMs use `POST /chats/:userId/images` with an `image` field, returning a URL the client then attaches to a `dm.send` frame ([chat.conversation.api.js:43-69](../../SPA/features/chat/chat.conversation.api.js#L43-L69), [create-app.js:164-183](../../SPA/core/app/create-app.js#L164-L183)).
2. **Client-side size cap is 20 MiB** — `MAX_IMAGE_BYTES = 20 * 1024 * 1024` ([utils.js:1](../../SPA/core/shared/utils.js#L1)). **Unverified** whether the backend enforces the same limit; a client-only cap is not a control.
3. **Multipart requests must not set `Content-Type`.** [`buildImageRequestOptions`](../../SPA/core/shared/utils.js#L5-L20) passes only `Accept: application/json` so the browser writes its own boundary.
4. **Served upload URLs must start with `/static/uploads/`.** [post-card.views.js:102-116](../../SPA/features/post/post-card.views.js#L102-L116) rejects anything else, including absolute URLs whose pathname fails the prefix. DM images are documented as landing under `/static/uploads/dm/` ([chat.conversation.views.js:18](../../SPA/features/chat/chat.conversation.views.js#L18)).
5. **`/static/` is served from `./web/static` by the frontend server** ([routes.go:49-54](../../cmd/frontend/routes.go#L49-L54)) — so uploads written by the *backend* are read from the *frontend* container's filesystem. **This is a shared-filesystem assumption that breaks under the two-container requirement** ([docker](requirements.md#docker)). Flagged for SN-A02; not resolved here.
6. **CSP constrains images to `'self' data: blob:`** ([routes.go:25](../../cmd/frontend/routes.go#L25)) — no third-party image host, and `data:`/`blob:` exist specifically for the picker preview.

### 3.5 WebSocket assumptions

- Outbound `dm.send` payload: `{ recipient_id: number, body: string, image_url?: string }`. A frame with neither body nor image is dropped client-side ([create-app.js:169-183](../../SPA/core/app/create-app.js#L169-L183)).
- A closed socket surfaces a synthetic `chat:error` with code `NOT_CONNECTED` ([create-app.js:185-198](../../SPA/core/app/create-app.js#L185-L198)).
- Unknown inbound frame types are ignored, not fatal ([chat-socket.js:82](../../SPA/core/realtime/chat-socket.js#L82)).
- `presence.snapshot` supersedes the REST roster's `is_online` once received ([app-state.js:27](../../SPA/core/state/app-state.js#L27)).

### 3.6 CSP constraints the SPA must keep satisfying

**Observed**, from [routes.go:25](../../cmd/frontend/routes.go#L25): `script-src 'self'` with **no** `'unsafe-inline'` and no `'unsafe-eval'`. `connect-src 'self'` only — no `ws:`/`wss:` scheme sources, relying on CSP3 same-origin upgrade.

**This constrains the production bundle, not the development server (SN-A02).** The policy is a response header emitted by the Go frontend server ([routes.go:31-37](../../cmd/frontend/routes.go#L31-L37)), so it applies only to what that server serves. A framework's dev server does not run behind it, and the conformance test scans shipped SPA sources rather than a running dev process. The real constraint is therefore on the **production build output**: it must contain no inline `<script>`, no `on*` handlers, and no runtime `eval`/`new Function` template compilation.

**Corrected.** An earlier draft of this section called the CSP "a direct constraint on framework choice" and implied a dev server on another origin would violate it. That conflated two different things and is withdrawn: the CSP is a response header emitted by the Go frontend server and governs the production bundle it serves, not a framework's development server. **Unverified:** which specific candidates emit a compliant production bundle; that comparison belongs to SN-A02, which has not started.

---

## 4. Documentation inventory

Disposition is a **recommendation requiring owner approval** (SN-A02) — nothing below is authorization to delete. `keep` = correct as-is; `rewrite` = content needed but currently wrong; `archive` = historical value, move out of the active path; `remove` = proposed deletion, owner decides.

### 4.1 Broken references

**Observed**, from a reference scan ([§5.6](#56-supporting-commands)) and target checks against this revision. There are 33 unresolved relative Markdown links: 29 PR links in the forum tracker, two links to the missing `docs/pr-message/` directory, and two links to sibling-repository paths outside this repo. `docs/pr-message/` was never imported (absent from the baseline `b295348`). Plain-text references to that directory and an old absolute `file://` link also need disposition; they are listed below but are not included in the count of 33 links.

| File | Affected references | Disposition |
|---|---|---|
| [docs/ticket-tracker.md](../ticket-tracker.md) | 29 links to `pr-message/<TICKET>-pr.md` — the forum's per-ticket PR write-ups | **keep the file, rewrite the links** (SN-A08). The tracker is the historical delivery record; only its PR column is dead. |
| [.github/prompts/fix-gitea-issue.prompt.md](../../.github/prompts/fix-gitea-issue.prompt.md), [.agents/workflows/fix-gitea-issue.prompt.md](../../.agents/workflows/fix-gitea-issue.prompt.md) | `../../docs/pr-message` | **archive or rewrite** — a Gitea PR workflow inherited from the forum; verify whether the flow is still used before either. |
| [.github/prompts/Implement-ticket.prompt.md](../../.github/prompts/Implement-ticket.prompt.md), [.agents/workflows/impl-ticket.md](../../.agents/workflows/impl-ticket.md), [.github/pull_request_template.md](../../.github/pull_request_template.md) | Plain-text `docs/pr-message/` or `pr-template.md` references; `impl-ticket.md` also links to an old absolute `file://` template path | **rewrite or archive** — active-looking PR instructions point to missing or machine-specific locations. |
| [docs/audit.md](../audit.md) | `../../good-practices/README.md` | **keep, rewrite the link** — points outside the repo to the 01-edu shared folder. |
| [docs/requirements.md](../requirements.md) | `../forum/README.md#Communication` | **keep, rewrite the link** — same class: a sibling-repo path from the original exercise layout. |

> **Note on an earlier draft of this section.** While `6262f7b` was still in the tree (see [§5.7](#57-the-removed-6262f7b-commit)), this inventory reported ~32 broken links in `AGENTS.md`, `README.md`, `docs/social-network/inherited-context.md` and four prompt files, and recorded `docs/audit.md`, `docs/PRD.md` and `docs/SDS.md` as "never imported." **That was wrong on both counts.** Those documents were imported at `b295348`; `6262f7b` deleted them, which is what broke the links. Removing that commit repaired all of them without a single documentation edit. The rows above are the state at this revision.

### 4.2 Active social-network docs — keep

All in [docs/social-network/](.) and internally consistent as far as inspected: [CONTEXT.md](CONTEXT.md), [requirements.md](requirements.md), [inherited-context.md](inherited-context.md), [planning.md](planning.md), [roadmap.md](roadmap.md), [ticket-tracker.md](ticket-tracker.md), [ticket-rules.md](ticket-rules.md), [ticket-audit.md](ticket-audit.md), [track-a.md](track-a.md), [track-b.md](track-b.md). Their `../` links to the forum originals (`../ticket-tracker.md`, `../track-c.md`, `../track-d.md`) resolve correctly at this revision.

### 4.3 Inherited forum docs at repo root

| File | Content | Disposition |
|---|---|---|
| [architecture.md](../../architecture.md) | 12.6 KB forum architecture. Actively asserted by a passing test ([docs-consistency.test.js](../../SPA/tests/unit/docs-consistency.test.js#L16-L76) checks it for `web/templates` absence, `exponential backoff`, schema agreement) | **keep until the framework port**, then rewrite. Deleting it breaks 5 currently-passing assertions. |
| [README.md](../../README.md) | Forum-branded, forum feature list; its doc links resolve at this revision | **rewrite** (SN-A08) — it is the repo's front door and still introduces the project as the forum |

### 4.4 Agent scratch and prompt files

| Path | Content | Disposition |
|---|---|---|
| [.agents/scratch/](../../.agents/scratch/) | Per-ticket forum plans (`PLAN-A06.md`, `PLAN-C08.md`, `PLAN-D01.md`, `PLAN.md`, `PLAN-audit-fixes-*.md`) citing `docs/SDS.md` line numbers, which resolve at this revision; `PLAN-A06.md`, `PLAN-C08.md` and `PLAN-audit-fixes-*.md` also mention the missing `docs/pr-message/` directory | **archive** — historical planning records, superseded by the SN tickets but still the clearest account of some forum contract decisions (e.g. roster sort order, [PLAN-D01.md:13](../../.agents/scratch/PLAN-D01.md#L13)). |
| [.github/prompts/](../../.github/prompts/) | Orchestration prompts driving forum audit workflows off `docs/audit.md`, `docs/PRD.md`, `docs/SDS.md` — all present at this revision | **rewrite or archive** (SN-A08) — they target the forum's acceptance criteria, not the social-network assignment. |

### 4.5 Legacy code trees referenced by docs

Not documentation, but named throughout it and relevant to the cleanup decision:

| Path | State | Disposition |
|---|---|---|
| [web/static/](../../web/static/) | `favicon.ico` + `uploads/`; **live** — served at `/static/` and the upload allowlist depends on the prefix | **keep** — removal breaks uploads and the favicon |
| [web/errors/](../../web/errors/) | Served at `/errors/`; excluded from Biome via [.biomeignore](../../.biomeignore) | **Unverified** whether anything still links to these pages — check before disposing |
| `web/templates/` | **Does not exist.** [docs-consistency.test.js:44-46](../../SPA/tests/unit/docs-consistency.test.js#L44-L46) asserts `architecture.md` does *not* mention it | already removed; no action |

---

## 5. Baseline check results

Environment: Linux 7.1.13, Go 1.26.7, Bun 1.3.14, Node 24.16.0. Revision `6262f7b`. Run 2026-09-22.

**Precondition discovered:** `node_modules/` was absent from the checkout, so `bun run test` failed with `vitest: command not found` (exit 127) before anything ran. `bun install` was required first. Note that `make lint` and `make format-frontend` invoke `./node_modules/.bin/bun` ([Makefile:93](../../Makefile#L93), [Makefile:152](../../Makefile#L152)) — an absolute dependency on that directory existing.

`bun install` modified [bun.lock](../../bun.lock) (1 insertion, 3 deletions) as a side effect. **That change was reverted** so SN-A01 touches no file outside `docs/`; no source file was edited. The drift is reproducible — see open question 7.

### 5.1 `bun install`

```
bun install v1.3.14 → 124 packages installed [5.60s] → exit 0
```

### 5.2 `bun run lint` (Biome 2.4.12)

```
biome check . → Checked 122 files in 81ms. No fixes applied. → exit 0
```

**PASS**, clean.

### 5.3 `bun run test` (Vitest 3.2.4 + v8 coverage)

```
Test Files  51 passed (51)
     Tests  473 passed (473) → exit 0
Statements 83.02% (5386/6487) · Branches 80.02% (1318/1647)
Functions  84.98% (334/393)  · Lines    83.02% (5386/6487)
```

**PASS**, clean. All four coverage figures clear the configured thresholds (75/73/78/75 in [vitest.config.ts](../../vitest.config.ts)).

**One baseline failure was observed earlier and is now resolved.** The first discovery pass, taken while `6262f7b` was still in the tree, recorded:

```
Test Files  1 failed | 50 passed (51)
     Tests  1 failed | 472 passed (473)

FAIL SPA/tests/unit/docs-consistency.test.js
  > core/state matches its documentation (#76)
  > SDS §7.0 documents the implemented Proxy store
Error: ENOENT: no such file or directory, open '.../docs/SDS.md'
```

Cause and fix are in [§5.7](#57-the-removed-6262f7b-commit). No test or documentation file was edited to obtain the passing result above.

### 5.4 `make test-e2e` (Playwright 1.59.1, chromium)

```
29 passed (1.0m) → exit 0
```

Real servers: `make run-backend` (:8080) and `make run-frontend` (:3000), both started fresh with `reuseExistingServer: false`. `node ./scripts/check-local-listener.mjs` returned 0, so the suite ran rather than skipping.

The backend log shows genuine authenticated journeys (`/users/me` 401→200, `/users/logout` 200, `/users/:id/profile` 200, `/chats` 200, `/ws` 200). Recurring `failed to load post: sql: no rows in result set` → `GET /api/v1/posts/7 404` entries are the deliberate missing-resource case in a test that asserts the 404, not an error.

### 5.5 Go frontend server tests

```
GOCACHE=.tmp/go-cache GOTMPDIR=.tmp/go-tmp go test ./cmd/frontend/...
ok  forum/cmd/frontend  0.011s
?   forum/cmd/frontend/config  [no test files] → exit 0
```

Covers the proxy and SPA-fallback behavior ([routes_proxy_test.go](../../cmd/frontend/routes_proxy_test.go), [server_test.go](../../cmd/frontend/server_test.go)).

### 5.6 Supporting commands

DOM-coupling measurement (§2.3):

```bash
for f in $(find SPA/core SPA/features SPA/main.js -name '*.js' | sort); do
  echo "$(grep -c 'innerHTML\|querySelector\|addEventListener\|documentRef\|createElement\|classList\|\.dataset' "$f") $f"
done | sort -rn
```

Reference scan (§4.1; inspect matches and verify each target before counting broken Markdown links):

```bash
rg -n 'pr-message|good-practices/README\.md|forum/README\.md#Communication' \
  docs .github .agents --glob '*.md'
```

### 5.7 The removed `6262f7b` commit

The single baseline failure in §5.3 was not a code defect and not a test defect. It was a consequence of premature documentation removal, corrected on `main` before this ticket closed.

**What happened, from Git history.**

| Commit | Effect |
|---|---|
| `b295348` | Imported the forum baseline — **including** `docs/SDS.md`, `docs/PRD.md`, `docs/audit.md`, `docs/README.md`, `docs/track-c.md`, `docs/track-d.md` |
| `100094a` | Added the social-network ticket plan under `docs/social-network/` |
| `6262f7b` *(removed)* | Deleted those six forum documents and moved `docs/social-network/*` up to `docs/` |

`main` now ends at `100094a`. `6262f7b` was first reverted and then, at the owner's direction, removed from the visible history altogether (`git reset --hard 6262f7b^` plus `git push --force-with-lease`), so neither it nor its revert appears in the log. The resulting file tree is byte-identical either way; only the history differs. This branch was rebuilt on the corrected `main` so it does not retain the commit in its ancestry.

**Why the 2026-09-17 import verification reported 473/473 while the first discovery pass failed.** The verification ran before `6262f7b`, when `docs/SDS.md` still existed. [docs-consistency.test.js](../../SPA/tests/unit/docs-consistency.test.js) is byte-identical at `b295348`, at `6262f7b` and now (`sha256 249552b6…`), so the test never changed — only the file it reads disappeared, then came back. The two results are consistent readings taken either side of the deletion.

**Why removal rather than a test change.** `6262f7b` was committed directly to `main` and deleted inherited documentation ahead of the decisions that should govern it. Under the ticket plan, SN-A01 is discovery-only and explicitly does not authorize file removal; documentation cleanup belongs to [SN-A08](track-a.md#sn-a08--align-active-project-documentation), after SN-B02. The deletion was therefore out of sequence, and undoing it restores the documented process as well as the files.

An earlier attempt on this branch retargeted the failing assertion at `architecture.md` and repaired ~30 dangling links by hand. **That work was discarded**: it treated the symptom, and every one of those edits was SN-A08 scope. Restoring the baseline fixed all of it with no documentation or test edit at all — confirmed by §5.3 running green against the unmodified test file.

**Verified at this revision:** `docs/SDS.md` is present (20,843 bytes), `bun run test` reports 473/473, and the reference scan identifies the 33 unresolved relative Markdown links classified in §4.1.

### 5.8 `make test` — the full CI gate

```
make test   → exit 0
```

Chains `build → lint → fmt-check → vet → test-backend → test-race → test-frontend → test-e2e`, which is exactly what [.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs. Every phase passed:

| Phase | Result |
|---|---|
| `build` (both servers) | pass |
| `lint` (Biome) | pass |
| `fmt-check` (gofmt) | ✅ gofmt clean |
| `vet` | pass |
| `test-backend` | `ok` for `internal/db` 1.4s, `internal/handlers`, `internal/middleware`, `internal/tests` 30.7s, `internal/ws`, `cmd/frontend` |
| `test-race` | `ok` for `cmd/frontend` 1.0s, `internal/ws` 1.1s, `internal/middleware` 2.3s, `internal/handlers` 1.0s, `internal/db` 19.2s — no data races |
| `test-frontend` (Vitest) | 51 files, **473/473** |
| `test-e2e` (Playwright) | **29/29**, 15.3s |

The backend and `-race` results are recorded as evidence that this branch leaves the backend untouched; interpreting them as a backend baseline is SN-B01's work, not this ticket's.

### 5.9 Not run

- `make docker-build` — out of scope; the Dockerfile builds `./cmd/backend` only, with no frontend image ([Dockerfile:20](../../Dockerfile#L20)). Relevant to SN-A02's runtime-boundary decision.

---

## 6. Which tests protect behavior worth retaining

For SN-A02/SN-A03: these are the assertions that encode a contract rather than an implementation detail, and should survive a framework port in some form.

| Test | Protects | Survives a port? |
|---|---|---|
| [policy/csp-conformance.test.js](../../SPA/tests/unit/policy/csp-conformance.test.js) | No inline `<script>` / `on*` handlers — enforces `script-src 'self'` | **Yes, unchanged.** A framework-choice guardrail — keep it running during the port. |
| [policy/spa-import-paths.test.js](../../SPA/tests/unit/policy/spa-import-paths.test.js) | No imports reach back into `web/static/` or `/static/js/` | Yes, while `SPA/` exists |
| [core/router/routes.test.js](../../SPA/tests/unit/core/router/routes.test.js) | Route matching + legacy `/view-post/:id`, `/post/:id` rewrites | **Yes as a spec** — the rewrites are the only executable record of that behavior |
| [core/state/session.test.js](../../SPA/tests/unit/core/state/session.test.js), [core/api/session.api.test.js](../../SPA/tests/unit/core/api/session.api.test.js) | Identity resolution, dedup, non-caching of failures | Yes — logic is DOM-free |
| [features/auth/auth.handlers.test.js](../../SPA/tests/unit/features/auth/auth.handlers.test.js) | Login identifier heuristic, registration payload shape, error envelope | **Yes as a contract spec.** Re-verify against SN-B02; the `@` heuristic may change. |
| [core/realtime/chat-socket.test.js](../../SPA/tests/unit/core/realtime/chat-socket.test.js), [chat-socket.reconnect.test.js](../../SPA/tests/unit/core/realtime/chat-socket.reconnect.test.js) | Frame→event mapping, backoff, unknown-frame tolerance | Yes — the socket is DOM-free apart from dispatch |
| [features/chat/chat.roster.logic.test.js](../../SPA/tests/unit/features/chat/chat.roster.logic.test.js) | Roster ordering (history-first, then alphabetical) | Yes — pure logic, and the requirement is product-level |
| [core/app/create-app.test.js](../../SPA/tests/unit/core/app/create-app.test.js) | Access control, redirects, 401 handling, logout finalization | **Assertions yes, harness no.** The rules are the spec; the DOM mock is disposable. |
| [e2e/tickets.test.js](../../SPA/tests/e2e/tickets.test.js) (A02–A10) | Deep links, refresh, back/forward, shell persistence, logout, proxy | **Yes — highest value.** Framework-agnostic browser-level assertions; they are the natural regression gate for SN-A03's route smoke tests. |
| [e2e/chat.test.js](../../SPA/tests/e2e/chat.test.js) | Two-context live DM delivery | Yes |
| [unit/docs-consistency.test.js](../../SPA/tests/unit/docs-consistency.test.js) | Docs match code | **Rewrite during the port.** Passing at this revision (§5.3), but asserts against forum docs. |
| `features/*/​*.views.test.js`, `*.page.test.js` | Rendered markup and DOM wiring | **No.** Tied to the current markup; expect to rewrite wholesale. |

---

## 7. Open questions for SN-A02

Recorded, not answered — all are decisions, not discovery findings.

1. **Framework vs. CSP.** `script-src 'self'` with no `'unsafe-inline'`/`'unsafe-eval'` (§3.6) constrains the **production bundle** — no inline `<script>`, no `on*` handlers, no runtime `eval` template compilation. It does not constrain a dev server, which does not run behind the Go frontend server. Which candidates emit a compliant production build is SN-A02's comparison to make.
2. **Chat is layout, not route** (§1.2). A framework with nested layouts changes this structurally. Does chat become a persistent layout slot, a route, or an overlay?
3. **Two containers vs. shared upload filesystem** (§3.4 item 5). `/static/uploads/` is written by the backend and read from the frontend server's disk. The [docker requirement](requirements.md#docker) mandates separate images. Shared volume, backend-served uploads, or object storage?
4. **Legacy path rewrites** (§1.2). Do `/view-post/:id` and `/post/:id` survive?
5. **Registration field set** (§3.3). Age+Gender+Username today vs. DOB + optional Avatar/Nickname/About Me required. Data-model change — sequence with SN-B02.
6. **Four hardcoded `/api/v1` literals** (§3.1). Consolidate onto `API_BASE` during the port, or leave?
7. **`bun.lock` drift** (§5). A plain `bun install` against the committed lockfile rewrites it (1 insertion, 3 deletions). Reverted here rather than committed silently, but it will recur on every fresh setup until someone decides whether the committed lockfile is stale.
