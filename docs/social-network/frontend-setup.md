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
