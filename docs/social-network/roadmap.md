# Social Network — Delivery Roadmap

Planning baseline: 2026-09-21; backlog extended: 2026-10-02; implementation checkpoint: 2026-09-30. Two developers, tracks A and B. The [Zone01 assignment](requirements.md) defines completion; the old forum's completed tickets do not count as social-network delivery. Use the [active tracker](ticket-tracker.md) for the latest ticket status.

**Phases 1–4 are ticketed:** 17 Phase 1 tickets, 7 Phase 2 tickets, 6 Phase 3 tickets and 6 Phase 4 tickets across tracks A and B. The owner requested roughly 3× Phase 1 ticket scope and approved [Phase 2–3 decisions](phase-2-3-decisions.md) and [Phase 4 decisions](phase-4-decisions.md), including preservation of inherited bonuses. Maintain the backlog using the [ticket rules](ticket-rules.md); see the [Phase 2–3 audit](phase-2-3-ticket-audit.md) and [Phase 4 audit](phase-4-ticket-audit.md). Phase 1 acceptance remains the next execution gate. **Phase 5 is pending** at the owner's request; Phase 6 remains roadmap-only. This is a scope breakdown, not a calendar estimate.

## Current starting point

The [inherited context](inherited-context.md) preserves the original forum baseline. At the 2026-09-30 checkpoint, the social-network implementation has:

- A [Vue 3, Vite and Vue Router frontend](frontend-setup.md) with registration and session UI verified against the [approved auth contract](auth-contract.md) using fixtures. Real-service browser acceptance remains [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance).
- A [Go/SQLite account schema and startup migrations](backend-migrations.md) using the [approved fresh-database policy](data-decision.md). Existing forum databases are refused rather than silently converted.
- [Account registration](backend-accounts.md), [persistent sessions](backend-sessions.md) and [private avatars](backend-avatars.md) verified at the backend layer. Their complete frontend-to-backend journey remains SN-A07.
- Separately built [frontend](frontend-setup.md#frontend-container-handoff) and [backend](backend-image.md) images. [SN-B07 shared startup, transport checks and hosted CI](shared-runtime.md) have passed hosted and local verification; revision-specific evidence is in the [verification record](shared-runtime.md#verification-record). SN-A07 integrated acceptance is next.

The inherited forum feed, profiles, notifications and chat remain migration references. They do not satisfy the later social-network feature gates without new privacy rules, framework integration and verification. The [active tracker](ticket-tracker.md) owns completion status.

## Full scope by phase

| Phase | User-visible outcome | Track A — frontend/integration work | Track B — backend/data work | Completion boundary |
|---|---|---|---|---|
| **1. Foundations and account access** | A user registers with the new fields, logs in, returns with their session, and logs out from a framework-based app | Baseline/doc review, approved framework setup, responsive auth forms and shell, frontend image, integrated acceptance | Baseline review, approved auth/data contracts, startup migrations, registration/avatar support, session lifecycle, backend image, shared CI | Real auth journey works through two images; migrations and tests pass. No claim of complete social-network functionality. **Ticketed now.** |
| **2. Profiles and following** | Users discover people, view permitted profiles, switch privacy, follow/unfollow, and handle follow requests | Directory/profile/relationship views, privacy control, request actions, global notification UI distinct from chat alerts | Follow/request state, profile authorization, follower/following queries, durable notifications, inherited-content and media privacy boundary | Positive/negative access and transition checks pass, including inherited API/static-media bypasses. New profile activity/posts UI remains Phase 3. **SN-A09–A11, SN-B10–B13.** |
| **3. Posts, comments, and audiences** | Users publish to the three audiences, view permitted activity and retain forum content features | Feed/post/comment/media migration, audience selection, drafts, editing/deletion, categories, reactions and private/profile activity | Audience enforcement across every query/action/media path; selection lifecycle, content upgrades and preserved interaction/notification behavior | All audiences and profile restrictions behave consistently across direct URLs, feeds, profiles, activity, notifications and attachments; inherited bonuses have evidence. **SN-A12–A14, SN-B14–B16.** |
| **4. Groups and membership** | Users discover/create groups, join by invitation or request, and share members-only content | Group browsing/creation, invitation/request actions, creator removal/member departure, reused publishing/discussions, member home feeds | Group/membership/invitation/request state, transactional notices, shared post extension and membership checks across content/media | Admission/departure and outsider denial work across UI/API/media; departed authors lose access while contributions remain. **SN-A15–A17, SN-B17–B19.** |
| **5. Events and messaging** | Members respond to group events; permitted users chat privately or in their groups | Event creation and Going/Not going responses; private/group chat, emoji entry, distinct message indicators and event notifications | Events/responses; event-created notifications; adapt DM rules; group chat authorization, persistence and WebSocket delivery | Required event and chat journeys work between multiple users; follow/profile/membership changes update permissions. **Pending interview and tickets.** |
| **6. Final acceptance and delivery** | Both developers can demonstrate the complete assignment from a fresh checkout | Responsive/accessibility review, error/loading/empty states, complete user journeys, final setup and demo docs | Dependency audit, data/migration/container persistence checks, authorization review, operational and regression checks | All supplied requirements mapped to passing evidence; both images rebuild and run; remaining blockers resolved. Reconcile the official audit checklist if supplied. |

Phases are delivery order, not permission to defer quality: each feature needs tests and access checks when implemented. Notifications ship with the events that produce them in Phases 2, 4 and 5; they are not postponed to final acceptance. Phase 6 verifies the complete product rather than introducing another packaging architecture.

## Assignment coverage

| Requirement source | Planned coverage |
|---|---|
| [Frontend/framework](requirements.md#frontend) | Framework decision and working auth slice in Phase 1; remaining routes ported in Phases 2–5; responsiveness/performance verified throughout and in Phase 6 |
| [Backend, SQLite, migrations and media](requirements.md#backend) | Go/SQLite, startup migrations and avatars in Phase 1; protected inherited-content/media upgrade in Phase 2; audience-aware post/comment JPEG/PNG/GIF flows in Phase 3 and group flows in Phase 4 |
| [Two Docker images](requirements.md#docker) | Build and integrate both images in Phase 1; evolve them alongside features and retest fresh deployment in Phase 6 |
| [Authentication](requirements.md#authentication) | All mandatory and optional registration fields, sessions/cookies, persistent login and global logout in Phase 1 |
| [Followers](requirements.md#followers) | Public immediate follows, private requests with accept/decline, unfollow in Phase 2 |
| [Profiles](requirements.md#profile) | Registration information except password, privacy toggle and followers/following in Phase 2; permitted activity and all authored posts in Phase 3 |
| [Posts](requirements.md#posts) | Inherited profile-privacy boundary in Phase 2; posts/comments, images/GIFs, all three audiences and preserved categories/reactions/drafts/editing/deletion in Phase 3 |
| [Groups](requirements.md#groups) | Discovery, creation, invitations, join requests and member content in Phase 4; events with title, description, day/time and at least Going/Not going in Phase 5 |
| [Chat](requirements.md#chat) | Relationship-based private messaging, instant WebSocket delivery, emojis and members-only group chat in Phase 5 |
| [Notifications](requirements.md#notifications) | Global access and follow requests in Phase 2; group invitations and creator join requests in Phase 4; group events in Phase 5; distinguish from private messages throughout |
| [Allowed packages](requirements.md#allowed-packages) | Audit baseline in Phase 1, check every dependency change, final audit in Phase 6 |

## Decisions before dependent implementation

| Decision | When / owner | Required record |
|---|---|---|
| JS framework, frontend migration boundary and runtime/proxy arrangement | Phase 1, SN-A02 | [Approved frontend decision](frontend-decision.md): Vue 3, vertical migration, same-origin proxy and backend-owned media boundary |
| Auth request/response fields, optional nickname semantics, avatar upload/access behavior, session persistence and concurrent-session behavior | Phase 1, SN-B02, reviewed by A | [Approved auth contract](auth-contract.md); no inherited 12-hour expiry or single-session behavior |
| Migration library/layout, user/session model, avatar storage and treatment of old databases | Phase 1, SN-B08 | [Approved data decision](data-decision.md); no inferred birthdays or automatic destructive resets |
| Profile defaults, public-post/private-profile interaction, follow transitions, audiences and notification/media architecture | Approved in the 2026-10-01 interview; concrete interface handoffs SN-B10/SN-B14 | [Phase 2–3 decisions](phase-2-3-decisions.md): public defaults, name-only private teasers, profile privacy overrides post audience, current-follower grants, single follow model and protected media |
| Group discovery, admission/departure, content access and storage | Approved in the Phase 4 interview; concrete interface handoff SN-B17 | [Phase 4 decisions](phase-4-decisions.md): current-membership access, preserved contributions, creator removal, departed-inviter cancellation, separate relationship tables and extended posts |
| Events and chat, including asymmetric DM delivery, offline sending and access to past conversations | **Phase 5 pending**; resume the owner interview before ticketing | No approval of the unanswered messaging proposals; preserve existing chat features while decisions remain open |
| Preserve forum extras such as categories, reactions, drafts, presence UI and DM images | Owner required preservation in the Phase 2–3 interview | [Feature ownership](phase-2-3-decisions.md#feature-preservation-and-ticket-ownership): content extras in Phase 3; chat/presence/media adaptation in Phase 5. No feature deletion is authorized. |

Decision order is frontend/runtime constraints (SN-A02), then auth behavior (SN-B02), then storage/migration design (SN-B08). Each consumes approved upstream outputs; none waits for downstream implementation. Active-documentation cleanup is separate in SN-A08; avatar implementation is separate in SN-B09.

The first phase creates only the user/session/media schema it needs. Do not prebuild future follower/group/event tables or generalized chat abstractions.

## Phase 1 boundary and exit

Include framework setup, working registration/login/logout, an authenticated home shell, migrations, avatars, separate Docker images, and repeatable verification. Reserve space for later notification/chat features without implementing fake data or nonfunctional controls. Full profiles, follows, feed migration, groups, events and chat adaptations remain later work.

The frontend transition decision must state how old forum routes remain usable or are intentionally retired. Until new privacy rules ship, do not describe inherited forum endpoints as social-network compliant or deploy this phase as a finished product.

Exit requires [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance) evidence: a fresh checkout can run the two images, create an account with optional fields omitted or supplied, restore a session, reject invalid access, log out from every supported route, and retain required data across restart. The owner separately authorized the Phase 2–4 backlog before this gate completes; ticket authoring is not part of acceptance and does not bypass it. SN-A07 unlocks SN-B10.

The 2026-09-22 verification of clean import snapshot `b295348` is historical evidence, not the current implementation checkpoint. SN-B07 now has successful hosted two-image CI and local image/transport evidence in its [verification record](shared-runtime.md#verification-record); resubmission HEAD checks are reported separately in its PR.

## Phase 2 boundary and exit

SN-B10 supplies reviewed contracts/data mappings; SN-B11 implements profiles/relationships; SN-B12 implements persistent notifications; SN-B13 secures inherited APIs and media under profile privacy. SN-A09/A10 deliver Vue flows against contract fixtures. The approved public default, private-profile teaser and follow-transition rules must hold through UI, direct APIs, lists/counts, notifications and stored files before acceptance.

[SN-A11](track-a.md#sn-a11--accept-profiles-following-and-privacy-end-to-end) proves the real multi-user journey, restart/reconnect behavior and negative access cases through both images. No Phase 3 audience implementation may be an undeclared prerequisite for this boundary. Profiles' new posts/activity UI and selected-audience publishing remain Phase 3. All scoped predecessors must pass before SN-B14 begins Phase 3 execution.

## Phase 3 boundary and exit

SN-B14 supplies reviewed content/audience contracts and data mappings. SN-B15/B16 implement publishing, all audiences, protected interactions/activity and preserved bonuses; SN-A12/A13 deliver the Vue journeys. Follow/profile/audience changes affect future reads, writes and media consistently, including private histories, counts and notification excerpts. Migrations preserve earlier-phase data and files.

[SN-A14](track-a.md#sn-a14--accept-publishing-audiences-and-preserved-features) requires every approved matrix case and scoped bonus to have real browser/API/media evidence, plus persistence and retained Phase 1–2 regressions. Groups/events/chat adaptations remain outside this exit. SN-A14 unlocks SN-B17 and Phase 4 execution. The [completed Phase 3 acceptance record](phase-3-acceptance.md) maps these requirements to the passing local/hosted gates on implementation `209e2d0` (13 new real-service journeys, 29 integration journeys total).

## Phase 4 boundary and exit

SN-B17 supplies reviewed group interfaces, transition fixtures and data mappings. SN-B18 implements discovery/creation, membership transitions and transactional invitation/request notices; SN-B19 extends existing posts and authorization for group content. SN-A15/A16 provide corresponding Vue flows against fixtures. Published group posts use current membership instead of personal audience/profile rules; profile fields keep their existing restrictions.

[SN-A17](track-a.md#sn-a17--accept-groups-and-membership-end-to-end) proves invitation/request admission, creator-only decisions/removal, ordinary-member departure, inviter cancellation and fresh readmission across real services. Content/API/media access must be revoked for departed authors while their contributions remain for members. All preserved content features, prior-phase regressions and versioned upgrade/restart checks need evidence through both images.

## Deferred Phase 5 and Phase 6 planning

The owner explicitly left **Phase 5 pending**. Its last DM questions were unanswered; asymmetric delivery, offline sending and history/media access after relationship loss remain undecided. Events and remaining private/group-chat choices also need review before tickets. Existing chat capabilities remain preservation requirements; no implementation or deletion is authorized by deferral.

Phase 6 remains a final-acceptance work package, to be discussed and ticketed later. Deferred phases have no active ticket IDs or completion claims. Their future execution must follow the preceding acceptance gate and approved decisions.
