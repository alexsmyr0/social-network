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
- Biome, whitespace, and 36-ticket totals passed. Final documentation validation checked 157 local links/anchors.

Following that successful combined gate, the profile and notice tests were strengthened to assert live removal of already-displayed protected details on a privacy switch and restoration of currently permitted notification state. The final combined local rerun also passed with exit 0, including all 846 frontend tests, 32 native browser tests and 16 integration journeys (6 A11). Final log: `.tmp/a11-final-local-check.log`. Exploratory email/header failures are recorded above and are not counted as passing acceptance.

## Hosted verification

On 2026-10-05, the fresh [A11 hosted CI run](https://github.com/alexsmyr0/social-network/actions/runs/37296922996) completed successfully on implementation commit `b5306506e9c2e597adac2c224aba51c736b018f8`. The clean Ubuntu runner installed locked dependencies and Chromium/system dependencies, then passed the shared `make check` gate, including 846 frontend tests, 31 native browser tests passing immediately plus one pre-existing A03 registration test passing on its second retry, and 16 integration journeys (6 A11) passing without retries, image persistence/recovery and outage checks. First-attempt downloaded log: `.tmp/a11-hosted-check.log`. The A03 fixture registration success assertion timed out twice before passing under the existing CI retry policy; this is recorded as flaky, not as 32 first-attempt passes. The [second hosted attempt](https://github.com/alexsmyr0/social-network/actions/runs/37296922996/attempts/2) on the identical implementation commit also passed, this time with **846/846 frontend, 32/32 native browser and 16/16 integration tests without test retries**. The original A03 timeout did not recur; its precise cause is unconfirmed and it remains a recorded transient test observation. Second-attempt log: `.tmp/a11-hosted-check-attempt-2.log`. Both hosted attempts also reported a nonfatal Go cache-restore warning; dependency installation, builds and tests completed successfully. Subsequent documentation-only commits record this revision-scoped evidence; they do not change the tested application or tests.

## Acceptance gate update — 2026-10-06

The owner removed cross-developer evidence review from the Track A acceptance tickets and A review from B13 shared-route work. Required local/hosted checks, predecessor completion and owner contract/interface approvals remain in force. The recorded local and hosted checks satisfy [A11's revised gate](track-a.md#sn-a11--accept-profiles-following-and-privacy-end-to-end); the tracker marks A11 complete and SN-B14 is ready. No Dev 2 review is claimed.

The Track A coding agent's 2026-10-05 technical review and local/browser visual checks remain historical evidence. PR HEAD `9017153` also passed [hosted `make check`](https://github.com/alexsmyr0/social-network/actions/runs/37300938344): 846 frontend, 32 native browser and 16 integration tests, including all six A11 journeys. This policy/status update changes documentation only; the verification results remain tied to their tested revisions.
