# Social Network — Project Context

This is the central entry point for social-network. Keep this file small: store detailed requirements, implementation context, and decisions in linked documents.

## Goal and authority

Build the Zone01 Facebook-like social network, using reusable parts of real-time-forum where they fit. The [Zone01 requirements](requirements.md) define the target. Legacy forum constraints do not override them; in particular, social-network requires a JavaScript framework.

## Context map

| Read when | Document | Owns |
|---|---|---|
| Establishing scope or checking a requirement | [Requirements](requirements.md) | Full supplied Zone01 assignment, with formatting only |
| Understanding the starting point | [Inherited context](inherited-context.md) | Source documents, inherited architecture/features, evidence limits, documentation conflicts |
| Planning adaptation or documentation cleanup | [Planning](planning.md) | Requirement gaps, unresolved decisions, staged next steps |
| Understanding the complete delivery scope | [Roadmap](roadmap.md) | Six phases, requirement coverage, open decisions and phase boundaries |
| Implementing profiles, follows, posts and audiences | [Phase 2–3 decisions](phase-2-3-decisions.md) | Owner-approved privacy, relationship/content behavior, architecture and inherited-feature preservation |
| Implementing groups and membership | [Phase 4 decisions](phase-4-decisions.md) | Owner-approved discovery, admission/departure, group content and storage; Phase 5 deferral |
| Reviewing account/session interfaces | [Auth contract](auth-contract.md) | SN-B02 requests, responses, avatar flow, session policy and approved fixture handoff |
| Reviewing storage and migration choices | [Data decision](data-decision.md) | Owner-approved SN-B08 schema, startup and legacy-data policy |
| Running or recovering backend migrations | [Backend migrations](backend-migrations.md) | SN-B03 startup behavior, legacy refusal, failure recovery and verification |
| Reviewing real account registration | [Backend accounts](backend-accounts.md) | SN-B04 registration validation, account reads and provisional avatar/session behavior |
| Reviewing real sessions and origin enforcement | [Backend sessions](backend-sessions.md) | SN-B05 cookie, login/logout, CSRF and WebSocket revocation behavior |
| Reviewing avatar storage and access | [Backend avatars](backend-avatars.md) | SN-B09 upload validation, private storage, owner retrieval and cleanup |
| Running both images or shared checks | [Shared runtime](shared-runtime.md) | SN-B07 startup/stop and isolated local and hosted gates |
| Reviewing Phase 1 account acceptance | [Phase 1 acceptance](phase-1-acceptance.md) | SN-A07 real-service journeys, persistence and verification evidence |
| Running the backend image | [Backend image](backend-image.md) | SN-B06 build, volume, health and smoke commands |
| Reviewing active architecture | [Architecture](../../architecture.md) | Current Vue/Go boundary and delivered Phase 1 scope |
| Reviewing documentation alignment | [Documentation alignment](documentation-alignment.md) | SN-A08 dispositions, historical destinations and link checks |
| Selecting or updating implementation work | [Ticket tracker](ticket-tracker.md) | Phase 1–4 status and dependencies for two developers; Phase 5 pending; links to tracks A and B |
| Creating or reviewing tickets | [Ticket rules](ticket-rules.md) | Compact format, larger Phase 2–4 scope, dependencies and verification; [latest audit](phase-4-ticket-audit.md), [Phase 2–3 audit](phase-2-3-ticket-audit.md), [Phase 1 audit](ticket-audit.md) |

## Current checkpoint — 2026-10-02

- Documentation setup and code import are complete. SN-A03 provides the Vue framework shell and backend-health transport; SN-A04 adds contract-driven registration and SN-A05 adds login, session restoration, route gating and global logout against test-only fixtures. Real account/session/media integration remains SN-A07.
- Imported all 302 tracked files from the clean sibling real-time-forum checkout at commit `c7be375`, preserving the social-network docs and this repository's Git identity.
- Root README and AGENTS now point here; inherited docs remain available locally. See [inherited context](inherited-context.md) for provenance and [planning](planning.md) for import verification.
- The initial import preserved legacy files while excluding local runtime data, secrets, generated files, and source Git history. SN-A08 later moved forum scratch plans to the historical archive and retained copies of rewritten entry points.
- Phase 1 has 17 tickets (8 A, 9 B). SN-A03 provides the approved [Vue 3 shell](frontend-setup.md); SN-A04 registration and SN-A05 session UI passed their frontend-only fixture gates. SN-B02's [auth contract](auth-contract.md) is owner-approved. The owner approved SN-B08's [storage decision](data-decision.md) on 2026-09-26. SN-B03 [startup migrations](backend-migrations.md), SN-B04 [account registration](backend-accounts.md), SN-B05 [session lifecycle](backend-sessions.md), SN-B09 [avatars](backend-avatars.md) and SN-B06 [backend image](backend-image.md) passed local gates on 2026-09-27.
- SN-A06 provides the separately buildable `social-network-frontend` image and its documented SN-B07 runtime handoff. A no-cache image build, route/asset/outage/configuration smoke checks and the full repository gate passed on `chbaikas/A06` on 2026-09-27.
- SN-A08 aligns the active README, AGENTS, architecture and workflow guidance with the approved social-network decisions; imported forum material remains accessible as historical evidence.
- [PR #15 — feat(SN-B07): add shared runtime and quality gate](https://github.com/alexsmyr0/social-network/pull/15) merged as `e34874b` on 2026-09-30, then was reverted in `53fb158` for resubmission with complete records; no implementation defect was identified. Hosted `make check` passed on `c771a6f`, and the owner reported local `make test-images` passed on `e34874b`, including both builds, persistence, transport/outage and cleanup. The [shared runtime record](shared-runtime.md#verification-record) distinguishes these historical results from fresh resubmission HEAD checks.
- SN-B07 restoration is merged as `80dc135` ([PR #16](https://github.com/alexsmyr0/social-network/pull/16)); 16 of 17 Phase 1 tickets are complete. **SN-A07 — Phase 1 integrated acceptance** is in progress in [PR #17](https://github.com/alexsmyr0/social-network/pull/17): real-service browser journeys and local/hosted `make check` gates passed. [Acceptance evidence](phase-1-acceptance.md) records the remaining Dev 2 review.
- The owner approved [Phase 2–3 product/architecture decisions](phase-2-3-decisions.md), then [Phase 4 groups/membership decisions](phase-4-decisions.md), and required preservation of existing features. Nineteen larger tickets have been added: 7 for Phase 2, 6 for Phase 3 and 6 for Phase 4, bringing the backlog to 36. All new tickets remain unstarted; authoring does not complete preceding acceptance or authorize application implementation in this planning session.
- **Phase 5 is pending** at the owner's request. The unanswered DM-delivery/offline/history proposals are not approved. Phase 6 remains roadmap-only; both phases need further decisions before tickets. The approved Phase 2–4 backlog is merged in [PR #18](https://github.com/alexsmyr0/social-network/pull/18).

## Maintenance rules

- Update this checkpoint when project state changes; put supporting detail in the owning context document.
- Distinguish supplied requirements, documented legacy behavior, verified implementation, and proposed decisions.
- Record future approved architecture decisions and implementation progress in dedicated files, linked here when created.
- Before removing a legacy document, preserve useful context and update references. Do not inherit its project-specific constraints without checking the social-network requirements.
