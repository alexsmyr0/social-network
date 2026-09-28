# Backend avatars — SN-B09

Registration accepts one optional JPEG, PNG or GIF file in the approved multipart request. The server checks the decoded type, declared MIME and recognized extension, complete image decoding, 5 MiB byte limit, 4,096-pixel side limit, and GIF limits of 100 frames and 64 million cumulative canvas pixels. JSON registration without an avatar still works. Invalid input creates no account or session.

`MEDIA_ROOT` stores private originals. If unset, the root is `media/` beside the SQLite database. New files first go to a temporary name, are synced, then renamed under `objects/` with a generated opaque key. The account and first session commit in one SQLite transaction with that key. A failed transaction removes the file. Startup removes temporary files and object files with no committed account reference before HTTP readiness; failure to prepare writable storage prevents startup. Persist or back up the database and media directory together.

`GET /api/v1/users/{id}/avatar` checks the session and matching account ID. Other users receive 404, missing sessions receive 401, and missing avatars receive 404. Images use the verified type, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. There is no client-supplied attachment key, replacement endpoint, or public avatar access in Phase 1.

Verification on `ticket/sn-b09-b06-avatar-backend-image`: `go test ./internal/tests -run 'TestSocialAvatar|TestSocialMultipart' -count=1` passes. Cases cover JPEG/PNG/GIF bytes and owner retrieval, no-avatar registration, foreign/unauthenticated access, corrupt/truncated/mismatched/oversized/dimension/frame-invalid files, session-insert failure rollback, duplicate requests, and startup orphan cleanup. Full-suite result is recorded in the tracker.
