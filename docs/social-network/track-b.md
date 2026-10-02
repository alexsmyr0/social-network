# Track B — Backend, Data and Shared Tooling

Dev 2 owns backend, storage and shared run/CI tooling for Phases 1–4. Status and handoffs live in the [tracker](ticket-tracker.md); follow the [ticket-writing rules](ticket-rules.md). Larger work packages follow the [Phase 2–3 decisions](phase-2-3-decisions.md) and [Phase 4 decisions](phase-4-decisions.md), including preservation of inherited features. Phase 5 remains pending.

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

- Owner approves interfaces, session policy and fixture handoff once; valid/invalid examples support independent UI fixtures.
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
- Schema and storage can represent every approved request/session state; new client-visible contract changes require owner approval.
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

## SN-B10 — Publish profile, follow and notification contracts

Source: [Profiles](requirements.md#profile), [followers](requirements.md#followers), [notifications](requirements.md#notifications), [approved decisions](phase-2-3-decisions.md) | Phase: 2 | Type: contract

Goal: Give both tracks an implementable Phase 2 interface, state model and migration handoff within approved architecture.

Scope: Contract examples, schema mapping and privacy-transition inventory; runtime implementation belongs to SN-B11/B12/B13 and Vue work to SN-A09/A10.

Depends on: SN-A07

Blocks: SN-B11, SN-A09

External gate: Owner approval of concrete new public-interface details and fixture handoff in one gate. Settled product and architecture choices are not reopened.

Work:

- Write [profiles-contract.md](profiles-contract.md) with discovery, full/redacted profiles, avatar/list access, privacy writes, follow/cancel/unfollow and incoming-request decisions, including pagination, validation, errors and repeated/stale-action examples.
- Map fields/transitions to the single follow model, notification extensions and versioned upgrades. Define request identity against stale actions and concurrent privacy/follow outcomes.
- Define persisted notification/read actions, commit-before-signal delivery, reconnect/invalidation payloads and recipient filtering while retaining content notices. Map private-profile exposure through every inherited API and static-media route for SN-B13.
- Supply [reviewable fixtures](fixtures/phase-2-contract.json) and [phase-2-data-plan.md](phase-2-data-plan.md) covering defaults, backfills, media ownership/cleanup and recovery. Assign exact route/query/schema/static-path owners before implementation.

Verification Gate:

- Owner-approved interfaces and fixture completeness/consistency checks are recorded; all profile fields, name-only teasers, follow transitions and notification actions have valid/invalid examples.
- Schema/transition mappings cover uniqueness, no self-follow, retries, stale requests, both privacy switches and preserved Phase 1 data; concrete migrations consume existing tooling.
- Assign inherited notification exposure to SN-B12 and remaining content/media bypasses to SN-B13, without waiting for Phase 3 or chat redesign.
- Links, contract consistency and handoff checks pass. No API implementation, database migration or live socket delivery is claimed.

## SN-B11 — Implement profiles and the follow lifecycle

Source: [Profiles](requirements.md#profile), [followers](requirements.md#followers), [migrations](requirements.md#migrate) | Phase: 2 | Type: implementation

Goal: Persist profile privacy and directional relationships with consistent authorized profile reads and transitions.

Scope: Profile/follow schema, discovery/read APIs, avatar access and relationship writes; notifications belong to SN-B12, inherited content/media boundary to SN-B13.

Depends on: SN-B10

Blocks: SN-B12, SN-B13

Work:

- Apply approved visibility/follow migrations without resetting versioned data. Preserve account/session contracts and implement indexed, paginated display-name discovery and follower/following queries.
- Return full authorized profiles or name-only private teasers, including matching avatar and list/count access. Keep internal usernames, hashes and session fields out of social serializers.
- Implement public immediate follows, private requests, recipient accept/decline, sender cancellation/retry and unfollow. Preserve accepted followers on public-to-private switches and accept pending requests on private-to-public switches atomically.
- Provide shared profile-visibility checks and transaction seams for SN-B12/B13. Document operations, stale-action outcomes and migration/recovery evidence; later consumers extend these checks rather than duplicating policy.

Verification Gate:

- Repository/API tests cover fresh/upgrade/repeated/failed migrations, retained accounts/sessions, default-public registration and full versus redacted discovery/profile/list/avatar reads for owner, follower, pending requester and outsider.
- State-transition and concurrency tests cover duplicate/self-follow, unauthorized decisions, cancellation/retry, stale request identities and races with privacy changes without duplicate or contradictory relationships.
- Missing/revoked sessions and forbidden-origin writes fail consistently; query pagination/counts and optional display-name fallbacks disclose no denied profile data.
- Focused Go/API/race checks pass with revision-specific evidence; SN-B12/B13 complete notification delivery and inherited content privacy before SN-A11.

## SN-B12 — Persist and deliver relationship notifications

Source: [Notifications](requirements.md#notifications), [followers](requirements.md#followers), [notification architecture](phase-2-3-decisions.md#durable-notifications-and-one-websocket) | Phase: 2 | Type: implementation

Goal: Deliver durable, recipient-scoped follow notifications and restore current state after missed realtime signals.

Scope: Notification storage, follow-transaction integration, HTTP actions and WebSocket signals; Vue rendering belongs to SN-A10, Phase 3 content-audience adaptation to SN-B16.

Depends on: SN-B11

Blocks: SN-A11

Work:

- Preserve existing notices/read state while adding follow-request targets and deduplication; backfill still-pending requests predating this migration.
- Insert follow notifications with their triggering state change and signal only after commit. Reconcile notices when requests are cancelled, rejected, accepted or automatically accepted by a privacy switch; stale targets cannot affect a newer request.
- Implement authorized notification listing, unread totals and read-one/read-all actions. Reuse profile checks for actor details and inherited content excerpts; publish minimal refresh/invalidation signals over the existing session-owned socket.
- Support reconnect/refetch and multiple sessions; retain message-frame compatibility and record A's handoff examples.

Verification Gate:

- Database/API tests prove atomic follow/request notices, rollback silence, deduplication, pending-request backfill and retained historical read state; another user cannot list, mark or act on a recipient's notices.
- Real socket tests confirm post-commit signals, independent recipient delivery, session-revocation handling and correct unread state after disconnect/reconnect or backend restart.
- Cancel/decline/retry and privacy-switch races cannot leave actionable obsolete requests or leak restricted actor/content details through payloads or badges.
- Focused backend/realtime regressions pass, including preserved comment/reaction delivery; missing browser integration remains SN-A11 work.

## SN-B13 — Protect inherited content and migrate media access

Source: [Profiles](requirements.md#profile), [media](requirements.md#app), [preserved features](phase-2-3-decisions.md#feature-preservation-and-ticket-ownership) | Phase: 2 | Type: implementation

Goal: Enforce profile privacy across retained content APIs and attachment URLs before Phase 2 acceptance.

Scope: Inherited content access and media lifecycle; post audiences/optional fields belong to SN-B15, social chat authorization to Phase 5.

Depends on: SN-B11

Blocks: SN-A11

Work:

- Apply shared profile/status checks to inherited feeds/detail, comments/reactions, activity, categories/counts, navigation and chat identity projections. Filter before pagination/totals; preserve authorized behavior and owner-only drafts.
- Migrate post/comment files/associations to private storage or authorized compatibility routes. Cover upload/edit/delete and reads; close static bypasses without discarding recoverable files.
- Extend cleanup across retained media owners. Preserve DM associations/participant access during shared-route changes without choosing Phase 5 policy; report missing/unmappable assets with recovery steps.
- B owns `cmd/frontend` static/proxy and runtime/harness edits, with A review. Record the exposure inventory and media upgrade/recovery handoff.

Verification Gate:

- Multi-user tests cover private authors through every inventoried query, mutation and media path; denied bodies, snippets, counts and navigation remain inaccessible while authorized features work.
- Storage tests preserve bytes/associations across upgrade, repeated startup and restart; interrupted copy/write, replacement and orphan cleanup cannot lose referenced avatar/post/comment/DM media.
- Direct `/static/uploads/` and alternate paths cannot bypass checks; stale URLs lose access after privacy changes, while authorized media remains readable through both images.
- API/media/container checks pass with recorded revisions/commands; completion needs no future SN-B15 implementation.

## SN-B14 — Publish content, audience and lifecycle contracts

Source: [Posts](requirements.md#posts), [profiles](requirements.md#profile), [approved content decisions](phase-2-3-decisions.md#posts-audiences-and-activity) | Phase: 3 | Type: contract

Goal: Give both tracks a complete content interface and upgrade plan for audiences and preserved interactions.

Scope: Contract/fixture and data mappings under approved policies; runtime changes belong to SN-B15/B16 and Vue implementation to SN-A12/A13.

Depends on: SN-A11

Blocks: SN-B15, SN-A12

External gate: Owner approval of concrete new public-interface details and fixture handoff in one gate. Existing policy approvals remain binding.

Work:

- Write planned `content-contract.md` for feed/filter/paging, detail, post/comment mutations, reactions, activity and media. Define optional title/categories, text-or-image validation, audience/selection fields and private-profile precedence using the approved access matrix.
- Specify draft/publish/unpublish, both audience-edit directions, current-follower selection, unfollow/refollow, owner deletion and existing descendant/attachment effects. Distinguish retained data from data the requester may see.
- Write planned `phase-3-data-plan.md` mapping audience/selections and relaxed legacy constraints onto versioned upgrades. Explicitly preserve records, map pre-audience content, and extend SN-B13 media/cleanup conventions.
- Define notification redaction/invalidation, stale-write errors and feature/route parity; give A valid/invalid audience, lifecycle and bonus fixtures without live-service prerequisites.

Verification Gate:

- Concrete interfaces and fixture handoff receive one recorded owner approval and pass consistency checks; every matrix cell and follow/privacy/audience transition has observable allow/deny examples for content and attachments.
- Migration mappings preserve prior data and encode selection removal on unfollow without automatic restoration; no schema reset, new service or group/chat model is introduced.
- Drafts, reactions, categories, nested-comment support, navigation, owner activity, editing/deletion and image-only flows each have a named implementation/verification owner.
- References and contract/schema consistency checks pass; no application validation or future acceptance result is required to complete this handoff.

## SN-B15 — Implement audience-aware publishing and feeds

Source: [Posts](requirements.md#posts), [migrations](requirements.md#migrate), [media](requirements.md#app) | Phase: 3 | Type: implementation

Goal: Persist and serve posts with all three audiences, safe publication changes and durable attachments.

Scope: Post schema, audience checks, feed/detail and author mutations using SN-B13 media storage; interaction/activity consumers belong to SN-B16.

Depends on: SN-B14

Blocks: SN-B16

Work:

- Migrate audiences/selections and optional-title/category constraints with explicit backfills. Preserve IDs, associations, publication states/files; connect selected grants to accepted follows and remove them on unfollow.
- Extend shared queries for newest-first feeds, Following/category filters and detail. Combine profile, audience and publication checks before paging/totals; hide recipient selections from other viewers.
- Implement create/edit/delete, draft save, publish/unpublish and audience changes. Validate selections atomically, retain unpublished discussions and revalidate follower eligibility on republish.
- Reuse protected JPEG/PNG/GIF media for text-or-image posts, replacement/removal and cleanup. Apply shared policy to inherited adapters; hand access predicates and lifecycle behavior to SN-B16.

Verification Gate:

- Migration/repository/API tests pass for Phase 2 data, optional fields, valid/invalid content and each audience/profile matrix cell, including author/draft exceptions and denied direct image reads.
- New followers see older followers-only posts; unfollow removes dependent access/selections, refollow does not restore selections, and concurrent audience/follow writes cannot commit unauthorized grants.
- Both audience-edit directions and unpublish/republish consistently affect feed/detail/media while preserving comments/reactions; failed uploads/replacements leave the prior valid state intact.
- Focused API, migration, media and race regressions pass; other access surfaces remain assigned to SN-B16 before phase acceptance.

## SN-B16 — Enforce audiences across discussions and activity

Source: [Posts](requirements.md#posts), [profiles](requirements.md#profile), [notifications](requirements.md#notifications), [preserved features](phase-2-3-decisions.md#feature-preservation-and-ticket-ownership) | Phase: 3 | Type: implementation

Goal: Preserve discussion and activity features without audience bypasses.

Scope: Comments/reactions, profile/private activity, category/navigation summaries and notices; publication belongs to SN-B15, browser acceptance to SN-A14.

Depends on: SN-B15

Blocks: SN-A14

Work:

- Apply SN-B15 access checks to comment reads/create/edit/delete, supported parent relationships and JPEG/PNG/GIF mutations. Preserve owner/deletion semantics and verify parent-post access; forged cross-post parents cannot broaden visibility.
- Retain post/comment likes/dislikes, switching/removal and counts with transactional authorization. Keep stored discussions/reactions after audience loss or unpublishing, while denying unauthorized reads and actions.
- Implement permitted profile posts/comments and private created/liked/disliked/comment/draft activity. Adapt category summaries, totals, previous/next navigation and every retained route to filter before paging or aggregation.
- Extend SN-B12 notices/invalidation to current audiences, guarding excerpts and badges. Maintain shared runtime/CI hooks; document feature/route parity and database/media recovery evidence.

Verification Gate:

- API/query tests traverse every content surface as selected/unselected followers, pending requesters and outsiders; profile visibility and parent audiences both apply, including counts and direct comment/media URLs.
- Interaction tests cover reaction toggles, own/foreign edits/deletes, image-only comments, parent validation and concurrent permission loss; no committed unauthorized mutation or duplicate notification survives.
- Private histories stay owner-only and omit now-inaccessible parent content; stale notifications, categories and navigation disclose no restricted body, image, excerpt or count.
- Feature regressions, migration/restart and race checks pass; hand endpoints/commands to SN-A14 without waiting for its browser suite.

## SN-B17 — Publish group and membership contracts

Source: [Groups](requirements.md#groups), [notifications](requirements.md#notifications), [approved architecture](phase-4-decisions.md#approved-architecture-and-handoffs) | Phase: 4 | Type: contract

Goal: Give both tracks reviewed group interfaces, migration mappings and independent fixtures.

Scope: Contract/data handoff under approved group policies; membership implementation belongs to SN-B18, content enforcement to SN-B19.

Depends on: SN-A14

Blocks: SN-B18, SN-A15

External gate: Owner approval of concrete new public-interface details and fixture handoff in one gate. Approved product/storage choices remain settled.

Work:

- Write planned `groups-contract.md` for discovery/creation, member lists, invitations, join requests, leave/remove and notification actions. Specify role-dependent fields, errors, pagination and duplicate/stale-action outcomes.
- Map admission, creator retention, departed-inviter cancellation and fresh return after removal. Define exact request identities and concurrency outcomes so earlier invitations cannot authorize later membership.
- Write planned `phase-4-data-plan.md` for separate groups/memberships/invitations/requests and optional post `group_id`. Preserve existing personal posts, IDs, discussions, notices and media through versioned upgrades/recovery.
- Define group/home-feed and content/media access matrices, profile-field restrictions, transactional notices and invalidation. Supply A fixtures for every role and transition without live-service prerequisites.

Verification Gate:

- Concrete interfaces and fixtures receive one recorded owner approval and pass consistency checks; both tracks can implement from matching schemas, examples and error outcomes without reopening approved architecture.
- Every admission/departure path identifies its decision-maker and atomic state/notice effects; removal is not a ban, and stale actions cannot recreate revoked access.
- Matrices cover private authors, nonmember followers, departed authors, drafts, existing interactions and aggregate/media routes. Personal-post policy and group membership cannot accidentally broaden each other.
- Links and contract/data consistency checks pass. Events/chat and new moderator/transfer workflows remain outside this handoff; no application validation is claimed.

## SN-B18 — Implement groups and membership transitions

Source: [Groups](requirements.md#groups), [notifications](requirements.md#notifications), [migrations](requirements.md#migrate) | Phase: 4 | Type: implementation

Goal: Persist group membership with authorized admission, departure and durable notifications.

Scope: Group schema/APIs and invitation/request notices; applying membership across content/media belongs to SN-B19.

Depends on: SN-B17

Blocks: SN-B19

Work:

- Apply approved group/membership/invitation/request migrations without resets. Implement group creation with creator membership, paginated discovery metadata and members-only lists with permitted identity fields.
- Implement invitations from current members, recipient accept/refuse, and creator-only request decisions. Admission creates one membership and resolves other pending entries transactionally.
- Implement ordinary-member leave and creator removal, preserve contributions, prevent creator departure and permit fresh readmission. Cancel pending invitations from departed inviters; enforce exact request identities and race-safe membership checks.
- Insert/reconcile notices in the same transactions; signal after commit through existing infrastructure. Supply shared membership predicates and change-invalidation seams to SN-B19; record migration/API handoff evidence.

Verification Gate:

- Migration/repository/API tests cover fresh/upgrade/repeated/failed startup, retained personal data and valid creation; outsiders receive only discovery metadata, while member lists honor profile-field privacy.
- Role/transition tests reject forged decisions, duplicate memberships and creator departure. Concurrent accept/refuse/remove/leave operations preserve one valid result; cancelled invitations stay unusable after inviter readmission.
- Atomic-notice tests cover rollback silence, recipient-only actions, resolved pending entries, missed-signal recovery and restart durability; another user's notification cannot authorize admission.
- Focused Go/API/race checks pass with recorded revisions. Content/media revocation remains assigned to SN-B19 before acceptance; Phase 5 behavior is not required.

## SN-B19 — Enforce membership across group content

Source: [Groups](requirements.md#groups), [posts](requirements.md#posts), [media](requirements.md#app), [group content decisions](phase-4-decisions.md#group-content-and-existing-features) | Phase: 4 | Type: implementation

Goal: Enforce current group membership across existing content features.

Scope: Group post extension, content/media authorization and membership invalidation; admission and invitation/request notices belong to SN-B18.

Depends on: SN-B18

Blocks: SN-A17

Work:

- Add optional post `group_id` with data-preserving migrations; retain personal-post policies and reuse discussions/reactions/media. Shared authorization selects membership for group posts, including owner operations and drafts.
- Serve published group posts in group views and members' home feeds. Apply access before pagination/counts across filters, profiles/activity, categories and navigation; retain authorized personal behavior.
- Extend creation/editing/deletion, draft/publication controls, optional titles/categories, reactions, replies and JPEG/PNG/GIF workflows. Require current membership for mutations; preserve departed authors' stored contributions and attachment associations.
- Guard notices, media and inherited routes with current membership; invalidate affected views through existing signals. B owns shared runtime/CI extensions and A's acceptance handoff.

Verification Gate:

- Migration/API tests preserve personal data and all content bonuses; private-author group posts remain visible to members while nonmember followers and departed authors receive no content/media access.
- Drafts remain author-only plus membership; publication changes preserve discussions, and forged group/parent associations or concurrent removal cannot commit unauthorized mutations.
- Direct/raw media URLs, notices, aggregate counts and activity cannot bypass membership; referenced files survive upgrade, restart and cleanup after author departure.
- Focused content/media/race regressions and realtime invalidation checks pass; SN-A17 supplies real browser acceptance without becoming this producer's prerequisite.
