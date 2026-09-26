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
| Running backend migrations | [Backend migrations](backend-migrations.md) | SN-B03 startup path, fresh database policy and failure recovery |
| Selecting or updating implementation work | [Ticket tracker](ticket-tracker.md) | Phase 1 status and dependencies for two developers; links to tracks A and B |
| Creating or reviewing tickets | [Ticket rules](ticket-rules.md) | Compact format, scope, dependencies and verification; [latest audit](ticket-audit.md) |

## Current checkpoint — 2026-09-26

- Documentation setup and code import are complete. SN-A03 now provides the Vue framework shell and backend-health transport; account and social features are not yet implemented.
- Imported all 302 tracked files from the clean sibling real-time-forum checkout at commit `c7be375`, preserving the social-network docs and this repository's Git identity.
- Root README and AGENTS now point here; inherited docs remain available locally. See [inherited context](inherited-context.md) for provenance and [planning](planning.md) for import verification.
- No legacy files were deleted. Local runtime data, secrets, generated files, and source Git history were excluded.
- Phase 1 has 17 tickets (8 A, 9 B). SN-A03 provides the approved [Vue 3 shell](frontend-setup.md) and passed its local gate. SN-B02's [auth contract](auth-contract.md) is complete after the owner confirmed Dev 1's fixture review on 2026-09-26. The owner approved SN-B08's [storage decision](data-decision.md) on 2026-09-26; SN-B03 is ready to implement.
- Remote `main` includes merged SN-A03 at `fa7ca4d`. Hosted two-image CI evidence remains a future SN-B07 gate.

## Maintenance rules

- Update this checkpoint when project state changes; put supporting detail in the owning context document.
- Distinguish supplied requirements, documented legacy behavior, verified implementation, and proposed decisions.
- Record future approved architecture decisions and implementation progress in dedicated files, linked here when created.
- Before removing a legacy document, preserve useful context and update references. Do not inherit its project-specific constraints without checking the social-network requirements.
