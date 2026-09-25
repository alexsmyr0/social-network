# Account Storage and Migration Decision — Proposed

Proposal for [SN-B08](track-b.md#sn-b08--approve-account-storage-and-migration-design), based on the [approved account contract](auth-contract.md) and [backend baseline](backend-baseline.md). **Owner approval and the remaining SN-B02 fixture review are pending.** This document authorizes no implementation yet.

## Recommendation and alternatives

| Choice | Recommendation | Alternative and cost |
|---|---|---|
| Existing forum databases | Start the social-network schema on a fresh SQLite database. Refuse startup if an unversioned database already contains application tables; never delete or rewrite it automatically. The operator backs it up and explicitly selects a new database path. | Preserve and upgrade: requires an account-completion flow for unknown birthdates, resolution of case-insensitive email collisions, and migration of forum sessions/media. Neither an invented date nor a nullable date in the approved Account response is acceptable. |
| Migration machinery | Use numbered SQL files in `internal/db/migrations/sqlite/` with `golang-migrate`, which the assignment explicitly allows. Embed them in the Go binary and apply pending versions in `InitDB` before the server listens. Migration files, not `forum_schema.sql` plus procedural `Migrate`, become schema authority. | An in-house version runner avoids a dependency but must implement version locking, failed-version recording, ordering and recovery. |
| Avatar bytes | Store validated originals in a private backend-owned filesystem under configurable `MEDIA_ROOT`; store an opaque relative object key on `users`. Retrieval goes through the owner-checked API, never `/static/`. Persist the database and media directory together in the backend deployment. | SQLite BLOBs would make account transactions simpler but increase database size and backup/restore pressure for every image. |

## Proposed account and session model

- `users`: numeric `id`, normalized case-insensitive unique `email`, `password_hash`, required `first_name`, `last_name`, and `date_of_birth` (`YYYY-MM-DD`), nullable `nickname`, `about_me`, and `avatar_key`, plus existing `is_active` and timestamps. B04 validates real Gregorian dates and text limits before insert; SQL enforces presence, nullability, email uniqueness and basic shape. A non-unique nickname has no login role. The API derives `display_name` from nickname or names and `avatar_url` from ID; neither is stored.
- The inherited `username`, `age`, `gender` and `session_version` references need compatibility work in B03/B04. New accounts receive an opaque generated internal username, never supplied by clients or returned by the approved Account response. `age=0` and `gender=''` remain internal legacy sentinels while inherited queries exist; they do not represent asserted personal data. QA fixtures receive explicit synthetic birthdates. No birthdate is derived from legacy age.
- `sessions`: numeric ID, user ID, unique opaque token, creation time, optional revocation state/time, optional IP and user agent. No server-side expiry applies to new sessions. Remove the single-active-session unique index. B05 changes creation, lookup and logout to independent per-token revocation, and keeps the 400-day cookie lifetime separate from server validity. B03 may retain compatibility columns while the old auth code still compiles, but must not silently make the 12-hour behavior the final policy.
- `avatar_key` is nullable until a registration with an avatar commits. It identifies a server-private file, not a path or URL accepted from the browser. B09 stages bytes under the media root, validates them, renames to a final private key before committing the account/session reference, then removes failed or orphaned files. Startup cleans unreachable temporary/orphan files before readiness; it never exposes them. B09 must test crash and commit-failure windows.

## Startup and recovery contract

1. Open SQLite with foreign keys and a busy timeout. Before migration, reject an unversioned database containing forum application tables with a clear backup/new-`DB_PATH` error. An empty database is eligible.
2. Apply numbered embedded migrations before bootstrap categories and before listening. The normal startup path never runs QA reset/seeding. Repeated startup has no schema or seed duplication.
3. A migration failure prevents service readiness. Keep the database and recorded failed version for inspection; restore a backup or repair explicitly, then retry. Never auto-delete, auto-force a version, or serve a half-migrated schema.
4. B03 tests empty and repeated startup, a failed migration, schema constraints, and explicit rejection of a legacy fixture with its relationships still intact. B04/B05/B09 test request/session/media behavior; A07 tests restart with retained database and media volume.

## Review needed before approval

The owner must choose the legacy database policy and migration package/layout above. Dev 1 should confirm that no proposed storage choice changes the approved client contract. SN-B03 starts only after SN-B02 and this decision pass their recorded gates.
