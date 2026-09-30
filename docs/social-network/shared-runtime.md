# Shared runtime and quality gate — SN-B07

This harness combines the [frontend](frontend-setup.md#frontend-container-handoff) and [backend](backend-image.md) images under the approved same-origin boundary. It verifies infrastructure and transport; complete UI journeys and browser-profile reopen remain SN-A07.

## Fresh checkout

Prerequisites: Go 1.24.1 with a C compiler (SQLite uses CGO), Bun 1.3.12, Node.js 22.12+, Make, Bash, Python 3 and curl. Container checks also require a running Docker engine and Docker Compose v2 with `up --wait` support (v2.20+). Start Docker yourself when needed; no repository command launches the daemon. Linux browser hosts may need `bun x playwright install --with-deps chromium` for system libraries.

```sh
make deps                 # download/verify Go modules, frozen Bun install, Chromium
make stack-up             # build both images; wait for health, no QA seeding
# Open http://localhost:3000
make stack-ps
make stack-logs           # Ctrl-C stops log following
make stack-down           # remove containers/network; preserve accounts and media
```

Only the frontend publishes a host port, bound to loopback. The backend stays on the Compose network at `backend:8080`; the frontend uses `BACKEND_URL=http://backend:8080`. Backend readiness gates frontend startup using the images' healthchecks. Both images retain their own build recipes and unprivileged runtime users.

The project defaults to `social-network`. Its `backend-data` named volume contains `/data/social.db` and `/data/media`. Repeating `stack-up` or recreating containers retains that volume and reapplies only outstanding migrations. No host database or uploads directory is mounted. Use a fresh volume instead of an inherited forum database; follow the [migration recovery guide](backend-migrations.md) if startup refuses storage. `stack-down` never deletes the volume.

To use another loopback port/project, pass the same settings to each command:

```sh
FRONTEND_PORT=3400 COMPOSE_PROJECT_NAME=sn-dev make stack-up
FRONTEND_PORT=3400 COMPOSE_PROJECT_NAME=sn-dev make stack-down
```

Open **http://localhost:3400**, matching the backend's allowed browser origin exactly. This is a local HTTP stack; deployment/TLS configuration is outside this ticket. The frontend port changes both the host mapping and `FRONTEND_URL`. Do not browse through `127.0.0.1` while the allowed origin uses `localhost`.

## Shared checks

```sh
make test                 # builds including Vue assets, lint/format/vet, Go/race, Vitest, browser
make test-images          # both image builds, B06 smoke, isolated two-image browser/outage smoke
make check                # complete local/hosted gate: test + test-images
make verify-infra         # install dependencies, then complete gate
```

`make deps` uses committed dependency versions and does not tidy or update lockfiles. B07 adds no Go or JavaScript packages. It reuses Playwright/Chromium, existing shell/Python tools, and the two approved images; CI adds GitHub's artifact-upload action only. Go dependency allowlist decisions remain in the [data decision](data-decision.md). The default scoped race gate is preserved; `make test-race-all` remains available separately.

Native browser checks use ports **3301/18081**, fresh temporary SQLite/media directories, and the built Go binaries. Backend runs outside the checkout so a developer `.env` cannot override test storage. `LISTEN_ADDR` configures each process's listener for this purpose; default service ports remain 3000/8080. Test ports can be changed with `TEST_FRONTEND_PORT` and `TEST_BACKEND_PORT`. Occupied ports fail; checks never kill or reuse unrelated servers. Listener/browser failures fail the gate instead of silently skipping it.

Image browser checks use port **3307** (`TEST_STACK_PORT` override), a unique `sn-b07-test-*` Compose project and fresh project volume. The harness ignores developer `.env`/Compose overrides, never mounts developer storage, and removes only its own containers/network/volume even after failure. B06's independent image smoke likewise uses a unique volume and an ephemeral backend port. Neither needs to stop the development stack.

Transport checks use an actual Chromium origin, browser-managed HTTP-only session cookie, real registration/current-user/login/logout, write-header and foreign-origin denial, authenticated `/ws` upgrade and presence frame, logout closure and revoked-cookie replay. Route/asset/health/401/404 checks cover the built frontend; a stopped backend must leave frontend health up while API returns `502 BACKEND_UNAVAILABLE`. B06 smoke additionally checks avatar/session persistence across container recreation and invalid storage readiness refusal. Existing A03/A05 browser fixtures and all applicable unit/Go regressions remain in the native gate.

## Browser acceptance hook

```sh
make stack-build
make test-browser
make test-browser PLAYWRIGHT_ARGS='--grep cookies'
make test-e2e PLAYWRIGHT_ARGS='b07-transport.test.js'
```

`make test-browser` starts and tears down the isolated two-image stack. `playwright.integration.config.ts` matches current `b07-transport.test.js` plus future `a07-*.test.js`; SN-A07 adds cases without replacing the harness. Each Playwright test gets a fresh browser context; use unique account data since tests share their run's disposable database. No A07 test files are required for B07's gate. `bun run test:e2e` delegates to the isolated native command.

CI runs `make check` on main pushes, pull requests to main, and this resubmission's `asmyrogl/B07-resubmit` pushes; manual dispatch is also available. A fresh hosted checkout installs locked dependencies and Chromium system libraries. Browser reports/traces are uploaded for failed jobs with seven-day retention; stack logs print before cleanup. CI builds locally inside its runner and publishes no images. Access/run failures remain visible in the tracker; this ticket never rewrites history or bypasses protection.

Compose startup follows [Docker's health-dependent ordering](https://docs.docker.com/compose/how-tos/startup-order/); native process lifecycle uses [Playwright web servers](https://playwright.dev/docs/test-webserver).

## Verification record

### Historical implementation and merge verification

The original implementation was delivered in `c771a6f` and `06f503c`. [PR #15 — feat(SN-B07): add shared runtime and quality gate](https://github.com/alexsmyr0/social-network/pull/15) merged as `e34874b` on 2026-09-30. It was later reverted by `53fb158` so B07 could be resubmitted with a complete verification record; no implementation defect was identified.

Hosted [CI run 36574650827](https://github.com/alexsmyr0/social-network/actions/runs/36574650827) passed `make check` on `c771a6f`: build/format/lint/vet, Go suites and scoped race checks, Vitest 540/540, native Playwright 15/15, both image builds, backend persistence smoke, two-image Playwright 2/2, stopped-backend outage smoke and successful cleanup.

The owner reported a successful local `make test-images` run against merge commit `e34874b` on 2026-09-30. That run passed both image builds, the backend persistence smoke test, Playwright transport tests (2/2), and the stopped-backend outage smoke test. Temporary containers, network and volume were removed successfully. This completed the previously outstanding local Docker verification for the original implementation.

### Resubmission evidence boundary

`asmyrogl/B07-resubmit` starts from current main at revert `53fb158` and restores both original commits with the updated completion records. The results above are historical evidence for their named revisions, not verification of the resubmitted HEAD. Fresh checks and their exact HEAD revision/run URLs are recorded separately in the new PR's verification section. SN-A07 is the next ticket and owns full integrated browser acceptance.
