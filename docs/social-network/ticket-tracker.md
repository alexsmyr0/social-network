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
- SN-B07 has successful hosted and local verification recorded in the [shared runtime guide](shared-runtime.md#verification-record). Keep historical evidence tied to its tested revision; resubmission PRs must report checks on their own HEAD separately.

## Summary

17 tickets: 8 in A, 9 in B. Done: 16. In progress: 1. Blocked: 0. Not started: 0. SN-A07 awaits Dev 2 evidence review.

| Status | Ticket | Description | Depends on | Blocks | Evidence / external gate |
|---|---|---|---|---|---|
| [x] | [SN-A01](track-a.md#sn-a01--frontend-baseline-and-documentation-inventory) | Frontend baseline and documentation inventory | None | SN-A02 | [frontend-baseline.md](frontend-baseline.md). `make test` **exit 0**: Biome, gofmt, vet, Go suite, `-race`, Vitest 473/473, Playwright 29/29. The `docs/SDS.md` failure seen while `6262f7b` was in the tree was fixed by removing that commit from `main`, not by editing a test |
| [x] | [SN-B01](track-b.md#sn-b01--backend-and-data-baseline) | Backend and data baseline | None | SN-A02 | [backend-baseline.md](backend-baseline.md). On `8fdccf5`, `go test ./...`, `go vet ./...`, scoped `go test -race`, and `gofmt -l` pass. Report records legacy gaps, transport/media constraints, and SN-A02/B02/B08 decisions. |
| [x] | [SN-A02](track-a.md#sn-a02--approve-frontend-direction) | Approve frontend direction | SN-A01, SN-B01 | SN-B02, SN-A03 | [Approved frontend decision](frontend-decision.md). Owner approval recorded 2026-09-24; Dev 2 transport review recorded from SN-B01; links/anchors and `git diff --check` pass. |
| [x] | [SN-B02](track-b.md#sn-b02--approve-auth-contracts) | Approve auth contracts | SN-A02 | SN-B08, SN-A04, SN-A05, SN-A08 | [Owner-approved auth contract](auth-contract.md), merged in PR #4. Owner approved on 2026-09-24; owner explicitly confirmed Dev 1's A04/A05 fixture review in chat on 2026-09-26. No runtime implementation or passing API tests claimed. |
| [x] | [SN-A03](track-a.md#sn-a03--framework-shell-and-api-connection) | Framework shell and API connection | SN-A02 | SN-A04, SN-A05 | [Vue shell and frontend commands](frontend-setup.md). `make test` **exit 0**: builds, Biome, gofmt/vet, Go suite and race checks, Vitest 488/488 with coverage, Playwright 5/5; desktop and 360px visual QA completed. |
| [x] | [SN-B08](track-b.md#sn-b08--approve-account-storage-and-migration-design) | Approve account storage and migration design | SN-B02 | SN-B03 | [Approved storage decision](data-decision.md) in PR #6. Owner approved fresh DB, `golang-migrate` and private avatar storage in chat on 2026-09-26; no client-facing contract change. Documentation checks passed; no runtime behavior claimed. |
| [x] | [SN-B03](track-b.md#sn-b03--startup-migrations-and-account-schema) | Startup migrations and account schema | SN-B08 | SN-B04 | [Migration and recovery record](backend-migrations.md). On `ticket/sn-b03-b04-account-foundations`, `go test ./...` and `make test` exit 0: build, Biome, gofmt/vet, Go suite/race, Vitest 522/522, Playwright 9/9. Startup tests cover empty/repeated/failed boot, dirty version, preserved legacy file, account constraints and independent session rows. |
| [x] | [SN-A04](track-a.md#sn-a04--registration-ui) | Registration UI | SN-A03, SN-B02 | SN-A06 | Frontend-only contract fixtures: `bun run test:a04` 34/34; `make test` exit 0 with Vitest 522/522 and Playwright 9/9. Required/optional payloads, JPEG/PNG/GIF preview/removal (invalid replacement discards the earlier file), validation, duplicate email, ambiguous-registration recovery in contract order (`/users/me` → explicit login → explicit retry), duplicate-submit prevention, accessible avatar errors/focus, keyboard and 360px/desktop checks pass. Real backend/media integration remains SN-A07. |
| [x] | [SN-B04](track-b.md#sn-b04--registration-and-account-api) | Registration and account API | SN-B03 | SN-B05 | [Account API record](backend-accounts.md). On `ticket/sn-b03-b04-account-foundations`, `go test ./internal/tests -run TestSocial -count=1` and `make test` exit 0. Versioned API tests cover required/optional registration, validation/duplicate errors, readback and secret exclusion, no partial account on invalid/avatar input, explicit avatar 503, multipart text and existing-session rejection. B05 owns final session policy. |
| [x] | [SN-A05](track-a.md#sn-a05--login-session-restoration-and-global-logout-ui) | Login, session restoration and global logout UI | SN-A03, SN-B02 | SN-A06 | Frontend-only contract fixtures on PR #10: `bun run test:a05` 34/34; `make test` exit 0 with Vitest 540/540 and Playwright 13/13. Valid/invalid login, restored sessions, guarded deep links, 401 versus outage handling, duplicate-submit prevention, successful/failed logout, protected-state/resource cleanup, back-navigation revalidation, cross-tab logout and mobile/desktop access pass. Real persistence remains SN-A07. |
| [x] | [SN-B05](track-b.md#sn-b05--session-lifecycle-and-auth-enforcement) | Session lifecycle and auth enforcement | SN-B04 | SN-B09 | [Session lifecycle record](backend-sessions.md). On `ticket/sn-b05-session-lifecycle`, scoped social API and race tests plus `make test` exited 0. Tests cover real login, 13-hour/30-day/401-day validity, renewable cookie flags, independent devices, idempotent logout, concurrent write/logout ordering, restart replay denial, origin/header checks, failure handling and retained-socket revocation. Browser-profile reopen remains SN-A07. |
| [x] | [SN-A08](track-a.md#sn-a08--align-active-project-documentation) | Align active project documentation | SN-B02 | SN-A07 | [Documentation alignment](documentation-alignment.md): approved dispositions applied; 45 Markdown files checked, 0 broken links/anchors, `git diff --check`, docs-consistency Vitest 10/10, and review `make test` (Vitest 540/540, Playwright 13/13) passed. |
| [x] | [SN-B09](track-b.md#sn-b09--avatar-upload-and-account-attachment) | Avatar upload and account attachment | SN-B05 | SN-B06 | [Avatar implementation and tests](backend-avatars.md). On `ticket/sn-b09-b06-avatar-backend-image`, social avatar API tests and `make test` exit 0; JPEG/PNG/GIF, limits, owner-only retrieval, atomic account/session, duplicate submission, failed-write cleanup and startup orphan recovery covered. |
| [x] | [SN-A06](track-a.md#sn-a06--frontend-image-and-runtime-handoff) | Frontend image and runtime handoff | SN-A04, SN-A05 | SN-B07 | [Frontend image handoff](frontend-setup.md#frontend-container-handoff). No-cache image build; health/auth/deep-link/JS/CSS smoke; runtime target and JSON `502` outage checks; non-root/distinct-image inspection; `make test` exit 0 with Vitest 540/540 and Playwright 13/13. |
| [x] | [SN-B06](track-b.md#sn-b06--backend-image-and-persistent-storage) | Backend image and persistent storage | SN-B09 | SN-B07 | [Backend image and run instructions](backend-image.md). `docker build -q -t social-network-backend .` and `scripts/smoke-backend-image.sh social-network-backend` exit 0: clean migration, account/avatar/login/logout, retained session and media after container recreation, invalid DB/media readiness refusal. `make test` exit 0. |
| [x] | [SN-B07](track-b.md#sn-b07--shared-run-and-quality-gate) | Shared run and quality gate | SN-A06, SN-B06 | SN-A07 | [Shared runtime and verification record](shared-runtime.md#verification-record). [Hosted `make check`](https://github.com/alexsmyr0/social-network/actions/runs/36574650827) passed on `c771a6f`; owner-reported local `make test-images` passed on PR #15 merge `e34874b`: both image builds, backend persistence smoke, Playwright transport 2/2, stopped-backend outage and cleanup. Reverted in `53fb158` for resubmission; fresh HEAD checks are recorded separately in the resubmission PR. |
| [-] | [SN-A07](track-a.md#sn-a07--phase-1-integrated-acceptance) | Phase 1 integrated acceptance | SN-B07, SN-A08 | None | [Local acceptance record](phase-1-acceptance.md) on `chbaikas/A07`: reviewed local `make check` exited 0 on `541d1ad`; A07 real-service journeys 7/7, image browser suite 9/9, native Playwright 15/15, Vitest 540/540, backend smoke and outage checks passed. [Hosted `make check`](https://github.com/alexsmyr0/social-network/actions/runs/36782718815) passed on reviewed `f230451` with image browser 9/9; Dev 2 evidence review remains. |

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
