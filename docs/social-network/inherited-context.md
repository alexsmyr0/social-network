# Inherited Context — Real-Time Forum

## Provenance and confidence

Recorded on 2026-09-17 from the sibling checkout `../real-time-forum`, relative to the repository root. Source commit: `c7be375` (`ci: run each quality check exactly once via make test`); source working tree was clean.

The social-network checkout was initially empty. At the owner's request, all 302 tracked files were subsequently imported and byte-verified against the source before adding project-context notices to the root README and AGENTS guide. Git history, ignored runtime data, uploads, secrets, build outputs, and installed dependencies were not imported. Links below now resolve within this repository. This remains an inherited baseline, not evidence that social-network requirements are implemented. Verification results are recorded in [planning.md](planning.md).

## Source map

| Source | Context recovered |
|---|---|
| [AGENTS.md](../../AGENTS.md) | Legacy identity, document hierarchy, coding conventions, architecture and historical constraints |
| [README.md](../../README.md) | Maintenance status, feature overview, setup and verification entry points |
| [architecture.md](../../architecture.md) | Layer boundaries, split servers, auth, SPA structure, notification and chat behavior |
| [docs/PRD.md](../../docs/PRD.md) | Forum product scope and retained features; some status text is stale |
| [docs/SDS.md](../../docs/SDS.md) | Existing API contracts, database design, WebSocket events, testing model; some status text is stale |
| [docs/ticket-tracker.md](../../docs/ticket-tracker.md) | Reports all 37 tickets complete; historical delivery record |
| [docs/requirements.md](../../docs/requirements.md) | Previous exercise specification, not social-network requirements |
| [docs/audit.md](../../docs/audit.md) | Previous exercise acceptance checklist, not social-network acceptance |

Detailed legacy tickets are in [track A](../../docs/track-a.md), [track B](../../docs/track-b.md), [track C](../../docs/track-c.md), and [track D](../../docs/track-d.md). Consult them only when investigating their features; they are not the new project's backlog.

## Documented architecture

| Area | Inherited arrangement |
|---|---|
| Backend | Go, standard-library HTTP routing; `cmd/backend` listens on port 8080 |
| Frontend server | Go server in `cmd/frontend`, port 3000; serves the SPA and proxies `/api/` and `/ws` |
| Persistence | SQLite through `mattn/go-sqlite3`; schema and repositories in `internal/db`; database files in `data/` |
| Layering | SQL in `internal/db`, HTTP handling in `internal/handlers`, cross-cutting behavior in `internal/middleware`, routes in `internal/router` |
| Authentication | Server-side sessions and `session_token` cookies; bcrypt passwords; nickname or email login; authenticated content |
| Frontend | Vanilla JS ES modules in `SPA/`; one HTML shell; client routing; feature slices and shared core utilities |
| State | Proxy-based application store with session and presence slices |
| Realtime | Gorilla WebSocket endpoint `/ws`; in-memory connection counts for presence; persisted direct messages |
| Media | Image upload handlers and filesystem storage under `web/static/uploads/` |
| Tooling | Go tests, Bun, Biome, Vitest, Playwright; `make test` is the documented aggregate verification command |

Existing tables described in the docs include users, sessions, posts, comments, categories, drafts, reactions, notifications, and private messages. Their presence does not establish the new follower, privacy, membership, or event models.

## Features reported as delivered

- Registration, nickname/email login, cookie sessions, authenticated app shell, globally reachable logout.
- Posts, comments, categories, post/comment images, reactions, drafts, and a personal activity view.
- Basic user profile pages showing the old registration fields.
- Private chat roster, live presence, WebSocket delivery, persisted history, ten-message history pagination, unread indicators, reconnection, and DM image attachments.
- Notifications for reactions and comments, unread count, dropdown, and mark-read actions.
- Architecture documentation describes `notification.new` WebSocket signals that trigger refetching, with a 60-second fallback refresh while visible.

Reuse candidates include authentication plumbing, repository/handler patterns, media validation, WebSocket infrastructure, and relevant tests. Reuse remains subject to code review against the new requirements, especially access control.

## Legacy contracts worth locating after import

- Auth: `POST /api/v1/users/register`, `/login`, `/logout`; `GET /api/v1/users/me`.
- Content: `/api/v1/posts`, `/api/v1/comments`, `/api/v1/users/activity`.
- Profiles: `GET /api/v1/users/{userID}/profile`.
- Chat: `GET /api/v1/chats`, `GET /api/v1/chats/{userID}/messages`, `POST /api/v1/chats/{userID}/images`.
- WebSocket events: `dm.send`, `dm.message`, `presence.snapshot`, `presence.update`, `chat.error`; architecture also documents `notification.new`.

These are inherited interfaces to inspect, not approved social-network API contracts.

## Documentation conflicts and spot checks

| Evidence | Interpretation / follow-up |
|---|---|
| Tracker reports 37/37 complete; PRD/SDS introductions still list B04, C05, C06 and chat UI work as pending | Treat those pending summaries as stale; verify actual functionality after import rather than carrying either status forward as proof |
| README summarizes three completed waves; tracker details six | Preserve the concrete 37-ticket completion claim as historical context, not a new delivery plan |
| PRD calls notifications polling-based; architecture and SDS describe WebSocket push with fallback | Record both the disagreement and the newer documented mechanism; confirm code before changing it |
| AGENTS restricts WebSockets to chat and mandates vanilla JS | These are forum-specific constraints; they do not govern the new assignment |
| Tracker retains a create-post full-page-navigation caveat despite marking B04 complete | Verify the current route behavior before relying on that note or deleting it |
| [sessions.go](../../internal/db/sessions.go) defines a 12-hour session duration | Explicit code spot check; reconcile with the new stay-logged-in-until-logout requirement |
| [migrate.go](../../internal/db/migrate.go) contains procedural schema migrations | Migration logic exists; this does not prove compliance with the new dedicated migration-file organization |
| [Makefile](../../Makefile) labels Docker tooling as backend-only | Separate running servers do not establish the two required Docker images; verify packaging after import |
| [posts_helpers.go](../../internal/handlers/posts_helpers.go) lists JPEG, PNG and GIF MIME types | Useful upload reuse evidence; verify all required post/comment/avatar flows separately |

## Before legacy cleanup

Keep this summary in the social-network section. Preserve any additional useful API, schema, setup, or testing detail before its source is removed. Rewrite stale project identity and contradictory constraints when the imported files are available; do not blindly apply the old ticket process or feature scope.

See [planning](planning.md) for the new requirement gaps and decisions that remain open.
