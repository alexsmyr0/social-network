# Track A - Platform, SPA Shell, and Auth

## Mission

Track A owns the platform and auth foundation for the real-time forum:

- single-page shell
- route bootstrapping
- persistent app layout
- registration and login UI
- authenticated-only forum access
- global logout
- user profile page (bonus)

This is the main upstream track. The other tracks should assume Track A is the first shared dependency to land.

## Source Mapping
- A01 -> RTF-00, A02 -> RTF-01, A10 -> RTF-01, A03 -> RTF-03, A04 -> RTF-04, A05 -> RTF-08, A06 -> RTF-09, A07 -> RTF-33 (bonus)

## Suggested Execution Order
1. A01, A02, A03 | 2. A04, A05 | 3. A06 | 4. A07 (bonus)

## Tickets

### A01 - Infrastructure, CI/CD, and Dev Tools Setup
Source: RTF-00 | Phase: P0
Depends on: None
Blocks: A02

Work:
- set up the modern development workflow
- configure Bun as the primary runtime and package manager for frontend dev tools, if not present install it
- configure Biome for fast, precise linting, formatting, and static testing
- set up Vitest for all frontend tests (unit, integration, and E2E)
- Update README.md with dev setup instructions, test commands, CI/CD information, bun commands for running tests, lint, format, and dev server (dep update etc)
- Update makefile to include frontend dev commands for anything important
- configure GitHub Actions with quality gates for PRs (tests, lint, format) ensuring best practices as of 2026.

Verification Gate:
- `bun run lint` and `bun run test` execute correctly
- CI/CD pipeline validates basic PRs
- Biome enforces consistency across code
- All frontend JS requirements (ES2026+) and tools are enforced.

### A02 - Frontend Architecture & Directory Restructuring
Source: RTF-01 | Phase: P0
Depends on: A01
Blocks: A10, D09

Work:
- define and set up the new folder structure for the SPA in the `SPA/` directory
- implement a file organization that follows modern, scalable 2026 patterns (e.g. Screaming Architecture or Vertical Sliced Architecture)
- ensure the layout accommodates components, pages/features, core logic, router, assets, and consolidated tests in `SPA/tests/` separately
- write or update architecture documentation such as `docs/SDS.md` to reflect the new structure clearly
- optimally point the Go server to the new SPA entry point without functionally breaking existing frontend behavior

Verification Gate:
- the directory tree reflects the approved modern structure
- docs reflect the current implementation accurately
- existing functionality behaves as it did before structurally breaking changes

### A10 - Single SPA Shell Entry
Source: RTF-01 | Phase: P0
Depends on: A02
Blocks: D09, A03

Work:
- serve one root HTML shell for the app from the new structure
- stop relying on standalone templates for app routes
- keep static assets and existing API proxy behavior working

Verification Gate:
- the app is served through one HTML document
- direct navigation to supported SPA routes resolves successfully
- static assets load correctly
- `/api/` proxy behavior remains intact

### A03 - SPA Boot and Client Routing
Source: RTF-03 | Phase: P0
Depends on: A10
Blocks: A04, D10, A05, B01, B05

Work:
- add client-side route resolution for auth, feed, post detail, create/edit, and activity
- add initial SPA boot logic
- support browser history navigation and deep-link entry
- Implement using modern vanilla JS ES2026+ with optimal best practice patterns.

Verification Gate:
- route changes happen without full document reloads
- browser back and forward work for supported routes
- pasted route URLs load the expected screen

### A04 - Persistent App Shell Layout
Source: RTF-04 | Phase: P1
Depends on: A03
Blocks: A06, B01, B04, B05, D01, B06

Work:
- build the shared authenticated app frame
- add persistent header and logout location
- add main content outlet and reserved chat sidebar containers

Verification Gate:
- authenticated routes render inside a shared shell
- navigation and logout remain visible during route changes
- layout reserves a stable location for chat

### A05 - Authenticated-Only Forum Access
Source: RTF-08 | Phase: P1
Depends on: A03
Blocks: A06, B01, B04, B05, D04, C08

Work:
- require auth for forum content endpoints
- gate SPA route access using `GET /api/v1/users/me`
- define authenticated vs unauthenticated app boot behavior

Verification Gate:
- unauthenticated users cannot access feed, posts, comments, activity, or chat
- authenticated users enter the forum shell directly
- app boot correctly routes users based on session state

### A06 - Global Logout Across the Forum
Source: RTF-09 | Phase: P1
Depends on: A04, A05
Blocks: D05

Work:
- centralize logout inside the persistent shell
- remove dependence on page-specific layouts
- preserve server-side session invalidation behavior

Verification Gate:
- logout is visible and usable from every authenticated route
- logout clears the session and returns the user to auth flow
- logout no longer depends on create/edit page layout

### A07 - User Profile Page (Bonus)
Source: RTF-33 | Phase: P5 (Bonus)
Depends on: C10, A04, A05
Blocks: D07

Work:
- add `GET /api/v1/users/{userID}/profile` endpoint returning public profile data
- add `/profile/:id` SPA route
- build profile page UI showing nickname, first name, last name, age, and gender
- add profile links from roster entries and user references in posts/comments

Verification Gate:
- navigating to a user profile shows all extended registration fields
- profile is accessible from the chat roster (Blocked by D01) and post/comment author links
- profile data matches what was entered during registration
