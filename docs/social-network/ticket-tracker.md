# Social Network — Ticket Progress Tracker

Active scope: **Phase 1 — Foundations and account access**. Full scope: [roadmap](roadmap.md). Authority: [Zone01 assignment](requirements.md). The [forum tracker](../ticket-tracker.md) is historical.

## Team and ownership

| Track | Developer | Owns | Details |
|---|---|---|---|
| A | Dev 1 | Frontend decision/app/UI/image, active docs, integrated acceptance | [Track A](track-a.md) |
| B | Dev 2 | Auth/data decisions, migrations/accounts/sessions/avatars, backend image, shared run/CI | [Track B](track-b.md) |

A owns frontend source/config and frontend setup docs. B owns Go/data files and shared Makefile/CI/orchestration edits, including final runtime setup instructions. A supplies frontend commands; coordinate shared README/ignore-file edits before work. Both review contracts. Track counts do not imply equal effort.

## Status and execution rules

Follow the [ticket-writing rules](ticket-rules.md). The [audit record](ticket-audit.md) explains the scope/dependency corrections.

- `[ ]` not started; `[-]` in progress; `[x]` verified complete; `[!]` blocked with a concrete reason.
- Status lives here only. Start scoped implementation after direct prerequisites are `[x]`; decision completion includes owner approval. `Blocks` lists direct consumers only.
- SN-A04/SN-A05 may finish against approved contract fixtures. SN-A07 must exercise real services. SN-B07 supplies the harness without depending on SN-A07's future acceptance tests.
- Link each completed change and verification evidence. Keep failures/skips visible; do not inherit completion from the old forum.
- Remote `main` now provides the clean import baseline. SN-B07 still needs a successful hosted CI run; mark `[!]` with the actual cause if access or publishing blocks that gate.

## Summary

17 tickets: 8 in A, 9 in B. Done: 3. In progress: 0. Blocked: 0. Not started: 14. Ready: SN-A03 and SN-B02. SN-A02 approved Vue 3, the frontend/runtime boundary and documentation dispositions; both direct consumers are now unblocked.

| Status | Ticket | Description | Depends on | Blocks | Evidence / external gate |
|---|---|---|---|---|---|
| [x] | [SN-A01](track-a.md#sn-a01--frontend-baseline-and-documentation-inventory) | Frontend baseline and documentation inventory | None | SN-A02 | [frontend-baseline.md](frontend-baseline.md). `make test` **exit 0**: Biome, gofmt, vet, Go suite, `-race`, Vitest 473/473, Playwright 29/29. The `docs/SDS.md` failure seen while `6262f7b` was in the tree was fixed by removing that commit from `main`, not by editing a test |
| [x] | [SN-B01](track-b.md#sn-b01--backend-and-data-baseline) | Backend and data baseline | None | SN-A02 | [backend-baseline.md](backend-baseline.md). On `8fdccf5`, `go test ./...`, `go vet ./...`, scoped `go test -race`, and `gofmt -l` pass. Report records legacy gaps, transport/media constraints, and SN-A02/B02/B08 decisions. |
| [x] | [SN-A02](track-a.md#sn-a02--approve-frontend-direction) | Approve frontend direction | SN-A01, SN-B01 | SN-B02, SN-A03 | [Approved frontend decision](frontend-decision.md). Owner approval recorded 2026-09-24; Dev 2 transport review recorded from SN-B01; links/anchors and `git diff --check` pass. |
| [ ] | [SN-B02](track-b.md#sn-b02--approve-auth-contracts) | Approve auth contracts | SN-A02 | SN-B08, SN-A04, SN-A05, SN-A08 | Owner approval required |
| [ ] | [SN-A03](track-a.md#sn-a03--framework-shell-and-api-connection) | Framework shell and API connection | SN-A02 | SN-A04, SN-A05 | — |
| [ ] | [SN-B08](track-b.md#sn-b08--approve-account-storage-and-migration-design) | Approve account storage and migration design | SN-B02 | SN-B03 | Owner approval required |
| [ ] | [SN-B03](track-b.md#sn-b03--startup-migrations-and-account-schema) | Startup migrations and account schema | SN-B08 | SN-B04 | — |
| [ ] | [SN-A04](track-a.md#sn-a04--registration-ui) | Registration UI | SN-A03, SN-B02 | SN-A06 | — |
| [ ] | [SN-B04](track-b.md#sn-b04--registration-and-account-api) | Registration and account API | SN-B03 | SN-B05 | — |
| [ ] | [SN-A05](track-a.md#sn-a05--login-session-restoration-and-global-logout-ui) | Login, session restoration and global logout UI | SN-A03, SN-B02 | SN-A06 | — |
| [ ] | [SN-B05](track-b.md#sn-b05--session-lifecycle-and-auth-enforcement) | Session lifecycle and auth enforcement | SN-B04 | SN-B09 | — |
| [ ] | [SN-A08](track-a.md#sn-a08--align-active-project-documentation) | Align active project documentation | SN-B02 | SN-A07 | — |
| [ ] | [SN-B09](track-b.md#sn-b09--avatar-upload-and-account-attachment) | Avatar upload and account attachment | SN-B05 | SN-B06 | — |
| [ ] | [SN-A06](track-a.md#sn-a06--frontend-image-and-runtime-handoff) | Frontend image and runtime handoff | SN-A04, SN-A05 | SN-B07 | — |
| [ ] | [SN-B06](track-b.md#sn-b06--backend-image-and-persistent-storage) | Backend image and persistent storage | SN-B09 | SN-B07 | — |
| [ ] | [SN-B07](track-b.md#sn-b07--shared-run-and-quality-gate) | Shared run and quality gate | SN-A06, SN-B06 | SN-A07 | Hosted CI access and successful run required |
| [ ] | [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance) | Phase 1 integrated acceptance | SN-B07, SN-A08 | None | — |

## Suggested two-developer sequence

| Step | Dev 1 / A | Dev 2 / B | Handoff |
|---|---|---|---|
| 1 | SN-A01 | SN-B01 | Exchange baseline evidence |
| 2 | SN-A02 | Review transport feasibility from SN-B01 | Approve frontend/runtime constraints; no wait for future auth implementation |
| 3 | SN-A03 | SN-B02 | Shell transport can use existing health API; approve final auth contract |
| 4 | SN-A04 | SN-B08, then SN-B03 | UI uses approved fixtures while storage is designed/implemented |
| 5 | SN-A05 | SN-B04, then SN-B05 | Complete UI/session behavior and real account/session backend |
| 6 | SN-A08, then SN-A06 | SN-B09, then SN-B06 | Align docs; deliver image handoffs |
| 7 | Review integration setup | SN-B07 | Shared local/hosted gate; record any actual access blocker |
| 8 | SN-A07 | Review acceptance and resolve backend findings | Complete Phase 1, then separately plan Phase 2 |

This is a suggested sequence, not extra dependency edges. Ready work may move earlier. Owner approvals and hosted-CI access remain visible constraints, not assumed completed work.
