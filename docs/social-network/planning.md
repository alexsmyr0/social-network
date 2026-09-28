# Social Network — Planning Context

The [Zone01 assignment](requirements.md) is authoritative. The [inherited baseline](inherited-context.md) describes a previous project, not completed social-network requirements. This document records adaptation areas, approved Phase 1 decisions and questions for later phases. It does not approve new architecture choices or removal work.

The [delivery roadmap](roadmap.md) breaks the full assignment into six phases. The [active tracker](ticket-tracker.md) and [track A](track-a.md) / [track B](track-b.md) define Phase 1 only. Use those files for execution order and status; the open questions below remain decision context for later phases.

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
2. **Resolved for Phase 1 — storage and migration policy:** [SN-B08](data-decision.md) approved `golang-migrate`, a fresh database and refusal of legacy forum data. Follower requests, post audiences, group membership, events and chat still need models before their phases. Do not infer date of birth from age.
3. **Chat authorization:** the source first requires a follow relationship in either direction, then describes instant delivery when the recipient follows the sender or has a public profile. Clarify treatment when only the sender follows a private recipient, and how offline delivery should work; do not silently broaden permissions or inherit the forum's online-only rule.
4. **Profile/post visibility interaction:** clarify how a public post behaves when its author has a private profile. The assignment states both rules without explaining their precedence.
5. **Resolved for Phase 1 — session lifecycle:** [SN-B02](auth-contract.md) and [SN-B05](backend-sessions.md) define persistent login, renewal, expiry and revocation. SN-A07 must verify the full browser journey.
6. **Optional inherited features:** categories, reactions, drafts, DM images, presence UI, and other forum extras need explicit keep/adapt/remove decisions. They are not automatically required by this assignment.

## Next steps

1. **Done:** import all 302 tracked real-time-forum files, preserve the social-network context, add root context pointers, and switch baseline links to imported local files.
2. **Planning complete:** a six-phase roadmap and 17 Phase 1 tickets now exist; none is marked implemented by this planning work.
3. **Done:** SN-A01 and SN-B01 verified the frontend/backend baseline and inventoried documentation for cleanup.
4. **Done:** SN-A02, SN-B02 and SN-B08 approved the frontend, auth and storage decisions. SN-A08 aligned the active entry points and archived forum guidance.
5. **Next:** SN-B07 must prove combined startup and hosted CI. SN-A07 then verifies real-service browser journeys. After Phase 1 acceptance, reassess the roadmap and scope Phase 2 tickets.

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
