# Phase 2 Integrated Acceptance — SN-A11

Implementation on `chbaikas/A11`, based on `078016c` (merged SN-A10). Status is maintained in the [tracker](ticket-tracker.md). The [approved profile contract](profiles-contract.md), [Phase 2–3 decisions](phase-2-3-decisions.md) and [B13 media boundary](backend-content-media.md) control the acceptance expectations.

## Setup and scope

[A11 browser journeys](../../SPA/tests/e2e/a11-acceptance.test.js) extend the existing B07 [isolated two-image hook](shared-runtime.md). Every account is registered through the real API into a fresh disposable Compose database/media volume; browser contexts have independent real session cookies. No HTTP/socket responses, SQL users, follow rows or notices are mocked or seeded. The retained PNG registration fixture is an actual upload, checked byte-for-byte through avatar and post media URLs.

Container recreation refuses execution outside B07's `sn-b07-test-*` project. The test suite recreates only that project's backend with the same retained volume; B07 cleans the disposable stack and storage. Existing development containers and data remain untouched. The local Docker daemon was already running; it was not started by this task.

```bash
make test-browser PLAYWRIGHT_ARGS=a11
GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make check
```

A11 tests belong in `playwright.integration.config.ts`, alongside A07/B07/B13. They deliberately require both images and are not added to the native fixture browser configuration. Existing native tests still run in the combined gate.

## Acceptance coverage

| Area | Concrete checks |
|---|---|
| Discovery and profiles | Public default and readable avatar; literal name discovery; owner-only private details; four-key teasers for follower/pending/outsider; denied avatar and follower lists; private members in an authorized follower list remain teasers. |
| Relationships | Real UI request/accept and automatic full-profile revalidation; wrong-recipient decision denial; cancel/retry with new IDs; stale-ID refusal; decline and resolved notice history; private-to-public auto-accept retaining IDs; public-to-private retaining accepted followers; unfollow immediately revokes cached fields and bytes; public follow immediately accepts. |
| Global notifications | Real recipient signals, unread totals, recipient-only read actions, reading leaves requests actionable, another tab's read/decision convergence, all supported shell routes, one socket across navigation, actual socket close/reconnect and missed-notice recovery, payload-free signals and all-read reconciliation. |
| Inherited content/privacy | Owner/accepted-follower versus pending/outsider matrix across post/comment/detail/navigation/media; feed/category/history/activity filtering; totals exclude a newly hidden post before pagination; drafts are owner-only; denied writes; hidden notification rows, excerpts and badges disappear while stored unread survives read-all and access restoration. |
| Direct media | Exact authorized bytes, current permission after unfollow, deletion invalidates an old URL, anonymous 401, denied raw/encoded/static/media aliases, no-store and a single nosniff header through the frontend proxy. The full gate also executes B13's legacy-media recovery/static-denial smoke with actual source mounts. |
| Recovery | Two backend container recreations retain accounts/cookies, follow IDs, pending notice IDs/read states, private avatars and post bytes; a post-restart decision succeeds and grants current access. |
| Browser behavior | Direct links, follower-list navigation/back, keyboard unfollow, notice open/Escape focus, logout/back/direct-entry protection, fresh login without restored revoked details, 360px/desktop widths and visual captures. |

The backend [migration/failure recovery record](backend-migrations.md) and [B13 upgrade/recovery record](backend-content-media.md#upgrade-and-recovery-handoff) retain revision-scoped historical evidence. Current `make check` additionally runs Go migrations/privacy/media tests and the existing legacy-media image smoke; no new Phase 3 audience behavior or Phase 5 DM policy is introduced.

## Review correction

The first run exposed a test expectation using mixed-case email instead of the approved lowercase readback, and an actual proxy defect: both frontend and backend supplied `X-Content-Type-Options`, producing `nosniff, nosniff` on the wire. A11 corrects the expected registration email and strips the duplicate upstream value before the frontend's existing security header is sent. `TestMediaProxyKeepsSingleNosniffHeader` proves a single exact value while preserving status, no-store and response bytes. The A11 image journey independently checks the real media response. No privacy, API shape or product decision changes.

## Local verification

On 2026-10-05, the working tree on `chbaikas/A11` based on `078016c` passed:

- The B13 A-side route review and the new single-nosniff proxy regression: `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" go test ./cmd/frontend -run 'TestMediaProxyKeepsSingle|TestMediaAliases|TestPrivateStatic' -count=1` — exit 0.
- `make stack-build test-browser PLAYWRIGHT_ARGS=a11` after the proxy correction — **6/6 A11 journeys**, plus real stopped-backend outage handling and disposable stack cleanup.
- `GOCACHE="$PWD/.tmp/go-cache" GOTMPDIR="$PWD/.tmp/go-tmp" make check` — **exit 0**: build, Biome, gofmt, vet, native Go/configured race suites, Vitest **846/846** with coverage gates, native Playwright **32/32**, both image builds, backend restart/avatar/session smoke, legacy-media two-image recovery/static-denial smoke, integration Playwright **16/16** (including A11 **6/6**), outage handling and isolated cleanup. Local log: `.tmp/a11-local-check.log`.
- Visual inspection of `.tmp/a11-desktop.png` and `.tmp/a11-360px.png`: readable teaser/name/controls, no previously authorized email or avatar, no horizontal overflow and visible keyboard focus.
- Biome, whitespace, 148 changed-document local links/anchors and 36-ticket totals passed.

Following that successful combined gate, the profile and notice tests were strengthened to assert live removal of already-displayed protected details on a privacy switch and restoration of currently permitted notification state. The final combined local rerun also passed with exit 0, including all 846 frontend tests, 32 native browser tests and 16 integration journeys (6 A11). Final log: `.tmp/a11-final-local-check.log`. Exploratory email/header failures are recorded above and are not counted as passing acceptance.

## Hosted verification

A fresh workflow run on the A11 implementation is required. A10's successful CI is predecessor evidence only and does not satisfy A11's hosted gate.

## Developer evidence review

The Track A coding agent's technical review and executed evidence will be recorded. Dev 2 evidence review remains unconfirmed; it must not be inferred from passing tests, a workflow run or a merge. A11 stays in progress until required local/hosted checks and both-developer evidence review are satisfied, as specified by [Track A's A11 gate](track-a.md#sn-a11--accept-profiles-following-and-privacy-end-to-end). This is a phase acceptance review, not another approval of the already-approved contract/fixtures.
