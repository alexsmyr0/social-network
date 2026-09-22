# Social Network — Delivery Roadmap

Planning baseline: 2026-09-21. Two developers, tracks A and B. The [Zone01 assignment](requirements.md) defines completion; the old forum's completed tickets do not count as social-network delivery.

Only **Phase 1 — Foundations and account access** has implementation tickets: 17 across tracks A and B after the [ticket audit](ticket-audit.md). Maintain them using the [ticket rules](ticket-rules.md). Later phases are work packages to refine after the preceding phase is accepted. This is a scope breakdown, not a calendar estimate; effort depends on pending framework, compatibility, and data decisions.

## Starting point

The [inherited context](inherited-context.md) records the imported baseline and its earlier test run. Planning spot checks confirm:

- The frontend remains vanilla JS in `SPA/`; the assignment requires a JS framework.
- `internal/db/users.go` and `forum_schema.sql` still require a username and model age/gender rather than the new registration fields.
- `internal/db/db.go` applies an embedded schema and procedural migrations; the assignment calls for organized migration files applied at startup.
- `internal/db/sessions.go` uses a 12-hour session duration; `users_helpers.go` issues a browser-session cookie. Neither proves the required stay-logged-in-until-logout behavior.
- The root Dockerfile builds only the backend.
- Chat, uploads, notifications, and tests are useful starting points, but need new access rules and feature coverage.

These observations guide tickets; they do not replace their verification gates. Existing API routes, schemas, and frontend structure remain inherited implementation details until reviewed.

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
| [Backend, SQLite, migrations and media](requirements.md#backend) | Preserve Go/SQLite baseline, select migration tooling, implement startup migrations and avatar media in Phase 1; post/comment JPEG/PNG/GIF flows in Phase 3 and group flows in Phase 4 |
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
| JS framework, frontend migration boundary and runtime/proxy arrangement | Phase 1, SN-A02 | Owner-approved choice with alternatives and tradeoffs; no framework selected by this roadmap |
| Auth request/response fields, optional nickname semantics, avatar upload/access behavior, session persistence and concurrent-session behavior | Phase 1, SN-B02, reviewed by A | Owner-approved contract; do not silently inherit 12-hour expiry or single-session behavior |
| Migration library/layout, user/session model, avatar storage and treatment of old databases | Phase 1, SN-B08 | Owner-approved data policy; no inferred birthdays or automatic destructive resets |
| Profile defaults, public-post/private-profile interaction and follow-state behavior | Before Phase 2/3 implementation | Visibility and state-transition rules before endpoint/schema work |
| Group membership, event and chat models, including the source's asymmetric DM delivery wording and offline behavior | Before Phase 4/5 implementation | Approved models and authorization rules before expanding APIs |
| Retain/remove forum extras such as categories, reactions, drafts, presence UI and DM images | During baseline review, revisited before each affected phase | Explicit disposition; no obligation to rebuild every old feature |

Decision order is frontend/runtime constraints (SN-A02), then auth behavior (SN-B02), then storage/migration design (SN-B08). Each consumes approved upstream outputs; none waits for downstream implementation. Active-documentation cleanup is separate in SN-A08; avatar implementation is separate in SN-B09.

The first phase creates only the user/session/media schema it needs. Do not prebuild future follower/group/event tables or generalized chat abstractions.

## Phase 1 boundary and exit

Include framework setup, working registration/login/logout, an authenticated home shell, migrations, avatars, separate Docker images, and repeatable verification. Reserve space for later notification/chat features without implementing fake data or nonfunctional controls. Full profiles, follows, feed migration, groups, events and chat adaptations remain later work.

The frontend transition decision must state how old forum routes remain usable or are intentionally retired. Until new privacy rules ship, do not describe inherited forum endpoints as social-network compliant or deploy this phase as a finished product.

Exit requires [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance) evidence: a fresh checkout can run the two images, create an account with optional fields omitted or supplied, restore a session, reject invalid access, log out everywhere, and retain required data across restart. Then start a separate planning pass to reassess this roadmap and write **Phase 2 tickets only**; producing that backlog is not part of the Phase 1 acceptance gate.

Remote `main` was verified on 2026-09-22 at clean import snapshot `b295348`, matching the committed source tree without the inherited history. Use this baseline for new work; do not merge old branches containing credential history. Hosted CI evidence is still required by SN-B07.
