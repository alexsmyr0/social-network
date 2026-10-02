# Phase 4 Ticket Audit — 2026-10-02

Scope: add the [approved Phase 4 group decisions](phase-4-decisions.md) to the [roadmap](roadmap.md), tracks [A](track-a.md)/[B](track-b.md), [tracker](ticket-tracker.md) and context. This continues the [Phase 2–3 audit](phase-2-3-ticket-audit.md), whose 30-ticket counts describe the earlier authoring checkpoint. The combined branch now covers Phases 2–4; Phase 5 is explicitly pending and Phase 6 remains roadmap-only.

## Sizing and ownership

Six new tickets retain the existing Goal/Scope, source, dependencies, Work and Verification Gate pattern. Each groups about three earlier-sized slices around a single outcome, within the requested 2–3× scope. This is a relative scope comparison, not an estimate in days or a reason to enlarge prose.

| Ticket | Related slices grouped into one outcome |
|---|---|
| SN-B17 | Group interfaces/transition examples, schema/upgrade mappings, fixture/access handoff |
| SN-B18 | Group discovery/creation, membership state machine, transactional invitation/request notices |
| SN-B19 | Shared-post schema extension, group publishing/discussions, authorization across feeds/media/aggregates |
| SN-A15 | Group discovery/creation, role-specific membership journeys, actionable global group notices |
| SN-A16 | Group/member home feeds, reused publishing/discussions, activity/notification integration |
| SN-A17 | Multi-user admission/departure journeys, content/API/media access matrix, persistence/regression evidence |

SN-B17 follows Phase 3 acceptance, then enables independent backend work and fixture-based frontend work. SN-B18 owns membership state and atomic invitation/request notices; SN-B19 consumes its predicates and owns content/media consumers. A owns Vue/browser work; B retains shared runtime/CI ownership under SN-B07. SN-A17 combines real services without being a hidden prerequisite of its producers.

## Findings addressed

| Finding | Resolution |
|---|---|
| Earlier planning documents still described Phase 4 as undecided | Record the owner's group approvals, add six unstarted tickets and update every active planning entry point. |
| General Phase 3 author/profile rules could accidentally bypass or hide group content | Explicitly scope those rules to personal posts. Group content requires current membership even for its author; private authors remain readable by members, while profile fields retain their own privacy. |
| Removal could silently become a ban or add moderator/transfer features | Preserve approved fresh readmission; only the creator removes another member. No new roles, ownership transfer or group deletion workflow. |
| Old invitations could regain validity after their inviter rejoins | Cancel pending invitations on departure, require exact action identities, and cover cancellation/readmission and concurrent decisions in contracts and gates. |
| Reusing posts could omit inherited bonus features or media ownership | Assign existing publication, editing, reactions, comments, categories, activity and media flows to B19/A16; preserve departed authors' records/files and prove access revocation separately. |
| Last Phase 5 questions could be mistaken for approvals | Explicitly record delivery/offline/history proposals as unanswered. Author no Phase 5 tickets or speculative models; keep Phase 6 roadmap-only. |
| Ticket publishing could look like feature implementation | All 19 Phase 2–4 tickets remain unstarted. SN-A07 remains next execution work; prior acceptance gates and completed Phase 1 evidence remain intact. |

## Verification

Validation on the authored working tree based on `80dc135`:

- `python3 /tmp/social-network-backlog-check.py` (one-off planning checker) passes: 36 unique tickets, 17 A and 19 B, known/direct prerequisites, exact reverse edges, matching tracker rows, no cycles or transitive duplicate dependencies. Phase-exit predecessor closures contain 17 tickets for SN-A07, 24 for SN-A11, 30 for SN-A14 and all 36 for SN-A17.
- Status remains 16 complete and 20 not started. Completed Phase 1 tracker rows retain their exact evidence; all 19 Phase 2–4 tickets are unstarted. SN-A14 now directly blocks SN-B17, and all Phase 4 work reaches SN-A17.
- All new tickets have four Work and four Verification Gate bullets and 211–220 content words, excluding source/dependency/external-gate metadata. Planned contracts, data plans and acceptance reports are named without broken links to nonexistent artifacts.
- The checker resolves 638 local links/anchors across 30 active/entry documents. Historical source-link repairs from the earlier audit remain checked against local Git objects; no remote URL availability result is claimed.
- `git diff --check` and whitespace checks on all four new Markdown files pass.

Manual review covers approved-choice fidelity, supplied group/notification coverage, inherited-feature ownership, fixture independence, explicit interface approvals and absence of hidden Phase 5 dependencies. Phase 5 deferral does not remove any requirement from the roadmap.

No application tests, migrations, Docker startup or runtime changes are part of this documentation-only authoring gate. Future ticket gates describe required verification; they do not claim it has already passed.
