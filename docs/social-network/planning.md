# Social Network — Planning Context

The [Zone01 assignment](requirements.md) is authoritative. The [inherited baseline](inherited-context.md) describes a previous project, not completed social-network requirements. This document records adaptation areas, approved decisions and questions for later phases. Approved choices are recorded for [Phase 2–3](phase-2-3-decisions.md) and [Phase 4](phase-4-decisions.md); feature removal is not authorized.

The [delivery roadmap](roadmap.md) breaks the full assignment into six phases. The [active tracker](ticket-tracker.md) and [track A](track-a.md) / [track B](track-b.md) now define Phases 1–4. The owner requested larger work packages and approved their product/architecture direction before authoring. **Phase 5 stays pending** at the owner's request; Phase 6 remains roadmap-only. Use the tracker for execution order and status; remaining questions concern deferred phases or concrete interface handoffs.

## Adaptation areas

| Area | Required change or verification |
|---|---|
| Frontend | [SN-A02 approved](frontend-decision.md) Vue 3 with Vite and Vue Router, a vertical migration from the inherited vanilla-JS application, and same-origin delivery through the Go frontend proxy. |
| Registration | The [approved contract](auth-contract.md) requires email, password, first name, last name and date of birth, with optional avatar, nickname and about-me fields. [Frontend UI](frontend-setup.md), [account API](backend-accounts.md) and [avatars](backend-avatars.md) passed their separate gates; real-service acceptance remains SN-A07. |
| Sessions | [SN-B05](backend-sessions.md) replaced the inherited 12-hour behavior with the approved renewable cookie/session policy and revocation rules. Browser reopen and complete frontend integration remain SN-A07. |
| Followers | Add follow/unfollow, private-profile requests with accept/decline, and immediate following for public profiles. |
| Profiles | Add owner-controlled public/private mode, registration information except password, activity, all user posts, followers and following; enforce follower-only visibility for private profiles. |
| Posts/comments | Retain creation and image/GIF support; add public, followers-only ("almost private"), and selected-followers ("private") post audiences. Existing feed/profile/media access needs review. |
| Groups | Add group title/description, browse-all-groups section, invitations from members with recipient acceptance, join requests decided only by the creator, and members-only posts/comments. |
| Events | Group members can create events with title, description, day/time and at least Going/Not going options; members can respond. |
| Private chat | Apply the assignment's follower relationship rules and recipient delivery conditions, and support emojis. Legacy all-user roster and online-only sending are not new requirements. |
| Group chat | Add shared chat restricted to group members. |
| Notifications | Visible on every page and visually distinct from private-message alerts. Cover follow requests to private profiles, group invitations, join requests to group creators, and events for group members. |
| Persistence | [SN-B08](data-decision.md) approved SQLite, `golang-migrate`, a fresh-database policy and private avatar storage. [SN-B03](backend-migrations.md) implemented startup migrations; later phases still need their own data models. |
| Docker | Separate [frontend](frontend-setup.md#frontend-container-handoff) and [backend](backend-image.md) images passed their independent gates. SN-B07 owns combined startup and hosted verification. |
| Dependencies | Audit against the supplied Go package allowlist, including its migration packages. The old dependency restrictions are not the new authority. |
| Frontend quality | Preserve the assignment's responsiveness and performance objectives during framework migration. |

## Open decisions and interpretations

Resolve these when their implementation phase begins; none blocks documentation capture:

1. **Resolved — framework and migration scope:** [SN-A02](frontend-decision.md) records the owner-approved Vue stack, vertical port, route transition and runtime boundary.
2. **Resolved through Phase 4 — storage direction:** [SN-B08](data-decision.md) approved `golang-migrate`, a fresh initial database and refusal of unversioned forum data. Later approved extensions add one follow-state table, profile visibility, post audiences/selections, separate group/membership/invitation/request tables and optional post `group_id`. Upgrades preserve existing data; SN-B10/B14/B17 produce exact mappings. Events/chat models remain pending.
3. **Phase 5 pending — chat authorization:** the source first requires a follow relationship in either direction, then describes instant delivery when the recipient follows the sender or has a public profile. Clarify treatment when only the sender follows a private recipient, offline sending, and history/attachment access after both users unfollow. The last proposals were unanswered, not approved; do not broaden permissions or inherit the forum's online-only rule silently.
4. **Resolved — profile/post visibility:** the owner chose private-profile restrictions to override a public post audience. The [access matrix](phase-2-3-decisions.md#posts-audiences-and-activity) also records dynamic follower access and per-post selections cleared on unfollow. This is an owner interpretation of ambiguous source wording, not an official audit ruling.
5. **Resolved for Phase 1 — session lifecycle:** [SN-B02](auth-contract.md) and [SN-B05](backend-sessions.md) define persistent login, renewal, expiry and revocation. SN-A07 must verify the full browser journey.
6. **Resolved — inherited features:** preserve all existing capabilities. Categories, reactions, drafts, editing/deletion, private activity and content notices are included in Phase 3; media/privacy prerequisites ship in Phase 2. DM images, presence and other existing chat behavior remain for Phase 5 adaptation. General profile editing and other unimplemented extras were not added by this decision.
7. **Resolved — groups:** [Phase 4](phase-4-decisions.md) records browsable metadata, current-membership content access, creator-only request decisions/removal, ordinary-member departure, preserved contributions, departed-inviter cancellation and fresh return without a ban. Reuse existing posts/content features; events/chat remain pending.

## Next steps

1. **Done:** import all 302 tracked real-time-forum files, preserve the social-network context, add root context pointers, and switch baseline links to imported local files.
2. **Planning extended:** a six-phase roadmap and 36 tickets for Phases 1–4 now exist: 17 original, 7 Phase 2, 6 Phase 3 and 6 Phase 4. New tickets combine roughly three earlier-sized slices per outcome. This authoring pass marks none implemented.
3. **Done:** SN-A01 and SN-B01 verified the frontend/backend baseline and inventoried documentation for cleanup.
4. **Done:** SN-A02, SN-B02 and SN-B08 approved the frontend, auth and storage decisions. SN-A08 aligned the active entry points and archived forum guidance.
5. **Next execution:** SN-B07 evidence is recorded in the tracker; SN-A07 remains the Phase 1 real-service acceptance gate. It unlocks SN-B10 and Phase 2; SN-A11 unlocks Phase 3, and SN-A14 unlocks Phase 4.
6. **Deferred planning:** leave Phase 5 pending and resume events/chat decisions when requested; discuss final delivery before Phase 6 tickets. Current authorization is ticket writing and branch publishing, not application implementation.

The planning pass itself approved no deletion list. SN-A02 now supplies the approved frontend architecture and documentation dispositions. The separate social-network audit checklist has not been supplied; do not substitute the forum audit for it.

## Import verification — 2026-09-17

- Imported source commit: `c7be3753767de1e12ecf96bab2f53cda0fb6c55d`.
- All 302 tracked files matched source bytes at import. At that point, edits were limited to root README/AGENTS context notices and the social-network documentation.
- Existing social-network requirements and docs entry point were preserved.
- `bun install --frozen-lockfile` succeeded without changing the lockfile.
- `make test` passed: both server builds, Biome lint, Go formatting/vet, Go tests, configured race checks, 473 frontend tests, coverage thresholds, and all 29 Chromium E2E tests.
- All 29 links in the social-network context documentation resolve locally; the requirements still match the supplied wording after removing Markdown formatting.
- The staged import contains exactly 302 inherited files plus five social-network documentation files; runtime artifacts remain ignored.
- `git diff --cached --check` reports existing whitespace warnings in imported files. They were preserved to keep this import faithful; documentation/code cleanup remains separate.
- These checks establish the inherited forum baseline, not compliance with the new social-network requirements.
