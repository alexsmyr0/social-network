# Backend Migrations and Startup

SN-B03 implements the [approved storage decision](data-decision.md). Production schema lives in numbered SQL files under `internal/db/migrations/sqlite/`, embedded in the backend binary and applied by `golang-migrate` inside `db.InitDB` before bootstrap categories or HTTP startup. `forum_schema.sql` and procedural `Migrate` remain only for inherited forum tests; normal startup never executes them. QA reset/seeding remains the separate `cmd/qa-seed` operation.

## Fresh database and legacy files

Local backend and QA seed commands default to `./data/social-network.db`; `DB_PATH` overrides that path. A new empty database receives migration version 1, the approved account/session columns, and five bootstrap categories. A second startup keeps its users, migration version and category rows.

An unversioned database with existing tables, including an imported `forum.db`, fails startup with `ErrLegacyDatabase` before any migration or seed. No old rows are deleted or assigned guessed birthdates. Back up the old database, then explicitly point `DB_PATH` to a new file. The migration tests verify a legacy user/post relationship remains intact after rejection. QA seed birthdates are explicit synthetic fixture values, not values inferred from stored ages.

## Failure recovery

A failed migration returns an error from `InitDB`; the backend does not start listening. `golang-migrate` retains a dirty version for inspection, and later starts reject it. Back up the database, inspect the migration error and partially applied state, then restore a known-good backup or repair the version only after verifying the schema. Startup never deletes the file or auto-forces a migration version. A disposable test injects invalid SQL, then confirms the next startup also refuses readiness.

`make test-e2e` uses a disposable database so local forum data cannot affect the browser gate. Direct `bun run test:e2e` uses the configured `DB_PATH` or backend default; choose a fresh path when testing startup behavior.

SN-B03 establishes storage only. Registration validation and the approved Account response arrive in SN-B04; independent persistent sessions arrive in SN-B05; avatar attachment and private-file cleanup arrive in SN-B09. The inherited registration endpoint is not compatible with the new required birthdate column until B04, so do not treat it as the social-network account API.
