# Social Network Architecture

This is the current Phase 1 structure. The [Zone01 requirements](docs/social-network/requirements.md) define the target; the [roadmap](docs/social-network/roadmap.md) separates delivered foundations from future social features. The full imported forum architecture is [archived](docs/archive/real-time-forum/architecture.md.txt).

## Frontend and transport

`SPA/src/` is the shipped Vue 3 application, built by Vite into `SPA/dist/`. Vue Router handles `/login`, `/register` and protected application routes. The frontend Go server in `cmd/frontend/` serves the built bundle and history fallback on port 3000, while proxying same-origin `/api/` and `/ws` requests to the Go backend on port 8080. The browser uses relative URLs and session cookies. `BACKEND_URL` is a server-side frontend setting. The [frontend setup](docs/social-network/frontend-setup.md) records verified commands and image behavior.

`SPA/core/`, `SPA/features/`, and their existing test files are imported forum code kept as migration evidence. They are not part of the Vite entrypoint. No social-network feed, groups or chat feature is claimed complete by their presence.

SN-A09 adds People, social profiles and follower/following lists. SN-A10 adds the shared authenticated notification/request panel and one session-owned `/ws` connection with exponential backoff, focus/60-second recovery, empty-signal refetch and permission invalidation. The [frontend notification record](docs/social-network/frontend-notifications.md) describes lifecycle and ownership. These frontend features use the approved profile/notification contracts; SN-A11 owns their real-service Phase 2 acceptance.

## Backend and data

`cmd/backend/` starts the Go API. `internal/router/` wires HTTP routes, `internal/handlers/` handles requests, and `internal/db/` owns SQLite queries and startup migrations. Account/session behavior follows the [approved auth contract](docs/social-network/auth-contract.md), [storage decision](docs/social-network/data-decision.md) and [backend implementation records](docs/social-network/backend-accounts.md). Sessions are independent per device; logout revokes the presented session. Avatar bytes are backend-owned and retrieved through an authenticated route. The [backend image guide](docs/social-network/backend-image.md) describes persistent storage and image verification.

## Delivery boundary

The frontend and backend build as separate images. SN-B07 owns the combined run and hosted CI gate; SN-A07 owns Phase 1 real-service browser acceptance. Their status is in the [active tracker](docs/social-network/ticket-tracker.md). Inherited endpoints and tables may remain in the repository but do not satisfy later social-network requirements without their own tickets and verification.

## Inherited forum behavior

The imported implementation has a Proxy-driven state store, `notification.new` delivery and a chat socket that reconnects with exponential backoff. These describe the retained forum modules under `SPA/core/` and `SPA/features/`; they are migration reference points, not the Phase 1 Vue runtime. Further detail is in the [archived architecture](docs/archive/real-time-forum/architecture.md.txt).
