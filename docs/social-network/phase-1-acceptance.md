# Phase 1 integrated acceptance — SN-A07

Status: implementation, local and hosted verification complete on `chbaikas/A07`; Dev 2 evidence review remains open. Ticket status is maintained in the [tracker](ticket-tracker.md).

## Scope and setup

The [A07 browser suite](../../SPA/tests/e2e/a07-acceptance.test.js) runs against the two real images through B07's isolated `make test-browser` hook. Every run creates disposable SQLite/media storage and a unique Compose project; no API responses are mocked. Three tiny [avatar fixtures](../../SPA/tests/fixtures/a07/) exercise JPEG, PNG and GIF decoding. The browser profile test creates a temporary persistent Chromium profile, closes and reopens the browser, force-recreates the backend container twice with its Compose volume retained, then verifies the same account, session and avatar. The suite refuses container recreation unless B07 supplied an isolated `sn-b07-test-*` Compose project. It removes its browser profile, and B07's harness removes its containers, network and volume.

## Verified journeys

| Journey | Evidence |
|---|---|
| Required-only account | Browser registration submits an uppercase email and reads back its lowercase form, null optional fields and fallback display name. Protected home renders; the browser cookie is HTTP-only, SameSite=Lax, Path=/, non-Secure on local HTTP and valid for more than 399 days. |
| Full account and media | Separate browser registrations with nickname, about-me and JPEG, PNG or GIF each return the exact uploaded owner avatar bytes and the correct content type. Anonymous retrieval returns 401; another signed-in account gets 404 for the PNG avatar. |
| Failures and access | Corrupt PNG returns an avatar error without creating a partial account; retry with the same email succeeds. Case-changed duplicate email is rejected and the original account can still log in. Wrong password fails, correct password succeeds, and unauthenticated protected entry is redirected. |
| Logout and navigation | The shared shell signs out, protected content disappears when Back revisits a protected URL and on direct entry, a captured revoked cookie cannot read `/users/me`, and fresh login works. |
| Persistence | Closing and reopening a persistent browser profile restores protected content. Each of two backend container recreations with the same storage preserves the user, session and exact avatar bytes; logout still revokes access. |
| Viewports and keyboard | Desktop Chromium runs the journeys; 360px Chromium checks form width, Tab focus from email to password, registration and visible Sign out. |

B05's [controlled-time session tests](backend-sessions.md) cover an unrevoked session at 13 hours, 30 days and beyond the 400-day browser-cookie lifetime. A07 tests browser persistence and container recreation with a real cookie; it does not advance account age as a substitute for session age. B07's [transport checks](shared-runtime.md) cover WebSocket revocation and stopped-backend `502` behavior.

## Local verification record

On 2026-10-01, implementation commit `7ab36c4`:

- An earlier `make test-browser` run exited 0 with A07 journeys 7/7 and B07 transport 2/2. The final assertions were then strengthened and verified in the complete gate below.
- `make check` exited 0: build/lint/format/vet, Go suites and scoped race checks, Vitest 540/540, native Playwright 15/15, both image builds, backend persistence smoke, image Playwright 9/9 (including A07 7/7), and outage smoke. The image stack and volume were removed.
- `bun x biome check SPA/tests/e2e/a07-acceptance.test.js` and `git diff --check` exited 0.

The first local run found an ambiguous `role=status` test locator; the second found expectations that did not match browser history and the server's duplicate-email message. Those test assertions were corrected. The final full gate above passed; no application-code change was needed.

## Review correction and local recheck

On 2026-10-01, review commit `541d1ad` strengthened the browser assertions: uppercase email normalization, persistent-cookie attributes, navigation back to a protected URL, exact avatar bytes, verification after **each** backend recreation and a guard against touching any non-test Compose project. `make test-browser PLAYWRIGHT_ARGS='a07-acceptance.test.js'` exited 0 (A07 7/7 and outage smoke). The complete `make check` then exited 0: Vitest 540/540, native Playwright 15/15, backend tests/race checks, both image builds, backend image smoke, image Playwright 9/9 and outage smoke. Biome and `git diff --check` also passed. No application code changed.

## Hosted verification record

[CI run 36782718815](https://github.com/alexsmyr0/social-network/actions/runs/36782718815), triggered manually on reviewed branch commit `f230451`, passed `make check` on a clean hosted runner. It passed Vitest 540/540, native Playwright 15/15, both image builds, backend image smoke, image Playwright 9/9 (A07 7/7 and B07 2/2), and the stopped-backend outage smoke. The workflow finished successfully; the browser-failure artifact step was skipped because there was no failure. The subsequent evidence-only commit changes no application code or tests.

## Manual review steps

From a fresh checkout with Docker already running, execute `make deps` and `make check`. To inspect the UI directly, run `make stack-up`, open `http://localhost:3000/register`, and register once with only required fields and once with nickname, about-me and one of the avatar fixtures. Confirm home access, logout and denied direct entry after logout. Repeat in a 360px viewport, using Tab to move from email to password and checking that Sign out remains visible. For browser persistence, close and reopen the same non-private browser profile before logging out; `make stack-down` preserves the development volume. The automated suite performs these checks against disposable storage, including backend recreation.

## Remaining gate

Dev 2 must review the local and hosted evidence and any backend findings. Until that review is recorded, SN-A07 remains in progress and Phase 1 acceptance is not claimed complete. After acceptance, request a separate Phase 2 planning pass; writing Phase 2 tickets is outside A07.
