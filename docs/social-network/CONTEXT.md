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
| Reviewing account/session interfaces | [Auth contract](auth-contract.md) | SN-B02 requests, responses, avatar flow, session policy and fixture handoff; owner-approved; Dev 1 fixture review pending |
| Selecting or updating implementation work | [Ticket tracker](ticket-tracker.md) | Phase 1 status and dependencies for two developers; links to tracks A and B |
| Creating or reviewing tickets | [Ticket rules](ticket-rules.md) | Compact format, scope, dependencies and verification; [latest audit](ticket-audit.md) |

## Current checkpoint — 2026-09-24

- Documentation setup and code import are complete; social-network features have not been implemented.
- Imported all 302 tracked files from the clean sibling real-time-forum checkout at commit `c7be375`, preserving the social-network docs and this repository's Git identity.
- Root README and AGENTS now point here; inherited docs remain available locally. See [inherited context](inherited-context.md) for provenance and [planning](planning.md) for import verification.
- No legacy files were deleted. Local runtime data, secrets, generated files, and source Git history were excluded.
- Phase 1 has 17 tickets (8 A, 9 B). SN-A01 and SN-B01 supplied the baseline evidence, and SN-A02 approved [Vue 3, the migration boundary, same-origin proxy topology and backend-owned media](frontend-decision.md). SN-A03 is ready; SN-B02's [owner-approved auth contract](auth-contract.md) awaits Dev 1 fixture review on `asmyrogl/B02`. Decision order continues with SN-B02 → SN-B08; B02's consumers remain gated on frontend fixture review.
- Remote `main` includes merged SN-A02 at `525b19e`. Hosted two-image CI evidence remains a future SN-B07 gate; the inherited application's passing CI does not establish that gate.

## Maintenance rules

- Update this checkpoint when project state changes; put supporting detail in the owning context document.
- Distinguish supplied requirements, documented legacy behavior, verified implementation, and proposed decisions.
- Record future approved architecture decisions and implementation progress in dedicated files, linked here when created.
- Before removing a legacy document, preserve useful context and update references. Do not inherit its project-specific constraints without checking the social-network requirements.
