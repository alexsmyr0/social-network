# Track A — Frontend and Integration

Dev 1 owns frontend, active documentation and integrated acceptance. Phase 1 only. Status and handoffs live in the [tracker](ticket-tracker.md); follow the [ticket-writing rules](ticket-rules.md).

Output filenames are planned artifacts under this section, not existing files. Decision tickets require recorded owner approval. Test commands are recorded when executed; do not invent framework-specific commands before selection.

## SN-A01 — Frontend baseline and documentation inventory

Source: [Frontend](requirements.md#frontend), [authentication](requirements.md#authentication) | Phase: 1 | Type: discovery

Goal: Give both developers a verified frontend starting point and cleanup inventory.

Scope: Inspect and document only; no framework choice, file removal or Git-history changes.

Depends on: None

Blocks: SN-A02

Work:

- Inspect `SPA/`, `cmd/frontend`, package scripts and frontend tests; trace routes, auth boot, uploads and socket ownership.
- Write `frontend-baseline.md` with reuse candidates, DOM-dependent code, contract assumptions and a keep/rewrite/archive/remove documentation inventory.
- Run existing frontend checks; record command, result and any baseline failures. Identify which tests protect behavior that will be retained.

Verification Gate:

- Findings link to code and distinguish observed behavior from unverified claims; Dev 2 can locate every auth/upload assumption.
- Inventory names affected files and references; it is reviewable without authorizing deletion.
- Check results are recorded, including failures/skips; discovery can complete with a known failure assigned a disposition.

## SN-A02 — Approve frontend direction

Source: [Framework](requirements.md#framework), [Docker](requirements.md#docker) | Phase: 1 | Type: decision

Goal: Approve the framework and frontend runtime boundary before scaffolding.

Scope: Decision record only; documentation cleanup belongs to SN-A08, final auth contracts to SN-B02.

Depends on: SN-A01, SN-B01

Blocks: SN-B02, SN-A03

Work:

- Compare a small set of compliant frameworks; recommend one using team familiarity, migration cost, tooling and image/runtime needs.
- Write `frontend-decision.md`: routing/rendering, folder layout, local/container origins and proxy boundary, plus treatment of old routes.
- Review transport feasibility with Dev 2 using SN-B01 evidence. Obtain owner approval for the choice and proposed documentation dispositions.

Verification Gate:

- Record chosen option, alternatives, rationale, owner approval and Dev 2 review.
- Transport and route-transition constraints are explicit enough for SN-A03 and SN-B02 to consume.
- Completion does not require the future auth contract or backend image. If SN-B02 exposes an incompatibility, reopen this decision before dependent changes; do not create reciprocal prerequisites.

## SN-A03 — Framework shell and API connection

Source: [Frontend](requirements.md#frontend) | Phase: 1 | Type: implementation

Goal: Provide a buildable framework shell with working routes and backend transport.

Scope: Route structure and transport only; no final auth forms/session policy or social-feature migration.

Depends on: SN-A02

Blocks: SN-A04, SN-A05

Work:

- Implement the approved scaffold, layout, route handling and package commands; reuse framework-neutral logic where useful.
- Add login/register/home route structure and honest loading/error states; preserve old routes according to SN-A02.
- Wire the approved API/proxy boundary and framework test setup; document commands for Dev 2.

Verification Gate:

- Build and route smoke tests pass: direct entry, refresh, back/forward and missing routes behave as documented.
- A request reaches an existing backend health endpoint through the approved boundary; failure displays an error. Final auth/cookie semantics are not required here.
- Keyboard navigation and layout are usable at 360px and desktop widths; retained-route regression checks pass.

## SN-A04 — Registration UI

Source: [Authentication](requirements.md#authentication), [media](requirements.md#app) | Phase: 1 | Type: implementation

Goal: Let users submit the complete registration form under the approved contract.

Scope: Frontend form and contract fixtures only; real backend/media integration is SN-A07.

Depends on: SN-A03, SN-B02

Blocks: SN-A06

Work:

- Build required email/password/names/date-of-birth inputs plus visible optional avatar/nickname/about-me fields; do not require legacy age/gender.
- Implement avatar preview/removal, pending state, accessible errors and duplicate-submit prevention using SN-B02 payloads.
- Use contract fixtures until SN-B04/SN-B09 are ready; keep fake responses out of production paths.

Verification Gate:

- Interaction tests cover omitted/populated optional fields, invalid required inputs, JPEG/PNG/GIF selection, duplicate email and upload/network failure with recoverable form state.
- Submitted payload/date values match contract fixtures; passwords are neither persisted nor logged.
- Keyboard and 360px/desktop checks pass; fixture-backed completion is labeled frontend-only.

## SN-A05 — Login, session restoration and global logout UI

Source: [Authentication](requirements.md#authentication) | Phase: 1 | Type: implementation

Goal: Reflect authenticated state consistently and expose logout on every supported protected route.

Scope: Frontend state/routing using contract fixtures; backend validity and real integration are SN-B05/SN-A07.

Depends on: SN-A03, SN-B02

Blocks: SN-A06

Work:

- Implement login, startup session lookup and route gating; distinguish unauthenticated responses from unavailable servers.
- Put logout in the shared shell; clear user-specific state and release retained realtime resources on successful logout.
- Follow SN-B02 cookie policy without client-stored bearer tokens or a second auth service.

Verification Gate:

- Tests cover valid/invalid login, restored session, unauthenticated deep links and server/network errors without falsely treating all failures as logout.
- Successful logout clears protected state; back navigation cannot redisplay it. Failed logout reports failure rather than fake success.
- Logout remains accessible across supported protected routes at mobile/desktop widths; fixtures do not establish real persistence.

## SN-A08 — Align active project documentation

Source: [Project context](CONTEXT.md), [frontend](requirements.md#frontend) | Phase: 1 | Type: documentation

Goal: Make active guidance consistent with approved social-network decisions.

Scope: Identity, authority and approved documentation dispositions only; no application removal, Git-history edits or runtime setup ownership.

Depends on: SN-B02

Blocks: SN-A07

Work:

- Apply owner-approved dispositions from SN-A02 to the SN-A01 inventory; preserve useful legacy context before archiving/removing docs.
- Update active README/AGENTS/context links and mark retained forum constraints as historical; link decisions that actually exist.
- Coordinate root/shared doc edits with B; detailed run/CI instructions remain SN-B07 work.

Verification Gate:

- Every changed/deleted document matches the approved inventory and has a retained-context destination where needed.
- Link/anchor checks pass; active entry points lead to current requirements/tracker and do not mandate conflicting forum-only rules.
- Reviewer can distinguish current decisions from historical notes. Documentation-only validation suffices; no application test result is claimed.

## SN-A06 — Frontend image and runtime handoff

Source: [Docker](requirements.md#docker) | Phase: 1 | Type: packaging

Goal: Deliver a separately buildable frontend image with documented runtime inputs.

Scope: Frontend image and handoff only; live two-image integration is SN-B07/SN-A07.

Depends on: SN-A04, SN-A05

Blocks: SN-B07

Work:

- Package the approved frontend runtime/assets, routes and backend configuration; coordinate shared ignore-file edits with B.
- Document image name, build/run commands, ports, health endpoint and origin/proxy inputs in frontend setup docs.
- Check server-only configuration cannot appear in shipped browser assets.

Verification Gate:

- Build from a clean checkout without local dependencies; container smoke checks load auth routes, deep links and static assets.
- Correct runtime configuration targets the intended backend; a missing/unreachable backend produces an honest error rather than fake auth success.
- Image is distinct from the backend; Dev 2 can use the documented handoff without unpublished files.

## SN-A07 — Phase 1 integrated acceptance

Source: [Authentication](requirements.md#authentication), [Phase 1 boundary](roadmap.md#phase-1-boundary-and-exit) | Phase: 1 | Type: acceptance

Goal: Prove Phase 1 works end to end with real services and persistent storage.

Scope: Account-access acceptance only; no mocks, future social features or writing Phase 2 tickets.

Depends on: SN-B07, SN-A08

Blocks: None

Work:

- Add/run browser journeys for required-only/full registration, avatar formats/errors, login errors/success, protected entry and global logout through both images.
- Exercise browser reopen, backend/container restart and account/media persistence. Reuse B’s controlled-time evidence for sessions beyond 12 hours; test session age, not account age.
- Write `phase-1-acceptance.md` with exact commands/results and manual steps; update context and request a separate Phase 2 planning pass after acceptance.

Verification Gate:

- Browser tests verify valid users reach protected content; unauthenticated/revoked sessions cannot, including after logout/back navigation.
- Browser-reopen and container-recreation checks preserve valid sessions/data; avatars and repeated startup remain correct under the approved policy.
- Local/hosted gates including new journeys pass; mobile/desktop and keyboard checks are recorded. Both developers review evidence; every predecessor is complete and skips/failures cannot masquerade as a pass.
