# Track B — Backend, Data and Shared Tooling

Dev 2 owns backend, storage and shared run/CI tooling. Phase 1 only. Status and handoffs live in the [tracker](ticket-tracker.md); follow the [ticket-writing rules](ticket-rules.md).

Output filenames are planned artifacts under this section, not existing files. Decision tickets require recorded owner approval. Test commands are recorded when executed; do not invent framework-specific commands before selection.

## SN-B01 — Backend and data baseline

Source: [Backend](requirements.md#backend), [authentication](requirements.md#authentication) | Phase: 1 | Type: discovery

Goal: Identify reusable backend behavior and account/migration gaps before design changes.

Scope: Read code and disposable fixtures; no production-data inspection, schema changes or resets.

Depends on: None

Blocks: SN-A02

Work:

- Inspect account validation, session/cookie handling, migrations, media, Docker, dependencies and tests.
- Write `backend-baseline.md` with code references, current API examples and the impact of optional nickname/date of birth on callers and seeds.
- Run applicable Go checks; record results and decisions needed for old databases and dependencies.

Verification Gate:

- Report explicitly covers required username, 12-hour expiry, browser-session cookie, procedural migrations and backend-only image.
- Dev 1 can locate the existing API/origin/upload constraints without assuming documentation is current.
- Each failure or unknown has a recorded disposition; no legacy completion claim substitutes for evidence.

## SN-B02 — Approve auth contracts

Source: [Authentication](requirements.md#authentication), [media](requirements.md#app) | Phase: 1 | Type: decision

Goal: Give both tracks an approved account and session interface.

Scope: Define external behavior; storage/schema/tooling decisions belong to SN-B08, implementation to later tickets.

Depends on: SN-A02

Blocks: SN-B08, SN-A04, SN-A05, SN-A08

Work:

- Write `auth-contract.md` for register/login/logout/current-user and avatar requests, responses, error codes, validation and limits.
- Specify optional nickname/display fallback, required date of birth, avatar ownership/upload sequence, and partial-failure cleanup behavior.
- Define persistence until explicit logout, cookie/origin protections, revocation, browser restart and concurrent-session behavior under SN-A02 transport constraints.

Verification Gate:

- Owner approves interfaces and session policy; Dev 1 confirms valid/invalid examples can drive independent UI fixtures.
- Required-only registration, optional fields, duplicate email, invalid upload, network failure and logout outcomes are unambiguous.
- Record cookie/server persistence tests beyond the old 12-hour cutoff. Approval does not wait for schema design, migrations or real APIs.

## SN-B08 — Approve account storage and migration design

Source: [SQLite](requirements.md#sqlite), [migrations](requirements.md#migrate), [allowed packages](requirements.md#allowed-packages) | Phase: 1 | Type: decision

Goal: Approve the smallest storage design that implements the auth contract.

Scope: Account/session/avatar storage and migration policy only; no future social-feature tables or code changes.

Depends on: SN-B02

Blocks: SN-B03

Work:

- Write `data-decision.md` with account/session fields, constraints, avatar storage/access mapping and migration library/layout/startup entry point.
- Compare preserving existing databases with an explicit fresh-start policy; record owner choice, failure/recovery behavior and seed isolation.
- Map every SN-B02 field to storage, including missing legacy birthdates and optional nicknames. Never invent personal data.

Verification Gate:

- Owner approval and alternatives are recorded; chosen Go dependencies satisfy the assignment allowlist.
- Schema and storage can represent every approved request/session state; Dev 1 reviews any client-visible consequence.
- Fresh, repeated, failed and legacy-startup cases have expected outcomes; no API change is hidden inside this decision.

## SN-B03 — Startup migrations and account schema

Source: [Migrations](requirements.md#migrate), [authentication](requirements.md#authentication) | Phase: 1 | Type: implementation

Goal: Start the backend with the approved account schema using repeatable migrations.

Scope: Schema/startup and compatibility adapters only; request validation and session behavior belong to SN-B04/SN-B05.

Depends on: SN-B08

Blocks: SN-B04

Work:

- Add dedicated migration files and apply outstanding changes before serving requests; reconcile embedded/procedural schema ownership.
- Implement SN-B08 schema and data policy, including fixtures and minimal compatibility changes needed for retained code to compile.
- Keep QA reset/seeding outside normal startup; document migration failure and recovery.

Verification Gate:

- SQLite integration tests pass for empty startup, second startup without duplicate changes, and failed migration preventing service readiness.
- Upgrade fixtures preserve required relationships if preservation was approved; otherwise old databases receive the explicit approved handling without silent deletion.
- Constraint tests cover required/optional account fields and valid session storage; affected repository regressions pass.

## SN-B04 — Registration and account API

Source: [Authentication](requirements.md#authentication) | Phase: 1 | Type: implementation

Goal: Create accounts with the new required fields and optional text fields.

Scope: Account validation, persistence and serialization; avatar processing is SN-B09, final session lifecycle is SN-B05.

Depends on: SN-B03

Blocks: SN-B05

Work:

- Implement names/email/password/date-of-birth and optional nickname/about-me under SN-B02; adapt affected account serializers and callers.
- Preserve password hashing and implement documented uniqueness/validation errors without legacy age/gender requirements.
- Keep registration's existing session call working until SN-B05; do not claim final persistence yet. An omitted avatar must succeed; supplied avatars must not be silently discarded before SN-B09.

Verification Gate:

- API/repository tests pass for required-only registration, optional text, missing required fields, invalid dates/email/password, duplicate email and nickname rules.
- Authorized account reads round-trip stored values without password/hash disclosure; invalid input creates no partial account.
- Real registration works without an avatar; avatar input is explicitly rejected as unavailable until SN-B09 implements the approved flow.

## SN-B05 — Session lifecycle and auth enforcement

Source: [Authentication](requirements.md#authentication), [backend auth](requirements.md#app) | Phase: 1 | Type: implementation

Goal: Keep real accounts authenticated according to policy until explicit logout/revocation.

Scope: HTTP/session/cookie enforcement and retained WebSocket revocation; no new chat features.

Depends on: SN-B04

Blocks: SN-B09

Work:

- Implement SN-B02 login, current-user lookup, persistence and logout using SN-B04 account mappings.
- Align cookie lifetime/attributes with server validity; implement approved origin protections and concurrent-session behavior.
- Check protected HTTP routes and retained sockets cannot perform privileged actions after session revocation.

Verification Gate:

- Tests use real registration plus controlled time to verify valid/invalid login, restored sessions and validity beyond the old 12-hour cutoff.
- Logout revokes the cookie server-side; reuse, missing/invalid cookies and unauthorized-origin writes fail as contracted.
- Cookie flags, concurrent-login behavior and retained-socket revocation tests pass; browser-reopen integration is reserved for SN-A07.

## SN-B09 — Avatar upload and account attachment

Source: [Image handling](requirements.md#app), [authentication](requirements.md#authentication) | Phase: 1 | Type: implementation

Goal: Complete registration with safe, persistent optional avatars.

Scope: Approved registration/avatar flow only; no post/comment media migration or profile editor.

Depends on: SN-B05

Blocks: SN-B06

Work:

- Implement the SN-B02 upload sequence using SN-B08 storage; connect it to real accounts and sessions. Replace SN-B04 temporary avatar rejection.
- Validate image bytes, accepted JPEG/PNG/GIF types, size and attachment ownership; do not trust client filenames/MIME declarations.
- Apply the agreed partial-failure cleanup policy so registration failures and unauthorized associations cannot leak or misassign media.

Verification Gate:

- API tests create accounts both without avatars and with each accepted image type, then read the correct stored reference/content through authorized paths.
- Corrupt, oversized and mismatched payloads fail with contract errors; user A cannot attach/access user B's restricted upload.
- Failed upload/registration and duplicate submission tests demonstrate documented cleanup and no incorrect account association.

## SN-B06 — Backend image and persistent storage

Source: [Docker](requirements.md#docker), [migrations](requirements.md#migrate) | Phase: 1 | Type: packaging

Goal: Run the completed account backend in an image with durable data and media.

Scope: Backend image/storage only; frontend orchestration is SN-B07.

Depends on: SN-B09

Blocks: SN-B07

Work:

- Package executable and required migration assets; document ports, health checks, origins and writable storage configuration.
- Connect persistent database/avatar storage under SN-B08 policy; eliminate reliance on developer-local files.
- Smoke-test real registration, avatar, login/current-user/logout endpoints in the container.

Verification Gate:

- A clean image build starts against empty storage, applies migrations and serves the real account flow.
- Recreating the container with the same storage preserves accounts, session behavior and avatars; repeated migration does not destroy data.
- Invalid migration/storage prevents readiness; normal startup never invokes destructive QA seeds.

## SN-B07 — Shared run and quality gate

Source: [Docker](requirements.md#docker), [roadmap](roadmap.md) | Phase: 1 | Type: integration

Goal: Provide repeatable two-image startup and shared local/CI verification.

Scope: Orchestration, commands and transport smoke tests; full browser acceptance belongs to SN-A07, Git remediation is external.

Depends on: SN-A06, SN-B06

Blocks: SN-A07

External gate: Hosted CI access and a successful run on the clean main history. Report any access/publishing failure; no protection bypass or history rewrite is authorized here.

Work:

- Own shared Makefile/CI/orchestration edits using both image handoffs; isolate test ports/data and document startup/stop/check commands.
- Wire current frontend/backend checks, image builds and cookie/proxy smoke tests into local and hosted gates; preserve applicable regressions and audit new dependencies.
- Provide the browser-test command hook that SN-A07 will extend. Do not require SN-A07 tests to exist to complete this ticket.

Verification Gate:

- Fresh-checkout commands build/start both images; a browser-origin transport smoke test confirms HTTP cookies and retained WebSocket routing with real services.
- Existing targeted suites/image checks pass locally and in hosted CI; record commands/run URL. Publishing failure keeps completion blocked.
- Dev 1 can run the stack without undocumented steps; later acceptance cases can be added without replacing the harness.
