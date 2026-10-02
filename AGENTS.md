# Social Network — Coding Agent Guide

Start with [project context](docs/social-network/CONTEXT.md). The [Zone01 requirements](docs/social-network/requirements.md) define the target. Use the [active tracker](docs/social-network/ticket-tracker.md) and [track A](docs/social-network/track-a.md) / [track B](docs/social-network/track-b.md) for dependencies and verification gates. Follow the [ticket-writing rules](docs/social-network/ticket-rules.md) when changing tickets.

The [architecture overview](architecture.md) and [approved decisions](docs/social-network/frontend-decision.md) describe the current Vue 3 frontend and Go/SQLite backend. The [auth contract](docs/social-network/auth-contract.md) controls Phase 1 account/session behavior. Treat inherited forum requirements, audit, PRD, SDS and tickets as historical context only. The full previous guide is [archived](docs/archive/real-time-forum/AGENTS.md.txt); its forum identity, vanilla-JS restriction, feature scope and ticket priorities do not apply to social-network.

Use the caveman skill by default for coding tasks when it is available, as requested by the project owner. Use the frontend-design skill when implementing or changing frontend components, layout or styles. Keep applicable Go layering conventions: SQL in `internal/db/`, HTTP handling in `internal/handlers/`, route wiring in `internal/router/`, and focused tests at the relevant layer. Major architecture choices remain open; agree them with the owner before implementation.

Do not launch Docker Desktop or start the Docker daemon automatically. If Docker is already running, Docker checks may run. Otherwise complete independent checks and report Docker-dependent verification as unverified. Start Docker only when the project owner explicitly asks.

For active work, use the ticket's verification gate. Documentation-only tickets use link, anchor, status and scope checks; they do not claim application validation. Shared runtime setup and CI instructions belong to SN-B07.

The project owner is Dev 1. Owner approval of a contract and its fixture handoff is the single human approval gate; do not ask for a second Dev 1 review or confirmation. Validate fixture completeness and consistency as part of the ticket. New material interface changes require owner approval; already-approved choices do not.
