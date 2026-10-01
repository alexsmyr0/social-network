# Track A — Frontend and Integration

Dev 1 owns frontend, active documentation and integrated acceptance for Phases 1–4. Status and handoffs live in the [tracker](ticket-tracker.md); follow the [ticket-writing rules](ticket-rules.md). Larger work packages follow the [Phase 2–3 decisions](phase-2-3-decisions.md) and [Phase 4 decisions](phase-4-decisions.md), including preservation of inherited features. Phase 5 remains pending.

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

Blocks: SN-B10

Work:

- Add/run browser journeys for required-only/full registration, avatar formats/errors, login errors/success, protected entry and global logout through both images.
- Exercise browser reopen, backend/container restart and account/media persistence. Reuse B’s controlled-time evidence for sessions beyond 12 hours; test session age, not account age.
- Write `phase-1-acceptance.md` with exact commands/results and manual steps; update context. The separately authorized Phase 2–3 backlog is already planned; this gate unlocks Phase 2 execution.

Verification Gate:

- Browser tests verify valid users reach protected content; unauthenticated/revoked sessions cannot, including after logout/back navigation.
- Browser-reopen and container-recreation checks preserve valid sessions/data; avatars and repeated startup remain correct under the approved policy.
- Local/hosted gates including new journeys pass; mobile/desktop and keyboard checks are recorded. Both developers review evidence; every predecessor is complete and skips/failures cannot masquerade as a pass.

## SN-A09 — Build people, profiles and follow controls

Source: [Profiles](requirements.md#profile), [followers](requirements.md#followers), [approved decisions](phase-2-3-decisions.md#profiles-discovery-and-following) | Phase: 2 | Type: implementation

Goal: Let signed-in users discover people, view permitted profiles and manage outgoing relationships.

Scope: Vue directory, profiles, follower lists and privacy/follow controls; incoming request review and global notifications belong to SN-A10, profile activity to SN-A13.

Depends on: SN-B10

Blocks: SN-A10

Work:

- Implement searchable People results, profile routes and permitted follower/following lists with contracted names, pagination and private-profile teasers.
- Add owner privacy switching plus follow, pending, cancel and unfollow states. Share relationship actions with SN-A10; reflect automatic acceptance after a profile becomes public without fabricating success on failed writes.
- Handle loading, empty, unavailable, missing and denied states; clear stale profile/avatar/list data when permissions or sessions change. Keep future activity controls out until their feature exists.
- Use SN-B10 fixtures for independent development; document commands and component ownership for later activity integration.

Verification Gate:

- Component/browser fixture checks cover public defaults, full authorized profiles and name-only private teasers, including hidden avatar URLs and counts rather than merely hidden markup.
- Follow/cancel/unfollow and both privacy transitions update controls correctly; duplicate actions, rejected writes and stale responses cannot restore an obsolete relationship or disclose cached details.
- Direct entry, back navigation, keyboard operation and 360px/desktop layouts pass; search/list pagination remains usable with missing optional registration fields and duplicate display names.
- Label completion frontend-only; production contains no fixtures. Real authorization remains SN-A11.

## SN-A10 — Deliver global notifications and request review

Source: [Notifications](requirements.md#notifications), [followers](requirements.md#followers), [delivery decisions](phase-2-3-decisions.md#durable-notifications-and-one-websocket) | Phase: 2 | Type: implementation

Goal: Let users receive persistent notices and resolve incoming follow requests throughout the application.

Scope: Shared notification UI, request review and Vue realtime lifecycle; backend persistence belongs to SN-B12, chat adaptation to Phase 5.

Depends on: SN-A09

Blocks: SN-A11

Work:

- Port notifications into the authenticated shell with unread counts, individual/all-read controls and incoming requests using SN-A09 actions. Preserve comment/reaction notices for later content-route integration.
- Connect one session-owned socket; fetch current notifications on signals and reconnect. Consume contract permission-change signals to clear/refetch affected state, and release subscriptions and user data on logout.
- Show pending requests and resolved/cancelled/stale states. Reconcile another tab's decision or a private-to-public transition; keep general notices visually separate from future message indicators.
- Use SN-B10 fixtures independently of SN-B12. Own shell/realtime files; hand content navigation to SN-A13 without activating unported views.

Verification Gate:

- Fixture tests receive a request, accept/decline it and retry a stale action; relationships, notice actions and unread totals converge with server responses without duplicate submissions.
- Disconnect/reconnect, repeated/out-of-order signals and logout/login as another user do not duplicate sockets, lose refetch capability or reveal the previous user's notices.
- Read controls, failure recovery and keyboard access work on every supported authenticated route at mobile/desktop widths. Inaccessible target fixtures disclose no protected excerpts or actionable stale links.
- Record frontend-only evidence; SN-A11 verifies real delivery, recovery and persistence.

## SN-A11 — Accept profiles, following and privacy end to end

Source: [Profiles](requirements.md#profile), [followers](requirements.md#followers), [notifications](requirements.md#notifications), [Phase 2 boundary](roadmap.md#phase-2-boundary-and-exit) | Phase: 2 | Type: acceptance

Goal: Prove profiles, relationships and notifications work together without inherited privacy bypasses.

Scope: Real Phase 2 browser/API/media acceptance through both images; new post audiences and Vue content flows remain Phase 3.

Depends on: SN-A10, SN-B12, SN-B13

Blocks: SN-B14

External gate: Successful local and hosted shared gates, with B owning harness/CI changes; both developers review the evidence.

Work:

- Extend the SN-B07 browser hook with isolated owner, accepted-follower, pending-request and outsider accounts. Exercise discovery, profiles, lists, privacy switches and the complete request/cancel/decline/retry/unfollow journey.
- Verify global notices across routes, concurrent tabs, disconnect/reconnect and restart; use real cookies, APIs and media rather than route mocks.
- Probe retained content APIs, counts, activity, notification excerpts and legacy attachment URLs under changed profile permissions. Confirm preserved public behavior as well as denied private access before Phase 3 expands audiences.
- Write planned `phase-2-acceptance.md` with commands, revisions, hosted links, manual checks and failures; update context/tracker from passing evidence.

Verification Gate:

- Multi-user browser/API checks prove name-only private teasers, correct authorized fields/avatars, immediate public follows, recipient-only request decisions, privacy transitions and revocation with no stale-action bypass.
- Notices survive service restart and recover after missed signals; authenticated deep links, logout/back navigation, keyboard access and 360px/desktop layouts behave consistently.
- Recreated containers preserve accounts, relationships, notices and media; direct/raw media paths and inherited alternate queries cannot reveal private content. Migration failure/recovery evidence is linked.
- Every predecessor and required local/hosted check passes; skipped Docker checks or unexplained failures cannot complete this phase.

## SN-A12 — Build audience-aware feeds and publishing

Source: [Posts](requirements.md#posts), [frontend](requirements.md#frontend), [content decisions](phase-2-3-decisions.md#posts-audiences-and-activity) | Phase: 3 | Type: implementation

Goal: Let users browse permitted posts and manage publication with explicit audiences and persistent drafts.

Scope: Vue feed, composer and owner post editor; discussion/detail and activity-area integration belong to SN-A13, real-service acceptance to SN-A14.

Depends on: SN-B14

Blocks: SN-A13

Work:

- Build newest-first accessible feeds, Following/category filters, paging and optional-title cards; preserve category navigation and filter route-state recovery.
- Port creation and owner editing with optional title/categories, text-or-image content, JPEG/PNG/GIF preview/removal/replacement, and visibly default-Public audience selection. The selected-follower picker uses stable IDs and current eligible followers.
- Support draft save/open, publish, unpublish and deletion through the approved lifecycle; edit audiences in both directions and preserve recoverable inputs on validation/upload failures without claiming uncertain writes succeeded.
- Build reusable cards/composer/API modules for SN-A13 using SN-B14 fixtures. Clear denied shared state after permission/session changes; production uses real transports.

Verification Gate:

- Fixture interaction tests create text-only/image-only posts with omitted or supplied titles/categories and all audiences; invalid selections, lost followers, upload errors and duplicate actions receive contract-consistent handling.
- Editing, draft reload, unpublish/republish and deletion preserve the documented attachment/audience state. A refollowed user does not silently reappear among selected recipients.
- Feed/filter/paging and stale-response tests retain only permitted items; privacy restrictions remain clear even when the composer says Public. Direct editor entry and denied/missing states work.
- Keyboard/mobile/desktop checks pass; label evidence frontend-only. Real persistence/authorization remain SN-A14.

## SN-A13 — Restore discussions and private activity

Source: [Posts](requirements.md#posts), [profiles](requirements.md#profile), [preserved features](phase-2-3-decisions.md#feature-preservation-and-ticket-ownership) | Phase: 3 | Type: implementation

Goal: Let users interact with permitted discussions and browse profile activity while retaining forum bonuses.

Scope: Detail/comments/reactions, profile posts/activity and the owner's activity area; publishing/editor primitives belong to SN-A12, backend access enforcement to SN-B16.

Depends on: SN-A12

Blocks: SN-A14

Work:

- Implement detail routes, previous/next navigation and comment creation/editing/deletion with image/GIF attachment controls. Preserve supported parent-comment relationships and display names without exposing restricted profile details.
- Restore post/comment like/dislike toggle, removal and switching with counts; reconcile failed or stale writes after permission changes instead of leaving optimistic success visible.
- Integrate authored posts/comments into SN-A09 profiles. Port the owner's created/liked/disliked/comment history and draft management, reusing SN-A12 editors; keep those private histories out of other profiles.
- Connect content notifications to permitted Vue routes using SN-A10 modules. Exercise SN-B14 fixtures for missing/deleted/restricted targets, audience changes and cleanup.

Verification Gate:

- Fixture journeys cover comments, existing reply relationships, reactions and owner mutations, including image-only comments and attachment replacement/removal; another user's content never gains owner controls.
- Profile activity requires both profile and parent-post access. Private histories, drafts, totals and next/previous links do not reveal forbidden content when audiences or follows change.
- Notification navigation and direct URLs recover from denied/deleted targets without exposing cached excerpts; logout and account switching clear discussion/activity state.
- Keyboard, 360px/desktop and error/empty/loading checks pass. Fixture-backed completion remains distinct from SN-A14 real-service acceptance.

## SN-A14 — Accept publishing, audiences and preserved features

Source: [Posts](requirements.md#posts), [profiles](requirements.md#profile), [Docker](requirements.md#docker), [Phase 3 boundary](roadmap.md#phase-3-boundary-and-exit) | Phase: 3 | Type: acceptance

Goal: Prove Phase 3 delivers consistent privacy and inherited capabilities through the real application.

Scope: Real browser/API/media regression and release evidence for Phases 1–3; group/event/chat adaptation remains later work.

Depends on: SN-A13, SN-B16

Blocks: SN-B17

External gate: Successful local and hosted shared gates, with B owning harness/CI changes; both developers review the evidence.

Work:

- Extend the shared browser gate with author, selected follower, unselected follower, pending requester and outsider accounts. Exercise every approved profile/audience combination through feeds, profiles, detail, comments and image URLs.
- Run authoring/editing, audience changes, unfollow/refollow, drafts, unpublish/republish, categories, reactions, private activity and content-notification journeys using real services. Link each preserved feature to evidence.
- Recreate containers with retained data/media and upgrade earlier-phase fixtures. Verify attachment replacement/deletion/orphan recovery and reconnect/session cleanup alongside Phase 1–2 journeys.
- Write planned `phase-3-acceptance.md` with commands, revisions, run links and manual evidence; update context, routes and requirement coverage after gates pass.

Verification Gate:

- The complete approved access matrix passes positive and negative checks, including direct/API/media paths, hidden totals/navigation and selected-user removal without automatic access restoration on refollow.
- Both audience-edit directions and profile toggles change access consistently; comments/reactions survive unpublishing and reappear only to permitted viewers after republishing.
- The feature inventory has passing evidence for every Phase 3 bonus; legacy static links and notification excerpts cannot bypass access checks. Restarts preserve required records and bytes.
- Required local/hosted checks and keyboard/mobile/desktop journeys pass without unexplained skips; later planning cannot substitute for acceptance.

## SN-A15 — Build group discovery and membership journeys

Source: [Groups](requirements.md#groups), [notifications](requirements.md#notifications), [membership decisions](phase-4-decisions.md#discovery-membership-and-departure) | Phase: 4 | Type: implementation

Goal: Let users discover/create groups and manage membership through role-appropriate controls.

Scope: Vue discovery, membership and actionable group notices; group discussions belong to SN-A16, real-service acceptance to SN-A17.

Depends on: SN-B17

Blocks: SN-A16

Work:

- Build paginated group browsing, creation with title/description and direct group entry. Show approved nonmember metadata and membership state without rendering protected lists or content.
- Add member invitations, recipient accept/refuse actions and creator-only join-request review. Reuse global notification/read modules and exact request identities from SN-B17 fixtures.
- Support ordinary-member departure and creator removal of another member; retain the creator's membership. Show fresh request/invitation paths after removal and reconcile cancelled or already-resolved actions.
- Build shared group state/navigation for SN-A16, with loading/error/empty states, recoverable validation and duplicate-submit protection. Clear protected cached state after membership/session changes; production uses real transports.

Verification Gate:

- Fixture journeys cover creation, discovery, invitation and request decisions, showing only permitted controls for outsider, invitee, member and creator.
- Leave/remove, inviter departure, stale notifications and simultaneous decisions cannot display false membership success; creator departure and ordinary-member request decisions remain unavailable.
- Direct routes and account switching disclose no protected member list or private-profile fields; missed signals trigger refetch through the existing socket lifecycle.
- Keyboard, 360px/desktop and failure-recovery checks pass with frontend-only evidence. Real authorization, persistence and delivery remain SN-A17.

## SN-A16 — Extend publishing and discussions into groups

Source: [Groups](requirements.md#groups), [posts](requirements.md#posts), [group content decisions](phase-4-decisions.md#group-content-and-existing-features) | Phase: 4 | Type: implementation

Goal: Let members share group content using established publishing and discussion features.

Scope: Group views, member home-feed integration and reused content flows; membership controls belong to SN-A15, server enforcement to SN-B19.

Depends on: SN-A15

Blocks: SN-A17

Work:

- Extend cards/routes for group and member home feeds. Show group context and retain category/Following filters without broadening access.
- Reuse composers/editors for optional titles/categories, text-or-image posts, JPEG/PNG/GIF, drafts, publish/unpublish and author mutations. Display membership visibility instead of a personal audience picker for group content.
- Reuse comments, supported replies, reactions, attachment controls, activity and previous/next navigation. Connect authorized group-content notices through existing global notification modules.
- Use SN-B17 fixtures for membership loss, private authors, unpublished discussions and stale responses. Invalidate inaccessible open views and preserve permitted existing content behavior.

Verification Gate:

- Fixture journeys publish/edit group posts, manage drafts, comment/react and replace/remove attachments; publication and ownership controls match existing behavior plus current membership.
- Members can read private authors' published group posts without extra profile fields; nonmembers and departed authors cannot recover group content through feeds, activity, direct routes or cached responses.
- Departed authors' contributions remain visible to remaining members. Own group drafts stay hidden from others; return through fresh admission restores membership-based UI without reviving obsolete invitations.
- Keyboard/mobile/desktop, notification navigation and content regressions pass against fixtures; SN-A17 proves real persistence and authorization.

## SN-A17 — Accept groups and membership end to end

Source: [Groups](requirements.md#groups), [notifications](requirements.md#notifications), [Docker](requirements.md#docker), [Phase 4 boundary](roadmap.md#phase-4-boundary-and-exit) | Phase: 4 | Type: acceptance

Goal: Prove group admission and content permissions survive membership changes across the real application.

Scope: Phase 4 browser/API/media acceptance and earlier-phase regressions; Phase 5 events/chat remains pending.

Depends on: SN-A16, SN-B19

Blocks: None

External gate: Successful local and hosted shared gates, with B owning harness/CI changes; both developers review the evidence.

Work:

- Extend the shared browser hook with creator, member/inviter, invitee, requester and outsider accounts. Exercise discovery/creation, invitation/request decisions, leave/remove and fresh readmission using real services.
- Cover private authors, nonmember followers, retained contributions and drafts across group/home feeds, profiles/activity, comments, reactions, notifications and direct media URLs.
- Recreate containers and upgrade earlier-phase data; verify membership, notices, records/files, missed-signal recovery and session cleanup. Run preserved content/account journeys alongside group checks.
- Write planned `phase-4-acceptance.md` with commands, revisions, hosted links, feature coverage and manual/failure evidence; update tracker/context only from passing results.

Verification Gate:

- Real multi-user journeys prove creator-only request decisions/removal, member invitations, creator retention and cancelled invitations after inviter departure; stale actions cannot admit users.
- Membership loss immediately denies subsequent content/API/media access, including departed authors; remaining members retain contributions. Fresh admission works without restoring cancelled invitation actions.
- Privacy and membership matrices agree across feeds, direct URLs, aggregates and notices; versioned upgrades/restarts preserve existing personal and group records/media without resets.
- Required local/hosted checks, keyboard/mobile/desktop flows and prior-phase regressions pass. Skipped Docker checks or unfinished Phase 5 planning cannot count as acceptance evidence.
