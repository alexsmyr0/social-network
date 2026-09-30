# Social Network — Delivery Roadmap

Planning baseline: 2026-09-21; implementation checkpoint: 2026-09-30. Two developers, tracks A and B. The [Zone01 assignment](requirements.md) defines completion; the old forum's completed tickets do not count as social-network delivery. Use the [active tracker](ticket-tracker.md) for the latest ticket status.

Only **Phase 1 — Foundations and account access** has implementation tickets: 17 across tracks A and B after the [ticket audit](ticket-audit.md). Maintain them using the [ticket rules](ticket-rules.md). Later phases are work packages to refine after the preceding phase is accepted. This is a scope breakdown, not a calendar estimate; effort depends on unresolved privacy, relationship, group and chat decisions.

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
| **2. Profiles and following** | Users view permitted profiles, switch privacy, follow/unfollow, and handle follow requests | Profile and relationship views, privacy control, request actions, global notification UI distinct from chat alerts | Follow/request state, profile visibility and authorization, follower/following queries, notification storage/delivery adaptations for follow requests | Public versus private profile rules and request transitions pass positive and negative access tests. Profile activity/posts are completed with Phase 3. |
| **3. Posts, comments, and audiences** | Users publish content with the three required audiences and see permitted profile activity | Port required feed/post/comment/media flows to the chosen framework; audience selection; profile posts/activity | Audience enforcement for lists, detail, comments and media; selected-follower rules; activity queries and upload adaptation | Public, followers-only, and selected-followers content behaves consistently across direct URLs, feeds, profiles and attachments. |
| **4. Groups and membership** | Users discover/create groups, join by invitation or request, and share members-only content | Group browsing, creation, invitations, creator review of requests, member posts/comments, notification actions | Group/membership state, member invitations, creator-only request decisions, members-only content and associated notifications | Accept/decline paths and outsider denial work across UI, API and media; membership changes affect access. |
| **5. Events and messaging** | Members respond to group events; permitted users chat privately or in their groups | Event creation and Going/Not going responses; private/group chat, emoji entry, distinct message indicators and event notifications | Events/responses; event-created notifications; adapt DM rules; group chat authorization, persistence and WebSocket delivery | Required event and chat journeys work between multiple users; follow/profile/membership changes update permissions. |
| **6. Final acceptance and delivery** | Both developers can demonstrate the complete assignment from a fresh checkout | Responsive/accessibility review, error/loading/empty states, complete user journeys, final setup and demo docs | Dependency audit, data/migration/container persistence checks, authorization review, operational and regression checks | All supplied requirements mapped to passing evidence; both images rebuild and run; remaining blockers resolved. Reconcile the official audit checklist if supplied. |

Phases are delivery order, not permission to defer quality: each feature needs tests and access checks when implemented. Notifications ship with the events that produce them in Phases 2, 4 and 5; they are not postponed to final acceptance. Phase 6 verifies the complete product rather than introducing another packaging architecture.

## Assignment coverage

| Requirement source | Planned coverage |
|---|---|
| [Frontend/framework](requirements.md#frontend) | Framework decision and working auth slice in Phase 1; remaining routes ported in Phases 2–5; responsiveness/performance verified throughout and in Phase 6 |
| [Backend, SQLite, migrations and media](requirements.md#backend) | Go/SQLite, approved migration tooling, startup migrations and avatar media in Phase 1; post/comment JPEG/PNG/GIF flows in Phase 3 and group flows in Phase 4 |
| [Two Docker images](requirements.md#docker) | Build and integrate both images in Phase 1; evolve them alongside features and retest fresh deployment in Phase 6 |
| [Authentication](requirements.md#authentication) | All mandatory and optional registration fields, sessions/cookies, persistent login and global logout in Phase 1 |
| [Followers](requirements.md#followers) | Public immediate follows, private requests with accept/decline, unfollow in Phase 2 |
| [Profiles](requirements.md#profile) | Registration information except password, privacy toggle and followers/following in Phase 2; permitted activity and all authored posts in Phase 3 |
| [Posts](requirements.md#posts) | Posts/comments, images/GIFs and all three privacy audiences in Phase 3 |
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
| Profile defaults, public-post/private-profile interaction and follow-state behavior | Before Phase 2/3 implementation | Visibility and state-transition rules before endpoint/schema work |
| Group membership, event and chat models, including the source's asymmetric DM delivery wording and offline behavior | Before Phase 4/5 implementation | Approved models and authorization rules before expanding APIs |
| Retain/remove forum extras such as categories, reactions, drafts, presence UI and DM images | During baseline review, revisited before each affected phase | Explicit disposition; no obligation to rebuild every old feature |

Decision order is frontend/runtime constraints (SN-A02), then auth behavior (SN-B02), then storage/migration design (SN-B08). Each consumes approved upstream outputs; none waits for downstream implementation. Active-documentation cleanup is separate in SN-A08; avatar implementation is separate in SN-B09.

The first phase creates only the user/session/media schema it needs. Do not prebuild future follower/group/event tables or generalized chat abstractions.

## Phase 1 boundary and exit

Include framework setup, working registration/login/logout, an authenticated home shell, migrations, avatars, separate Docker images, and repeatable verification. Reserve space for later notification/chat features without implementing fake data or nonfunctional controls. Full profiles, follows, feed migration, groups, events and chat adaptations remain later work.

The frontend transition decision must state how old forum routes remain usable or are intentionally retired. Until new privacy rules ship, do not describe inherited forum endpoints as social-network compliant or deploy this phase as a finished product.

Exit requires [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance) evidence: a fresh checkout can run the two images, create an account with optional fields omitted or supplied, restore a session, reject invalid access, log out everywhere, and retain required data across restart. Then start a separate planning pass to reassess this roadmap and write **Phase 2 tickets only**; producing that backlog is not part of the Phase 1 acceptance gate.

The 2026-09-22 verification of clean import snapshot `b295348` is historical evidence, not the current implementation checkpoint. SN-B07 now has successful hosted two-image CI and local image/transport evidence in its [verification record](shared-runtime.md#verification-record); resubmission HEAD checks are reported separately in its PR.
