# Social Network

A Facebook-like social network built for the [Zone01 social-network assignment](docs/social-network/requirements.md): a Vue 3 single-page app served by a Go frontend server, and a Go/SQLite backend, shipped as two Docker images.

**Status:** Phases 1–5 are complete. Phase 6, final acceptance and delivery, is still roadmap-only. The [active tracker](docs/social-network/ticket-tracker.md) records each ticket's verification evidence.

## Features

- **Accounts:** registration with email, password, first/last name, date of birth and optional avatar, nickname and about me. Login uses sessions and HTTP-only cookies, and logout is in the header on every page.
- **Profiles and followers:** public or private profiles. Following a public user is immediate; following a private user sends a request they accept or decline. Profiles show user details, posts, followers and following, but only to followers when the profile is private.
- **Posts and comments:** JPEG, PNG or GIF images on posts and comments. Posts can be public, followers-only or visible to chosen followers.
- **Groups:** browse and create groups, invite members, and send join requests that the creator decides. Members get members-only posts and comments, and events with Going / Not going responses.
- **Chat:** private messages between users where at least one follows the other, delivered live over WebSockets. Each group has its own chat room, and an emoji picker is built in.
- **Notifications:** visible on every page and kept separate from message counts. Triggers are follow requests, group invitations, join requests and new events, plus post/comment reactions and comments.

## Run with Docker

Docker must already be running. Then:

```sh
./run_docker.sh           # build both images, start both containers, open the app
```

or, step by step:

```sh
make stack-up             # build both images; start backend and frontend
# Open http://localhost:3000
docker ps -a              # two containers: social-network-backend-1 and social-network-frontend-1
make stack-down           # stop and remove containers; accounts and media are kept
```

Open the app at **http://localhost:3000**; `http://127.0.0.1:3000` works too. The backend accepts browser requests and WebSockets only from that origin, treating the loopback names `localhost`, `127.0.0.1` and `[::1]` as one host on the same scheme and port. Only the frontend container publishes a port. It proxies `/api` and `/ws` to the backend container over the Compose network. The [shared runtime guide](docs/social-network/shared-runtime.md) covers ports, data volumes and the test gates.

## Structure

- `SPA/src/`: Vue 3, Vue Router and Vite frontend. `SPA/tests/` holds its unit, browser and upgrade tests.
- `cmd/frontend/`: Go server for the built SPA, with a same-origin `/api/` and `/ws` proxy and a frontend health endpoint.
- `cmd/backend/`: backend entry point (server).
- `internal/handlers/`, `internal/router/`, `internal/middleware/`, `internal/ws/`: HTTP and WebSocket application layer.
- `internal/db/`: SQLite access. Migrations live in `internal/db/migrations/sqlite/` and run on startup with golang-migrate.
- `docs/social-network/`: requirements, decisions, contracts, tracker and verification records.

## Development

Run `make deps` once. `make test` runs the native gate: build, lint, Go tests and race checks, Vitest and browser tests. `make check` adds both image builds and the real-service browser suite, matching hosted CI. Start with the [project context](docs/social-network/CONTEXT.md), [roadmap](docs/social-network/roadmap.md) and [architecture overview](architecture.md).

## Historical forum material

The imported forum's [requirements](docs/requirements.md), [audit](docs/audit.md), [PRD](docs/PRD.md), [SDS](docs/SDS.md), [ticket tracker](docs/ticket-tracker.md) and [archived entry points](docs/archive/real-time-forum/README.md.txt) remain available to explain inherited code. They do not define the social-network target. The inherited forum's Real-Time Chat Complete claim and Proxy-driven state describe the old vanilla-JS `SPA/` implementation, which was removed on 2026-10-29, not social-network features. See the [inheritance record](docs/social-network/inherited-context.md) for the distinction.
