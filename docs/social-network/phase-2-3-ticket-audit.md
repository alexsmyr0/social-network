# Phase 2–3 Ticket Audit — 2026-10-01

Scope: [approved decisions](phase-2-3-decisions.md), [roadmap](roadmap.md), tracks [A](track-a.md)/[B](track-b.md), [tracker](ticket-tracker.md), [rules](ticket-rules.md) and context links. This is ticket-authoring validation, not application acceptance. Existing Phase 1 statuses/evidence are retained; every new ticket is unstarted.

This records the initial 30-ticket checkpoint. The subsequent [Phase 4 audit](phase-4-ticket-audit.md) covers the expanded 36-ticket backlog and Phase 5 deferral.

## Sizing and boundaries

The owner requested 2–3× earlier implementation scope, leaning toward 3×. The 13 new tickets group related work rather than multiplying prose or adding tickets to balance developers. These are relative work-package comparisons, not time estimates.

| Ticket(s) | Related slices grouped into one outcome |
|---|---|
| SN-B10, SN-B14 | External contracts/examples, schema/upgrade mappings, fixture/access/lifecycle handoff |
| SN-B11 | Profile/discovery APIs, relationship state machine, migrations/authorization tests |
| SN-B12 | Durable notification upgrades, transactional follow integration, realtime/reconnect delivery |
| SN-B13 | Inherited endpoint privacy, protected media migration/lifecycle, shared static/proxy closure |
| SN-A09 | People discovery, full/redacted profiles/lists, privacy/follow controls |
| SN-A10 | Global notice/read UI, incoming-request actions, session-owned realtime lifecycle |
| SN-B15 | Audience/schema upgrades, feed/detail authorization, author publication/media lifecycle |
| SN-B16 | Comment/reaction actions, authorized activity/aggregate queries, content-notice adaptation |
| SN-A12 | Feed/filter browsing, audience-aware authoring/media, draft/edit/publication workflow |
| SN-A13 | Discussions/reactions, profile/private activity, content-notification navigation |
| SN-A11, SN-A14 | Multi-user browser journeys, direct/API/media denial matrix, persistence/regression evidence |

Each ticket retains Goal, Scope, direct Depends on/Blocks, source mapping, Work and Verification Gate. New tickets have four work and four verification bullets. Full policy/architecture detail lives in the decision record; future contracts and acceptance reports are labelled planned artifacts.

## Findings addressed

| Finding | Resolution |
|---|---|
| Earlier guidance allowed only Phase 2 planning after Phase 1 acceptance | Record the owner's explicit Phase 2–3 authoring exception. Preserve runtime gates SN-A07 → Phase 2 and SN-A11 → Phase 3. |
| “Larger tickets” could become word padding or entire-phase tasks | Group about three related slices per outcome; retain compact prose, separate contract handoffs and independent phase acceptance. |
| Private profiles could leak through inherited feeds, activity, notification excerpts or public upload paths | SN-B12 owns notification filtering; SN-B13 owns the remaining inherited content/media boundary in Phase 2. No hidden dependency on Phase 3 audience implementation. |
| Preserving files could be mistaken for preserving user-facing features | Map bonuses to concrete backend/UI tickets and require feature-parity evidence in SN-A14; chat/presence/DM adaptation remains assigned to Phase 5. |
| Applying the Phase 1 fresh-database policy again could erase existing versioned data | Require data-preserving phase upgrades and media recovery; keep unversioned forum refusal separate from valid social-network upgrades. |
| Avatar-only orphan cleanup could delete migrated post/comment/DM files | SN-B13 must recognize every retained media owner and test referenced-file survival and interrupted migration. |
| Repeated follow requests could let an old notification accept a new request | SN-B10 fixes request identity/stale-action outcomes; SN-B11/B12 verify transitions, races and notification reconciliation. |
| Approved product rules could be reopened or unwritten API details treated as approved | Record settled choices separately; B10/B14 translate them into concrete interfaces/fixtures and obtain approval for new interface details before consumers start. |
| UI completion could implicitly wait for backend acceptance | A09/A10 and A12/A13 use reviewed fixtures. A11/A14 explicitly require real services; infrastructure producers do not wait for their consumers' browser tests. |
| Shared Go frontend routes and acceptance CI edits could have competing owners | B owns SN-B13 static/proxy changes and shared runtime/CI changes under SN-B07 (owner removed A review on 2026-10-06); A owns browser scenarios and acceptance reports. |
| Two historical baseline code links referenced line ranges beyond today's shorter files | Pin only those citations to the baseline's immutable `8fdccf5` revision after verifying the original ranges with `git show`; preserve the baseline findings. |

## Verification

Graph/status checks passed against the authored working tree: 30 unique tickets, 14 A and 16 B; exact reverse edges and tracker rows; no unknown/self/duplicate dependencies, cycles or transitive duplicate prerequisites. All phase work reaches its exit: 17 tickets in SN-A07's predecessor closure, 24 in SN-A11's, all 30 in SN-A14's.

Status remains 16 complete and 14 not started, including all 13 new tickets. No completed Phase 1 ticket was renumbered or had its evidence replaced. SN-A07 now directly blocks SN-B10; its wording acknowledges the separately authorized backlog without making authoring an acceptance requirement.

Validation on the authored working tree based on `80dc135`:

- `python3 /tmp/social-network-backlog-check.py` (one-off planning checker): graph, direct/reverse edges, tracker parity, phase exits and unchanged completed evidence pass. New tickets contain 213–220 content words each, excluding source/dependency/external-gate metadata.
- The same checker resolves 585 local links/anchors across 28 active/entry documents, with no failures. The two repaired historical citations were checked against local `git show 8fdccf56e145de404d360707fd1ff3f2db3055ca:<path>` contents; remote URL availability was not network-tested.
- `git diff --check` and whitespace checks on both new Markdown files pass.

Manual review covers approved-choice fidelity, source coverage, inherited-feature ownership, direct artifact handoffs and absence of implementation claims. No application tests, migrations, Docker startup or runtime changes are part of this authoring pass.
