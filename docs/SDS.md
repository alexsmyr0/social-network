# Real-Time Forum SDS

## 1. Overview

This document defines the technical design for converting the current forum into the target real-time forum.

The chosen direction is:

- keep the current split frontend and backend server topology
- replace the current multi-page frontend with a single-page application shell
- require authentication for forum usage
- keep useful existing features where they do not block the target requirements
- implement private messaging as a minimal one-to-one system

## 2. Current Technical Baseline

The current codebase is a Go application with:

- a frontend server that serves static assets and HTML templates
- a backend API server under `/api/v1`
- SQLite persistence
- session-cookie authentication
- REST endpoints for posts, comments, reactions, drafts, notifications, and activity
- WebSocket-pushed notifications, with a slow interval retained only as a
  safety net for rows created while the socket was down

The current implementation has advanced significantly toward the target state. Remaining gaps include:

- the chat roster API is not yet implemented (C05 pending)
- realtime DM send and delivery is not yet implemented (C06 pending)
- post create and edit flows are still placeholder SPA views (B04 pending)
- chat roster, conversation panel, and browser WebSocket integration on the frontend are pending (D01, D02, D04 pending)

## 3. Target Architecture

## 3.1 Project Structure

```
cmd/
  backend/           → Backend API server (port 8080)
  frontend/          → Frontend server (port 3000) — serves SPA + proxies API/WS
internal/
  db/                → Persistence layer (SQLite, repository functions, schema)
  handlers/          → HTTP handlers (REST API under /api/v1)
  middleware/        → Request middleware (auth, logging, CORS, recovery)
  router/            → Route registration
  tests/             → Backend integration tests
web/
  static/            → CSS, JS, images, sounds, uploads (legacy multi-page assets)
  templates/         → HTML templates (legacy)
SPA/                 → Single Page Application Shell (Vanilla JS ES2026+)
  index.html         → SPA Entrypoint
  main.js            → Bootstrap Application Logic
  assets/            → Global CSS & Static Images
  core/              → State, Router, and API Logic
  components/        → Shared UI Elements
  features/        → Domain Slices (each with its {feature}.views.js)
  tests/           → Vitest shared test suite
    unit/          → Isolated logic tests
    integration/   → Feature and interaction tests
    e2e/           → User journey tests
data/                → SQLite database file
docs/                → Project documentation (PRD, SDS, tickets)
```

The project uses a **split-server** topology:
- **Frontend server** (`:3000`): serves the single HTML shell, static assets, and proxies `/api/` and `/ws` to the backend.
- **Backend server** (`:8080`): owns business logic, persistence, REST APIs, and WebSocket endpoint.

## 3.2 High-Level Design

- Frontend server responsibilities:
  - serve one HTML app shell
  - serve static assets
  - proxy `/api/` requests to the backend
  - proxy `/ws` connections to the backend
- Backend server responsibilities:
  - own business logic and persistence
  - serve authenticated REST APIs
  - expose a WebSocket endpoint for presence and direct messages

## 3.3 Frontend Runtime Model

- The frontend uses one root HTML document.
- The frontend owns route changes in JavaScript.
- The authenticated app shell persists across route changes.
- The app shell contains:
  - header and logout control
  - route outlet for page content
  - persistent direct-message roster and active-chat area

## 3.4 Backend Runtime Model

- REST remains the transport for standard CRUD flows.
- WebSocket is added only for presence and private messaging in this phase.
- Session-cookie authentication remains the source of truth for both HTTP and WebSocket access.

## 4. Data Model Changes

## 4.1 Users

Extend the `users` table with:

- `age INTEGER NOT NULL`
- `gender TEXT NOT NULL`
- `first_name TEXT NOT NULL`
- `last_name TEXT NOT NULL`

Notes:

- `username` remains the nickname shown in the forum and chat
- existing users must be migrated safely

## 4.2 Private Messages

Add a new `private_messages` table:

```sql
CREATE TABLE private_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (sender_id <> recipient_id),
  CHECK (length(trim(body)) > 0)
);
```

Required indexes:

- `(sender_id, recipient_id, created_at DESC)`
- `(recipient_id, sender_id, created_at DESC)`
- optional pair-query support index if message lookup shows performance issues

No separate conversations table is introduced in this phase.

## 4.3 Presence

Presence is not stored in SQLite.

Presence is kept in memory as authenticated WebSocket connection state:

- `userID -> active connection count`

Online rule:

- a user is online when active connection count is greater than zero

## 4.4 DM Image Attachments (Bonus)

Extend the `private_messages` table with an optional image column:

- `image_path TEXT DEFAULT NULL`

When an image is attached to a DM:

- the image is uploaded via multipart form to a new REST endpoint
- the image file is saved to `web/static/uploads/dm/`
- `image_path` stores the relative URL path (e.g., `/static/uploads/dm/<filename>`)
- the `dm.message` WebSocket event includes the `image_url` field when present

## 5. API Design

## 5.1 Existing Endpoint Changes

- All forum content endpoints that currently allow optional auth become authenticated forum endpoints.
- Login remains `POST /api/v1/users/login`.
- Registration remains `POST /api/v1/users/register` but accepts the extended payload.
- Logout remains `POST /api/v1/users/logout`.
- `GET /api/v1/users/me` remains the bootstrap auth-check endpoint for the SPA.

## 5.1.1 Post Create Request Body

`POST /api/v1/posts` accepts:

```json
{
  "title": "string (required)",
  "content": "string (required)",
  "category_ids": [1, 2],
  "status": "draft | published"
}
```

- `status` defaults to `"published"` when omitted.
- `"draft"` posts skip the category requirement; `"published"` posts require at least one category.
- A draft can be promoted to published via `PATCH /api/v1/posts/{id}` with `{"status": "published"}`.

## 5.2 Registration Payload

Request:

```json
{
  "username": "alex",
  "email": "alex@example.com",
  "password": "password123",
  "age": 24,
  "gender": "male",
  "first_name": "Alex",
  "last_name": "Smyro"
}
```

Validation rules for implementation:

- `username`: existing rules stay in place
- `email`: existing rules stay in place
- `password`: existing rules stay in place
- `age`: integer, positive
- `gender`: required non-empty string
- `first_name`: required non-empty string
- `last_name`: required non-empty string

## 5.3 Chat Roster Endpoint

`GET /api/v1/chats`

Purpose:

- return all other users for the current user
- include presence and last-message metadata for roster sorting

Response shape:

```json
{
  "data": [
    {
      "user_id": 12,
      "username": "maria",
      "is_online": true,
      "last_message_at": "2026-04-09T14:20:00Z",
      "last_message_preview": "see you soon",
      "last_sender_id": 7
    }
  ]
}
```

Sorting rules:

- users with message history come first, sorted by `last_message_at DESC`
- users without message history come after, sorted by `username ASC`

## 5.4 Chat History Endpoint

`GET /api/v1/chats/{userID}/messages?before_id=<messageID>&limit=10`

Behavior:

- without `before_id`, return the latest 10 messages in the pair
- with `before_id`, return the 10 messages older than that message
- response must be returned oldest-to-newest for direct rendering

Response shape:

```json
{
  "data": {
    "messages": [
      {
        "id": 91,
        "sender_id": 7,
        "recipient_id": 12,
        "sender_username": "alex",
        "body": "hello",
        "created_at": "2026-04-09T14:21:00Z"
      }
    ],
    "has_more": true
  }
}
```

## 5.5 WebSocket Endpoint

`GET /ws`

Requirements:

- only authenticated users may connect
- session cookie is validated during upgrade
- multiple tabs for the same user are allowed

### Client-to-Server Events

```json
{
  "type": "dm.send",
  "payload": {
    "recipient_id": 12,
    "body": "hello"
  }
}
```

### Server-to-Client Events

Presence snapshot:

```json
{
  "type": "presence.snapshot",
  "payload": {
    "users": [
      { "user_id": 12, "is_online": true }
    ]
  }
}
```

Presence update:

```json
{
  "type": "presence.update",
  "payload": {
    "user_id": 12,
    "is_online": false
  }
}
```

Direct message:

```json
{
  "type": "dm.message",
  "payload": {
    "id": 91,
    "sender_id": 7,
    "recipient_id": 12,
    "sender_username": "alex",
    "body": "hello",
    "created_at": "2026-04-09T14:21:00Z"
  }
}
```

Error:

```json
{
  "type": "chat.error",
  "payload": {
    "code": "RECIPIENT_OFFLINE",
    "message": "recipient is offline"
  }
}
```

## 5.6 User Profile Endpoint (Bonus)

`GET /api/v1/users/{userID}/profile`

Purpose:

- return public profile data for the specified user

Response shape:

```json
{
  "data": {
    "user_id": 12,
    "username": "maria",
    "first_name": "Maria",
    "last_name": "Smith",
    "age": 25,
    "gender": "female"
  }
}
```

## 5.7 DM Image Upload Endpoint (Bonus)

`POST /api/v1/chats/{userID}/images`

Purpose:

- upload an image to be attached to a DM
- the image is saved to disk and a URL is returned
- the sender then includes the image URL in the `dm.send` WebSocket event

Request:

- `multipart/form-data` with a single `image` field
- same validation rules as post/comment image uploads (max size, allowed types)

Response shape:

```json
{
  "data": {
    "image_url": "/static/uploads/dm/abc123.jpg"
  }
}
```

## 6. Backend Processing Rules

## 6.1 Message Send Rules

On `dm.send`:

- validate authenticated sender
- validate `recipient_id`
- reject self-send
- reject empty message body
- reject recipient if offline
- persist the message
- emit `dm.message` to sender and recipient
- update roster ordering for both affected users

## 6.2 Presence Rules

- increment connection count on successful WebSocket connect
- decrement on disconnect
- emit `presence.update` only on state transition:
  - offline -> online
  - online -> offline

## 6.3 Auth Rules

- HTTP session cookie remains the only auth mechanism
- forum data endpoints require valid session
- WebSocket upgrade rejects invalid or expired sessions
- OAuth is not part of the target product design

## 7. Frontend Design

## 7.0 Tooling & Practices (ES2026+)

- The frontend must be implemented in modern vanilla JS (ES2026+) using optimal best practice patterns.
- **Folder Structure**: Follow Clean Vertical Slices / Screaming Architecture inside `SPA/`. The structure is organized as follows:
  - `SPA/components/`: Shared, reusable UI components (e.g., buttons, modals, cards).
  - `SPA/features/`: Vertical slices for major application domains (e.g., `auth/auth.views.js`, `feed/feed.views.js`, `chat/chat.views.js`, `post/post.views.js`, `profile/profile.views.js`). Each slice contains its own logic, components, and tests.
  - `SPA/core/`: Application-wide infrastructure:
    - `api/`: API clients and service definitions.
    - `router/`: Client-side routing logic.
    - `state/`: Proxy-based reactive global state. `state/store.js` exposes `createStore()` — a `Proxy` whose `set` trap notifies subscribers, with `get` / `set` / `subscribe` / `reset` and `Object.is` change gating so a no-op write wakes nobody. `state/app-state.js` holds the single application instance and `resetAppState()`; the `session` slice owns `isAuthenticated` and the signed-in user id, and the `presence` slice owns the set of online user ids and the bridge that feeds it from the WebSocket presence frames.
    - `utils/`: Shared helper functions.
  - `SPA/assets/`: Static assets such as global CSS, images, and sounds.
  - `SPA/index.html`: The single entry point for the application.
  - `SPA/main.js`: The main JavaScript bootstrap file.
- Bun is the required runtime and package manager for frontend dev tools.
- Biome handles all linting, formatting, and static testing checks.
- Vitest provides the test runner for unit, integration, and end-to-end (E2E) tests, with all files residing in `SPA/tests/`.

## 7.1 SPA Routes

Required client routes:

- `/login`
- `/register`
- `/`
- `/posts/:id`
- `/create-post`
- `/edit-post/:id`
- `/activity`
- `/profile/:id` (bonus)

The frontend server still serves one shell for these routes.

## 7.2 App Boot

On application load:

1. render SPA shell
2. call `GET /api/v1/users/me`
3. if `401`, render auth routes only
4. if authenticated, render forum shell and open WebSocket connection

## 7.3 Feed Behavior

- fetch and render posts only
- remove comment preview rendering from feed cards
- clicking a post routes to post detail

## 7.4 Post Detail Behavior

- fetch one post
- fetch and render comments only in this route
- comment creation remains here
- post and comment reaction controls render in this route (see 7.4.2)

## 7.4.1 Activity Behavior

- `/activity` renders inside the shared authenticated shell outlet
- the SPA router (`SPA/core/router/routes.js`) matches the route and
  `renderActivityView()` from `SPA/features/activity/activity.views.js`
  is injected through the standard render-template flow
- `runRouteInitializer` boots `initActivityPage()` from
  `SPA/features/activity/activity.page.js`
- activity data is loaded from `GET /api/v1/users/activity` with
  `page`, `per_page`, and optional `status` query parameters
- four collapsible sections are rendered: created posts, comments,
  liked posts, disliked posts
- created posts that belong to the current user expose owner-only
  controls: status toggle (draft/published), edit (SPA navigation to
  `/edit-post/:id?next=%2Factivity`), and delete
- comments expose inline edit (reuses the shared image picker) and
  delete
- filter and pagination changes update history via
  `history.replaceState` rather than full reload
- mutations (status toggle, post delete, comment edit, comment delete)
  trigger an in-place `refresh()` instead of a document navigation
- the standalone `web/templates/activity.html` template and
  `web/static/js/activity/*` scripts no longer exist

## 7.4.2 Reaction Behavior

- post and comment reactions are handled entirely inside the SPA by the
  reaction engine in `SPA/features/post/` (`post.reactions.bindings.js`,
  `post.reactions.logic.js`, `post.reactions.api.js`)
- `initReactionBindings()` attaches one delegated `change` listener to
  `document`; a module-level guard makes it idempotent, so the feed,
  post-detail, and activity pages can each call it without producing
  duplicate listeners
- the listener is bound at the document level, so it survives SPA route
  transitions and re-rendered comment lists without re-binding; there is
  no `DOMContentLoaded` or standalone-template boot logic
- reaction pill markup is shared by `renderPostReactions` /
  `renderCommentReactions` (`post-card.views.js`) across the feed,
  post-detail, and activity views
- `normalizeReactionState()` reconciles both backend payload shapes —
  list/detail (`likes` / `dislikes` / `my_reaction` int) and the reaction
  POST response (`likes_count` / `dislikes_count` / `reaction`) — into a
  canonical `{ likeCount, dislikeCount, userReaction }` so active state
  and counts render uniformly
- reaction scope is resolved by the `data-post-id` / `data-comment-id`
  attribute rather than a fixed element tag, so the feed/activity
  `<article data-post-id>` and the post-detail `<section data-post-id>`
  both resolve; comment scope resolves via the `.comment` /
  `.activity-comment` class
- toggling posts to `POST /api/v1/posts/:id/{like,dislike}` or
  `POST /api/v1/comments/:id/{like,dislike}`; the returned counts update
  in place with no full page reload, and the optimistic checkbox flip is
  reverted if the request fails or the user is unauthenticated
- backend reaction contracts are unchanged

## 7.5 Chat UI Behavior

- roster is visible on every authenticated route
- selecting a user loads latest history
- composer is enabled only when selected user is online
- history pagination loads 10 older messages at a time
- scroll-triggered pagination uses throttle or debounce
- incoming messages append live when the conversation is active
- inactive conversation updates still refresh roster ordering and unread state if implemented later

## 8. Migration Strategy

- add schema migration for user-profile columns and `private_messages`
- ensure existing users remain valid after migration
- if existing rows need default values for new profile fields, migrate safely and require completion at next profile-edit or through a one-time data policy decided during implementation
- retain existing tables for drafts, reactions, notifications, and activity
- the unused `oauth_users` table has been dropped from the schema; databases
  written before that keep the orphaned table, which nothing reads
- emails are stored folded to lower case, and `Migrate` folds legacy rows so an
  address registered with capitals can still authenticate

## 9. Implementation Constraints

- keep the split frontend and backend servers
- do not introduce a frontend framework unless later planning explicitly chooses one
- do not replace the current notification system in this phase
- do not introduce a generalized conversation model

## 10. Testing Strategy

## 10.1 Backend Tests

- registration with extended fields
- login with username
- login with email
- forum endpoint rejection for unauthenticated users
- message persistence between two users
- latest-10 history query
- older-history query with `before_id`
- roster ordering with and without prior messages
- offline-recipient rejection
- presence transitions with connect and disconnect
- multi-connection same-user presence correctness

## 10.2 Frontend Tests

- SPA route transitions without full page reload
- auth gating on app boot
- logout visible from every authenticated route
- feed contains no comments
- post detail contains comments
- activity route mounts inside the shared shell and refreshes without
  full reload on deep-link or back/forward navigation
- chat roster sorting behavior
- disabled composer for offline selected user
- live message rendering on active chat
- throttled or debounced history loading during upward scroll

### 10.2.1 Test Categories (Vitest framework)

| Category | Description | Location |
| :--- | :--- | :--- |
| **Unit** | Isolated component and helper logic tests. | `SPA/tests/unit/` |
| **Integration** | Feature-level interaction tests (e.g., Auth + Feed). | `SPA/tests/integration/` |
| **E2E** | Multi-step user journey verification using Playwright. | `SPA/tests/e2e/` |

### 10.2.2 E2E Automation (Playwright)

E2E tests use Playwright to verify the full stack (Frontend + Backend) in a real headless browser:
- Direct navigation and SPA routing fallback.
- Auth gating and redirection flows.
- Multi-step user journeys (Login -> Post -> Logout).
- Infrastructure sanity checks (Process management, Proxying).

Run with `make test-e2e`.

## 10.3 Regression Coverage

The retained legacy features must still be verified after the migration:

- post creation and editing
- comments and reactions
- image upload flows
- drafts
- activity view
- current notifications

## 10.4 Bonus Feature Tests

- user profile page renders correct data
- DM image upload saves to disk and returns URL
- DM image renders inline in conversation
- goroutine/channel patterns do not introduce data races (verified with `-race` flag)

## 11. Delivery Notes

This SDS is intentionally scoped to support the next planning step:

- break implementation into tickets
- split tickets across four developer tracks

The main critical path is:

1. SPA shell and auth gating
2. data-model and auth updates
3. WebSocket and direct-message backend
4. persistent chat UI and history loading

## 12. Development and QA Tools

### 12.1 Test Credentials

For local development and manual QA, a test user is included in the database seed (`internal/db/seeds/10_users.sql`).

| Credential | Value |
|:--- |:--- |
| **Nickname** | `tester` |
| **Email** | `tester@example.com` |
| **Password** | `password` |

These credentials can be used to log in immediately after running `make seed-qa`.

