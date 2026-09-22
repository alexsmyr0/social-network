# Social Network — Planning Context

The [Zone01 assignment](requirements.md) is authoritative. The [inherited baseline](inherited-context.md) describes a previous project, not completed social-network requirements. This document records gaps and questions; it does not approve architecture choices or removal work.

The [delivery roadmap](roadmap.md) now breaks the full assignment into six phases. The [active tracker](ticket-tracker.md) and [track A](track-a.md) / [track B](track-b.md) define Phase 1 only. Use those files for execution order and status; the questions below remain decision context.

## Adaptation areas

| Area | Required change or verification |
|---|---|
| Frontend | A JavaScript framework is required. The inherited vanilla-JS application cannot satisfy that requirement unchanged. Framework and migration approach remain undecided. |
| Registration | Require email, password, first name, last name, and date of birth. Show optional avatar, nickname, and about-me inputs. The legacy age/gender/required-username model needs review. |
| Sessions | Sessions and cookies remain mandatory. Reconcile inherited 12-hour expiry with the stated login persistence until explicit logout. |
| Followers | Add follow/unfollow, private-profile requests with accept/decline, and immediate following for public profiles. |
| Profiles | Add owner-controlled public/private mode, registration information except password, activity, all user posts, followers and following; enforce follower-only visibility for private profiles. |
| Posts/comments | Retain creation and image/GIF support; add public, followers-only ("almost private"), and selected-followers ("private") post audiences. Existing feed/profile/media access needs review. |
| Groups | Add group title/description, browse-all-groups section, invitations from members with recipient acceptance, join requests decided only by the creator, and members-only posts/comments. |
| Events | Group members can create events with title, description, day/time and at least Going/Not going options; members can respond. |
| Private chat | Apply the assignment's follower relationship rules and recipient delivery conditions, and support emojis. Legacy all-user roster and online-only sending are not new requirements. |
| Group chat | Add shared chat restricted to group members. |
| Notifications | Visible on every page and visually distinct from private-message alerts. Cover follow requests to private profiles, group invitations, join requests to group creators, and events for group members. |
| Persistence | SQLite is required. Provide startup-applied migrations in a dedicated folder with a database connection/migration entry point. Select the migration tool and layout later. |
| Docker | Provide separate frontend and backend images, communicating correctly with suitable exposed ports. Confirm the inherited packaging before adapting it. |
| Dependencies | Audit against the supplied Go package allowlist, including its migration packages. The old dependency restrictions are not the new authority. |
| Frontend quality | Preserve the assignment's responsiveness and performance objectives during framework migration. |

## Open decisions and interpretations

Resolve these when their implementation phase begins; none blocks documentation capture:

1. **Framework and migration scope:** choose the framework with the owner before replacing the frontend or deciding which parts to port.
2. **Data model and migration policy:** agree follower requests, post audiences, group membership/events/chat models, migration tooling, and whether existing user data must survive the transition. Do not infer date of birth from age.
3. **Chat authorization:** the source first requires a follow relationship in either direction, then describes instant delivery when the recipient follows the sender or has a public profile. Clarify treatment when only the sender follows a private recipient, and how offline delivery should work; do not silently broaden permissions or inherit the forum's online-only rule.
4. **Profile/post visibility interaction:** clarify how a public post behaves when its author has a private profile. The assignment states both rules without explaining their precedence.
5. **Session lifecycle:** settle how to meet persistent login while handling expiry and revocation; the inherited 12-hour limit is not equivalent to the stated behavior.
6. **Optional inherited features:** categories, reactions, drafts, DM images, presence UI, and other forum extras need explicit keep/adapt/remove decisions. They are not automatically required by this assignment.

## Next steps

1. **Done:** import all 302 tracked real-time-forum files, preserve the social-network context, add root context pointers, and switch baseline links to imported local files.
2. **Planning complete:** a six-phase roadmap and 17 Phase 1 tickets now exist; none is marked implemented by this planning work.
3. Start SN-A01 and SN-B01 to verify the frontend/backend baseline and inventory documentation for cleanup.
4. Use SN-A02 → SN-B02 → SN-B08 for approved frontend, auth and storage decisions; SN-A08 owns approved documentation cleanup. Follow [ticket rules](ticket-rules.md) when changing the backlog.
5. Execute the remaining Phase 1 dependencies and verification gates, then scope Phase 2 tickets after integrated acceptance.

No deletion list or implementation architecture has been approved by this documentation pass. The separate social-network audit checklist has not been supplied; do not substitute the forum audit for it.

## Import verification — 2026-09-17

- Imported source commit: `c7be3753767de1e12ecf96bab2f53cda0fb6c55d`.
- All 302 tracked files matched source bytes at import. Subsequent edits are limited to root README/AGENTS context notices and the social-network documentation.
- Existing social-network requirements and docs entry point were preserved.
- `bun install --frozen-lockfile` succeeded without changing the lockfile.
- `make test` passed: both server builds, Biome lint, Go formatting/vet, Go tests, configured race checks, 473 frontend tests, coverage thresholds, and all 29 Chromium E2E tests.
- All 29 links in the social-network context documentation resolve locally; the requirements still match the supplied wording after removing Markdown formatting.
- The staged import contains exactly 302 inherited files plus five social-network documentation files; runtime artifacts remain ignored.
- `git diff --cached --check` reports existing whitespace warnings in imported files. They were preserved to keep this import faithful; documentation/code cleanup remains separate.
- These checks establish the inherited forum baseline, not compliance with the new social-network requirements.
