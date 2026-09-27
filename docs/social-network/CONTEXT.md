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
| Reviewing account/session interfaces | [Auth contract](auth-contract.md) | SN-B02 requests, responses, avatar flow, session policy and approved fixture handoff |
| Reviewing storage and migration choices | [Data decision](data-decision.md) | Owner-approved SN-B08 schema, startup and legacy-data policy |
| Running or recovering backend migrations | [Backend migrations](backend-migrations.md) | SN-B03 startup behavior, legacy refusal, failure recovery and verification |
| Reviewing real account registration | [Backend accounts](backend-accounts.md) | SN-B04 registration validation, account reads and provisional avatar/session behavior |
| Reviewing real sessions and origin enforcement | [Backend sessions](backend-sessions.md) | SN-B05 cookie, login/logout, CSRF and WebSocket revocation behavior |
| Reviewing avatar storage and access | [Backend avatars](backend-avatars.md) | SN-B09 upload validation, private storage, owner retrieval and cleanup |
| Running the backend image | [Backend image](backend-image.md) | SN-B06 build, volume, health and smoke commands |
| Selecting or updating implementation work | [Ticket tracker](ticket-tracker.md) | Phase 1 status and dependencies for two developers; links to tracks A and B |
| Creating or reviewing tickets | [Ticket rules](ticket-rules.md) | Compact format, scope, dependencies and verification; [latest audit](ticket-audit.md) |

## Current checkpoint — 2026-09-27

- Documentation setup and code import are complete. SN-A03 provides the Vue framework shell and backend-health transport; SN-A04 adds contract-driven registration and SN-A05 adds login, session restoration, route gating and global logout against test-only fixtures. Real account/session/media integration remains SN-A07.
- Imported all 302 tracked files from the clean sibling real-time-forum checkout at commit `c7be375`, preserving the social-network docs and this repository's Git identity.
- Root README and AGENTS now point here; inherited docs remain available locally. See [inherited context](inherited-context.md) for provenance and [planning](planning.md) for import verification.
- No legacy files were deleted. Local runtime data, secrets, generated files, and source Git history were excluded.
- Phase 1 has 17 tickets (8 A, 9 B). SN-A03 provides the approved [Vue 3 shell](frontend-setup.md); SN-A04 registration and SN-A05 session UI passed their frontend-only fixture gates. SN-B02's [auth contract](auth-contract.md) is owner-approved. The owner approved SN-B08's [storage decision](data-decision.md) on 2026-09-26. SN-B03 [startup migrations](backend-migrations.md), SN-B04 [account registration](backend-accounts.md), SN-B05 [session lifecycle](backend-sessions.md), SN-B09 [avatars](backend-avatars.md) and SN-B06 [backend image](backend-image.md) passed local gates on 2026-09-27.
- SN-A06 provides the separately buildable `social-network-frontend` image and its documented SN-B07 runtime handoff. A no-cache image build, route/asset/outage/configuration smoke checks and the full repository gate passed on `chbaikas/A06` on 2026-09-27.
- Remote `main` includes merged SN-A06 in PR #12. SN-B09 and SN-B06 are verified on their joint branch. Hosted two-image CI evidence remains a future SN-B07 gate.

## Maintenance rules

- Update this checkpoint when project state changes; put supporting detail in the owning context document.
- Distinguish supplied requirements, documented legacy behavior, verified implementation, and proposed decisions.
- Record future approved architecture decisions and implementation progress in dedicated files, linked here when created.
- Before removing a legacy document, preserve useful context and update references. Do not inherit its project-specific constraints without checking the social-network requirements.
