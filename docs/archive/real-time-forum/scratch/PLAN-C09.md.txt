# PLAN-C09 — DM Image Upload Backend (Bonus)

Source: RTF-34 | Phase: P5 (Bonus) | Depends on: C02, C06 | Blocks: D08, D07
Branch: `medvall/C09` (off `main`)

## Scope

Backend only (Track C). Frontend rendering is **D08** (Track D) — no `SPA/` work here.

Deliver the four verification-gate behaviours:
1. DM image upload endpoint saves the file to disk and returns a valid URL.
2. Messages with images are persisted with `image_path` populated.
3. `dm.message` events include `image_url` when an image is attached.
4. History API returns `image_url` for messages that have images.

## Source-of-Truth references

- SDS §4.4 — `image_path TEXT DEFAULT NULL` on `private_messages`; saved to
  `web/static/uploads/dm/`; `image_path` stores relative URL
  (`/static/uploads/dm/<file>`); `dm.message` includes `image_url` when present.
- SDS §5.7 — `POST /api/v1/chats/{userID}/images`; multipart `image` field;
  same validation as post/comment uploads; response
  `{ "data": { "image_url": "/static/uploads/dm/abc123.jpg" } }`.
- SDS §6.1 — message send rules still include **"reject empty message body"**.

## Key design decisions

1. **Body remains required even with an image.** SDS §6.1 is unqualified
   ("reject empty message body") and the DB has
   `CHECK (length(trim(body)) > 0)`. Allowing image-only messages would force a
   CHECK-dropping table rebuild — out of scope and over-engineered. A DM image
   message carries both a non-empty `body` and an `image_url`. This satisfies
   all four gate items.
2. **`private_messages.image_path` needs BOTH schema + migration.** The table
   predates C09, so `CREATE TABLE IF NOT EXISTS` is a no-op on existing DBs
   (the exact C07 problem). Add the column to `forum_schema.sql` **and** to
   `requiredColumns` in `migrate.go`, and correct the migrate comment that
   currently cites `private_messages` as a table that never needs an entry.
3. **`image_url` on `dm.send` is validated, not trusted.** `image_path` is
   later rendered as an `<img src>` by D08. Reject any `image_url` that is not
   exactly `/static/uploads/dm/<filename>.<jpg|png|gif>` with a clean filename
   (no `..`, no extra slashes). Ties the WS field to files our own endpoint
   produced; prevents arbitrary-path / external-URL injection.
4. **Reuse existing helpers** (`parseMultipartForm`, `parseImageUpload`,
   `validateImageType`, save core) — same package `handlers`. Refactor
   `saveUploadedImage` to a parametrized core so the `dm/` subdir path is shared
   without duplicating the ext-switch + copy logic and without changing the
   posts/comments URL output.
5. **Upload endpoint does not create a message.** It only stores the file and
   returns the URL (SDS §5.7). Message creation happens via `dm.send`.
6. **Orphaned uploads** (uploaded but never sent) are not garbage-collected —
   not required by the gate; note as a possible follow-up.

## Files to modify

### DB layer
- `internal/db/forum_schema.sql` — add `image_path TEXT DEFAULT NULL` to
  `private_messages`.
- `internal/db/migrate.go` — add `{"private_messages", "image_path",
  "TEXT DEFAULT NULL"}` to `requiredColumns`; fix the "new tables never need an
  entry" comment to note post-release columns on pre-existing tables do.
- `internal/db/messages.go`:
  - `PrivateMessage`: add `ImagePath *string \`json:"image_url,omitempty"\``
    (nullable → pointer; emitted as `image_url` for callers that serialize it).
  - `CreateMessageRequest`: add `ImagePath string` (empty ⇒ store NULL).
  - `CreateMessage`: INSERT `image_path` (NULL when empty); SELECT it back.
  - `GetMessageHistory`: SELECT `image_path` in both branches; scan into model.

### Handler / transport layer
- `internal/handlers/posts_helpers.go` — extract
  `saveUploadedImageToSubdir(file, mime, subdir)`; keep `saveUploadedImage`
  delegating with `""` (identical behaviour).
- `internal/handlers/chats.go`:
  - Dispatcher: route `/chats/{userID}/messages` GET → history,
    `/chats/{userID}/images` POST → upload.
  - `uploadDMImage`: auth, parse `{userID}`, parse multipart, validate via
    `parseImageUpload`, save to `dm/`, return `{ "image_url": ... }`.
  - `getChatHistory`: add `image_url` to each message map when present.
- `internal/handlers/ws.go`:
  - `dmSendPayload`: add `ImageURL string \`json:"image_url"\``.
  - `dmMessagePayload`: add `ImageURL string \`json:"image_url,omitempty"\``.
  - `handleDMSend`: validate `image_url` if non-empty (reject → new
    `chat.error` code `INVALID_IMAGE`); pass to `CreateMessage`; include in
    `dm.message` payload.
  - Add `isValidDMImageURL(string) bool` helper + `codeInvalidImage` constant.
- `internal/router/router.go` — allow `POST` on `/chats/` and route by suffix
  (GET `/messages`, POST `/images`).

## Wire contracts

`dm.send` (client → server), image optional:
```json
{ "type": "dm.send", "payload": { "recipient_id": 12, "body": "look", "image_url": "/static/uploads/dm/abc.png" } }
```
`dm.message` (server → clients), `image_url` only when present:
```json
{ "type": "dm.message", "payload": { "id": 91, "sender_id": 7, "recipient_id": 12, "sender_username": "alex", "body": "look", "image_url": "/static/uploads/dm/abc.png", "created_at": "..." } }
```
Upload response (`POST /api/v1/chats/{userID}/images`):
```json
{ "data": { "image_url": "/static/uploads/dm/abc123.jpg" } }
```

## Tests

- `internal/tests/migrate_test.go` — extend legacy fixture to include a
  pre-C09 `private_messages` (no `image_path`); assert Migrate adds it and is
  idempotent.
- `internal/db` / `internal/tests/messages_test.go` — `CreateMessage` with
  `ImagePath` persists/returns it; without it stays NULL; `GetMessageHistory`
  returns `image_path`.
- `internal/tests/dm_send_test.go` — dm.send with valid `image_url` →
  `dm.message` includes it and row persisted; dm.send with bad `image_url` →
  `chat.error INVALID_IMAGE`, nothing persisted; dm.send with empty body +
  image → still `EMPTY_BODY`.
- chat image-upload handler test — valid upload saves a file under
  `web/static/uploads/dm/` and returns the URL; non-image / oversized rejected;
  wrong method → 405; bad `{userID}` → 400.
- history API test — message with `image_path` surfaces `image_url` in JSON.

## Verification-gate checklist

- [ ] Upload endpoint writes a file to `web/static/uploads/dm/` and returns a
      valid `/static/uploads/dm/<file>` URL.
- [ ] `dm.send` with `image_url` persists a row with `image_path` populated.
- [ ] `dm.message` carries `image_url` when present (and omits it otherwise).
- [ ] History API returns `image_url` for messages that have an image.
- [ ] `go build ./...`, `go vet ./...`, `go test ./...` (+ `-race`) all green.
- [ ] Independent cold-start audit: PASS.
