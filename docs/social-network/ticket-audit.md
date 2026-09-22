# Phase 1 Ticket Audit — 2026-09-22

Scope: active social-network tracks A/B, tracker, roadmap, requirement coverage and the historical forum ticket format. This is a planning audit, not implementation acceptance. No ticket was marked done.

## Findings and corrections

| Finding | Correction |
|---|---|
| The original declared graph had no cycles, but SN-A02 expected compatibility with SN-B02's future auth contract while SN-B02 expected A's runtime proposal | Order approvals explicitly: SN-A02 uses baseline evidence, SN-B02 consumes A's approved constraints, SN-B08 consumes the approved auth contract. No gate waits backward for its consumer. |
| SN-A02 combined framework decisions and documentation cleanup | Move approved cleanup to SN-A08; keep framework selection a decision-only ticket. |
| SN-B02 combined external auth contracts, schema, storage and migration-tool selection | Keep behavior/contracts in SN-B02; extract storage/migration design into SN-B08. |
| SN-B04 bundled account creation and a media upload/ownership lifecycle | Keep account API in SN-B04; add SN-B09 for avatars after account/session implementation. Avatar omission works in the intermediate slice; supplied avatars are not silently ignored. |
| Session work implicitly needed the new account mappings while both tickets appeared independent | SN-B05 now depends on SN-B04; both developers' suggested sequence reflects the actual handoff. |
| Shell verification implied final cookie behavior before that contract existed | SN-A03 verifies routing/build/basic transport; SN-A05 and SN-A07 verify approved auth semantics. |
| Shared CI/browser checks risked depending on final acceptance tests that were themselves waiting for CI setup | SN-B07 owns transport smoke tests and the command hook; SN-A07 later adds full journeys and reruns hosted/local gates. |
| Phase acceptance mixed account age with session age and included writing the next backlog | Test session age beyond 12 hours; keep Phase 2 planning outside the acceptance ticket. |
| Goals/exclusions were often implied and some gates said only “works” | Every ticket now has explicit Goal and Scope, three work bullets and three scenario-based verification bullets. |

## Verification

- 17 unique tickets: 8 A, 9 B. Only SN-A01 and SN-B01 have no prerequisites; all status entries remain not started.
- Dependency and reverse-block lists match definitions and tracker rows. Every ID resolves; no self-dependencies, duplicate edges or cycles.
- All 17 tickets are in the predecessor closure of SN-A07 (including acceptance itself); no required work is disconnected from the phase exit.
- Manual artifact review checked each contract, schema, API, image, documentation and test handoff against its producer. Contract fixtures are allowed only in the specified frontend tickets; phase acceptance requires real services.
- Ticket content is 108–152 words per ticket (Goal, Scope, Work and Verification Gate; metadata excluded). Detailed designs remain planned supporting documents.
- All 128 documentation links/anchors and whitespace checks passed. The graph checker also rejected injected cycles, self-edges, unknown prerequisites and reverse-edge mismatches. Application tests were not rerun: only planning/instruction documents changed.

## Remaining decisions and external constraints

Framework, public interfaces, session policy, schema and storage remain owner decisions in the named tickets. Dependency validation does not grant those approvals or prove the implementation.

A subsequent remote check on 2026-09-22 verified clean import snapshot `b295348` on `main`, with the same source tree as the old branch. Local main was aligned to that baseline while preserving old local main as a backup. The earlier legacy-history push rejection is not carried forward as a current main blocker. SN-B07 still needs actual hosted CI evidence; no CI gate is marked complete by this Git check.

Use the [ticket rules](ticket-rules.md) and rerun graph, scope and handoff checks whenever tickets change; this record describes the audited version, not an indefinite guarantee.
