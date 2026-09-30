# Social Network

This repository is building the [Zone01 social-network assignment](docs/social-network/requirements.md) from an imported real-time-forum codebase. The current implementation is **Phase 1: foundations and account access**. Registration, login, session restoration, logout, avatar storage and separate frontend/backend images have ticketed implementations; [integrated acceptance](docs/social-network/track-a.md#sn-a07--phase-1-integrated-acceptance) is still pending; the shared hosted quality gate has passed. Feed, groups, followers and social chat remain later-phase work, regardless of what the inherited forum code supports.

Start with the [project context](docs/social-network/CONTEXT.md), [active tracker](docs/social-network/ticket-tracker.md) and [roadmap](docs/social-network/roadmap.md). The [architecture overview](architecture.md) describes the active Vue/Go boundary. The [auth contract](docs/social-network/auth-contract.md) defines the approved account and session behavior. The [frontend setup](docs/social-network/frontend-setup.md) and [backend image guide](docs/social-network/backend-image.md) document the independently built images; the [shared runtime guide](docs/social-network/shared-runtime.md) owns combined startup and local/CI commands.

## Current structure

- `SPA/src/`: Vue 3, Vue Router and Vite Phase 1 frontend. `SPA/core/`, `SPA/features/` and their tests are inherited forum migration references, outside the shipped Vue bundle.
- `cmd/frontend/`: Go server for the built SPA, same-origin `/api/` and `/ws` proxy, and frontend health endpoint.
- `cmd/backend/`, `internal/`: Go API, session handling, avatar storage and SQLite persistence.
- `docs/social-network/`: current requirements, decisions, tracker and verification records.

## Development

Run `make deps`, then `make stack-up` for the two-image app at http://localhost:3000; `make stack-down` preserves its data. See the [shared runtime guide](docs/social-network/shared-runtime.md) for prerequisites, isolated test ports and cleanup. `make test` runs native regressions; `make check` adds both image builds and real-service transport smoke, matching hosted CI. Docker must already be running for container commands.

## Historical forum material

The imported forum's [requirements](docs/requirements.md), [audit](docs/audit.md), [PRD](docs/PRD.md), [SDS](docs/SDS.md), [ticket tracker](docs/ticket-tracker.md) and [archived entry points](docs/archive/real-time-forum/README.md.txt) remain available to explain inherited code. They do not define the social-network target. The inherited forum's Real-Time Chat Complete claim and Proxy-driven state describe the old `SPA/` implementation, not completed social-network features. See the [inheritance record](docs/social-network/inherited-context.md) for the distinction.
