# Frontend Setup and Commands

SN-A03 replaces the browser entrypoint with Vue 3, Vite and Vue Router. The source application lives in `SPA/src/`; `SPA/dist/` is generated and ignored. The inherited `SPA/core/`, `SPA/features/` and their tests remain migration references but are not imported by the shipped Vue bundle.

## Local development

Start the backend on `http://localhost:8080`, then run:

```bash
bun install --frozen-lockfile
bun run dev
```

Vite serves `http://localhost:3000` and proxies `/api/` and `/ws` to `BACKEND_URL`, defaulting to `http://localhost:8080`. The browser always uses relative same-origin URLs. To use another backend:

```bash
BACKEND_URL=http://backend:8080 bun run dev
```

## Production-style local serving

```bash
bun run build
BACKEND_URL=http://localhost:8080 go run ./cmd/frontend
```

`bun run serve` combines those two frontend steps. The Go server validates that `SPA/dist/index.html` and hashed JavaScript/CSS bundles exist before listening. It serves SPA history fallback, preserves real 404 responses for missing assets, and proxies REST/WebSocket traffic to the configured backend.

## Verification

```bash
bun run build
bun run test:a03
go test ./cmd/frontend/...
bun run test:e2e
```

The focused Playwright configuration runs the active A03 shell journeys. The inherited forum E2E files remain in `SPA/tests/e2e/` as historical migration evidence, but are outside the active match because A02 intentionally retired their forum-only routes. Unit coverage continues to exercise the reusable inherited modules until later feature tickets port or retire them.

## Frontend container handoff

SN-A06 packages the browser bundle and its Go same-origin proxy in a frontend-only image named `social-network-frontend`. The build is self-contained: it installs locked Bun dependencies, builds `SPA/dist`, compiles the frontend server and does not consume local `node_modules`, binaries or generated assets.

```bash
docker build --file Dockerfile.frontend --tag social-network-frontend .
```

The build uses `Dockerfile.frontend.dockerignore`, so the shared `.dockerignore` used by the backend image is unchanged.

The container listens on port `3000`. `GET /healthz` is its frontend-only health endpoint and returns `200`; it deliberately does not require backend availability. Browser REST and WebSocket traffic stays same-origin at `/api/` and `/ws`. The server-side `BACKEND_URL` must be an absolute backend origin reachable from the frontend container, normally the backend service name and internal port on their shared Docker network. It is read when the frontend process starts, is not browser configuration and is not present in the built JavaScript/CSS. The image default is `http://backend:8080`, which only resolves on a shared Docker network (below). To target a backend running on the host instead:

```bash
docker run --rm --name social-network-frontend \
  --publish 3000:3000 \
  --add-host host.docker.internal:host-gateway \
  --env BACKEND_URL=http://host.docker.internal:8080 \
  social-network-frontend
```

For a shared network handoff to SN-B07:

```bash
docker network create social-network
docker run --rm --name social-network-frontend \
  --network social-network \
  --publish 3000:3000 \
  --env BACKEND_URL=http://backend:8080 \
  social-network-frontend
```

The backend container must join that network with the name `backend` and expose its service on `8080`; SN-B07 owns the combined startup/stop commands. If the target is missing or unreachable, proxied requests return HTTP `502` with `BACKEND_UNAVAILABLE`. Session restoration consequently enters the existing unavailable state rather than claiming that authentication succeeded or that the user logged out.

### Image verification

From a clean checkout, run:

```bash
docker build --no-cache --file Dockerfile.frontend --tag social-network-frontend .
docker run --detach --rm --name social-network-frontend-smoke \
  --publish 127.0.0.1:3300:3000 \
  --env BACKEND_URL=http://127.0.0.1:1 \
  social-network-frontend
curl --fail http://127.0.0.1:3300/healthz
curl --fail --header 'Accept: text/html' http://127.0.0.1:3300/login
curl --fail --header 'Accept: text/html' http://127.0.0.1:3300/register
curl --fail --header 'Accept: text/html' http://127.0.0.1:3300/protected/deep-link
curl --fail http://127.0.0.1:3300/favicon.ico
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:3300/api/v1/users/me # expected: 502
docker stop social-network-frontend-smoke
```

The Docker build itself uses a sentinel `BACKEND_URL` and fails if that server-only value appears in `SPA/dist`. The container runs as the unprivileged `frontend` user and contains `/app/frontend`, the built SPA, error assets and favicon—not the backend executable, database or media storage.

SN-A06 verification on 2026-09-27 used `docker build --no-cache --file Dockerfile.frontend --tag social-network-frontend:a06 .` and produced image `sha256:6875d5161b4d0f466b82c21bafd9ac7cd83ab84752789665b4c1fc7066549c3d`. Container smoke checks returned `200` for health, login, registration, a deep link, favicon and the generated JavaScript/CSS; the disconnected target returned JSON `502 BACKEND_UNAVAILABLE`. A named-network echo service returned `A06_CONFIGURED_BACKEND` through `/api/`, proving that the runtime target was used. Inspection confirmed user `frontend`, exposed port `3000`, the healthcheck, required runtime files and the absence of a backend binary/data directory.

`go test ./cmd/frontend/...`, `bun run build`, `git diff --check` and `make test` all exited 0. The full gate passed Go tests and scoped race checks, Biome/gofmt/vet, Vitest 540/540 and Playwright 13/13. The temporary smoke containers and Docker network were removed after verification.
