# SN-A08 documentation alignment

The [approved SN-A02 disposition](frontend-decision.md#approved-documentation-dispositions) and [SN-A01 inventory](frontend-baseline.md#4-documentation-inventory) govern this cleanup. The [Zone01 requirements](requirements.md) and [active tracker](ticket-tracker.md) remain authoritative. No application code or runtime setup was changed.

| Inventory item | Disposition applied | Retained context |
|---|---|---|
| Root README, AGENTS and architecture | Rewritten for the active social-network identity, Vue 3 boundary, approved account contract and Phase 1 state | Original full texts under [forum archive](../archive/real-time-forum/README-archive.md) |
| Forum requirements, audit, PRD, SDS and A/B/C/D tickets | Kept in place with historical notices; removed unavailable PR links and the two external sibling-repository links | The documents themselves remain under `docs/`; [inherited context](inherited-context.md) explains their role |
| Forum PR prompts, workflows and PR template | Rewritten in place to use current tickets, requirements and PR evidence; their forum-specific originals retained | `docs/archive/real-time-forum/prompts/`, `workflows/`, and `pull_request_template.md.txt` |
| Forum scratch plans | Moved out of the active agent scratch directory | `docs/archive/real-time-forum/scratch/` |

Archive copies use `.md.txt` so their historical relative links and instructions are preserved as records without being treated as active Markdown navigation. The old `docs/pr-message/` files were not imported, so the forum tracker no longer links to them. Current PR guidance records evidence in the PR and active tracker.

## Verification

On `chbaikas/A08`, a repository Markdown link and heading-anchor scan checked 45 Markdown files and found **0 unresolved targets or anchors**. `git diff --check` passed. The existing documentation consistency test, `bun x vitest run SPA/tests/unit/docs-consistency.test.js`, passed **10/10**. The active root entry points and rewritten prompts link to current requirements, decisions and tickets; their forum-only instructions are accessible only as historical records. This is a documentation-only gate; no full application or Docker validation is claimed.
