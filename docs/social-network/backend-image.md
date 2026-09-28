# Backend image and persistent storage — SN-B06

The root `Dockerfile` builds the Go backend for the host Docker architecture. Embedded numbered migrations and bootstrap categories are in the binary. Runtime uses non-root UID 10001, listens on port 8080, and probes `GET /api/v1/health`. The image contains no QA seed command and startup never runs QA seeds.

```sh
make docker-build
make docker-run
docker inspect -f '{{.State.Health.Status}}' social-network-backend
make docker-stop
```

`make docker-run` maps host port 8080 and mounts the named volume `social-network-backend-data` at `/data`. It sets `DB_PATH=/data/social.db`, `MEDIA_ROOT=/data/media`, and `FRONTEND_URL=http://localhost:3000`. Use `PORT`, `BACKEND_VOLUME`, and `FRONTEND_ORIGIN` Make variables to override the host port, volume, and allowed browser origin. Set `FRONTEND_ORIGIN` to the actual HTTPS browser origin in production; the server then issues Secure cookies. Keep `/data` durable and back it up as one unit, including SQLite WAL files and avatars. Do not reuse an unversioned forum database: startup refuses it and preserves its records.

The backend image can be checked independently with:

```sh
docker build -t social-network-backend .
scripts/smoke-backend-image.sh
```

The smoke script creates an isolated volume, starts the image against empty storage, registers with a PNG, reads the owner avatar and current account, recreates the container on the same volume, verifies session and avatar persistence, then exercises logout and login. It also checks that invalid database and media paths prevent readiness. It removes only its own test container and volume. Frontend image and two-container orchestration remain SN-A06/SN-B07.

Verification on `ticket/sn-b09-b06-avatar-backend-image`: image build and smoke result are recorded in the tracker. Startup migration failure, dirty-version refusal and old-database preservation also have Go tests in `internal/db/startup_migrations_test.go` and `internal/tests/migrate_test.go`.
