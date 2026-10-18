# Phase 5 Ticket Audit — 2026-10-11

Scope: add the [Phase 5 analysis and proposals](phase-5-decisions.md) to the [roadmap](roadmap.md), tracks [A](track-a.md)/[B](track-b.md), [tracker](ticket-tracker.md) and context. This continues the [Phase 4 audit](phase-4-ticket-audit.md), whose 36-ticket counts describe the earlier checkpoint. The backlog now covers Phases 1–5; Phase 6 remains roadmap-only. Unlike Phases 2–4, the product decisions were **not** settled in an owner interview first, so this pass records them as proposals and gates them in SN-B20.

## Sizing and ownership

Eight tickets keep the existing Goal/Scope, source, dependencies, Work and Verification Gate pattern. Each groups about three earlier-sized slices around one outcome. This is a relative scope comparison, not an estimate in days.

| Ticket | Related slices grouped into one outcome |
|---|---|
| SN-B20 | Owner decisions, event/chat interfaces, schema and upgrade mappings, fixture handoff |
| SN-B21 | Event schema and notice rebuild, member-only event APIs, atomic event notices |
| SN-B22 | Follow-based send permission, offline storage and history rules, unread cursors and DM image access |
| SN-B23 | Group-room storage, membership-checked send/read/delivery, shared realtime fan-out |
| SN-A18 | Event list/detail/creation, Going/Not going responses, event notices |
| SN-A19 | Roster and conversations, emoji and image composer, live frames and distinct indicators |
| SN-A20 | Group room view, per-group indicators, membership-loss handling |
| SN-A21 | Multi-user event and chat journeys, relationship and membership revocation, persistence and regressions |

Events and chat are independent after SN-B20, so SN-B21 and SN-B22 may proceed in parallel. SN-B23 reuses SN-B22's message frames, cursors and unread logic, and SN-A20 reuses SN-A19's components. SN-A18 and SN-A19 start from fixtures. B retains shared runtime and CI ownership under SN-B07; SN-A21 supplies scenarios through that harness. SN-B21 owns the notification-type rebuild; SN-B22 and SN-B23 own the message tables and socket frames, and SN-B20's data plan fixes the migration order so the parallel tickets do not collide.

## Findings addressed

| Finding | Resolution |
|---|---|
| The social DM path checks no follow relationship, so any two active accounts can message while the recipient is online. | SN-B22 enforces the supplied rule at send time, with a matrix gate over every follow state. The gap is recorded in the [analysis](phase-5-decisions.md#current-state-code-inspection-not-fresh-runtime-verification) and roadmap. |
| The DM questions from Phase 4 (asymmetric delivery, offline sending, history after unfollow) were never answered. | Restated with alternatives as proposals. No ticket treats them as approved; SN-B20's external gate requires one owner approval before consumers start. |
| Online-only sending, the all-user roster and browser-only unread counts are forum behavior, not requirements. | Proposed replacements are gated in SN-B20; SN-B22 and SN-A19 implement only what the owner approves. |
| Group chat could expose history to departed members or leak authors' private fields. | SN-B23/SN-A20 require membership at send, read and every frame delivery, retain messages for current members, and keep existing profile-field restrictions. |
| Event notices need a notification-type rebuild that could drop earlier notices. | SN-B21 requires a data-preserving rebuild with ID and read-state checks, as migration 000006 did. |
| Message indicators could merge with notifications. | Separate server-side cursors and badges are required in SN-B22/B23/A19/A20 and re-proved in SN-A21. |
| Existing DM images and presence could be dropped during the Vue port. | SN-B22 and SN-A19 own them; SN-A21 reruns the preserved journeys. No capability deletion is authorized. |
| Writing tickets could look like approving unreviewed policy or starting implementation. | All eight tickets are unstarted, the tracker marks the decisions unapproved, and Phase 5 execution still waits for SN-A17 acceptance. |

## Verification

Validation on the authored working tree based on `9604cb2`:

- `python3 /tmp/sn5/check.py` (one-off planning checker, not committed) passes: 44 unique tickets (21 A, 23 B), known and direct prerequisites, exact reverse edges between track sections, matching tracker rows, no cycles and no transitive duplicate dependencies. SN-A21's predecessor closure contains all 43 other tickets, so the phase exit is reachable from every required ticket.
- Status is 35 complete and 9 not started. SN-A17 now directly blocks SN-B20; the eight Phase 5 tickets are unstarted.
- Every new ticket has four Work and four Verification Gate bullets and 206–239 content words including Goal and Scope (excluding source, dependency and external-gate metadata). The two largest, SN-B20 and SN-A21, are the contract and acceptance tickets and stay under the 250-word review threshold.
- The checker resolves every local link and anchor in the active social-network documents with no broken results. Planned artifacts (`events-chat-contract.md`, `phase-5-data-plan.md`, `fixtures/phase-5-contract.json`, `phase-5-acceptance.md`) are named without links.

Manual review covers fidelity to the supplied [groups](requirements.md#groups), [chat](requirements.md#chat) and [notifications](requirements.md#notifications) text, absence of invented moderation, ownership or event-edit workflows, and absence of any approval claim for unanswered decisions.

No application tests, migrations, Docker startup or runtime changes are part of this documentation-only authoring gate. The current-state findings come from code inspection, not a fresh runtime run. Future ticket gates describe required verification; they do not claim it has passed.

## Approved dependency correction — 2026-10-18

Owner approved full B20 handoff. B22 now depends on B21 rather than directly on B20, because migration 9 requires migration 8. Reverse Blocks, tracker and sequence updated together; frontend A18/A19 remain independently fixture-driven. B21/B22 authoring may overlap; delivery is ordered.
