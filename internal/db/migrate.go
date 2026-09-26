// internal/db/migrate.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
)

// columnSpec describes a column that must exist on a table after migration.
// Adding a new entry here is the only step needed to evolve a table that
// already exists in a deployed database; fresh databases already have the
// column from forum_schema.sql, so Migrate sees it and skips.
type columnSpec struct {
	table      string
	column     string
	definition string // SQL fragment, e.g. "INTEGER NOT NULL DEFAULT 0"
}

// requiredColumns lists every column added to the schema *after* the initial
// release. forum_schema.sql is authoritative for new databases; this list is
// authoritative for upgrading legacy databases. The two must stay in sync —
// any column in requiredColumns must also exist in forum_schema.sql with the
// same definition.
//
// A table needs entries here only once a column is added to it *after* the
// table first shipped. A brand-new table carries all of its columns in
// forum_schema.sql via CREATE TABLE IF NOT EXISTS, so it needs no entry — but
// once a later release adds a column to a table that already exists in
// deployed databases, that column MUST be listed here: CREATE TABLE IF NOT
// EXISTS is a no-op on an existing table and will not add it. That is why
// private_messages.image_path appears below even though private_messages is
// itself created by the schema file.
var requiredColumns = []columnSpec{
	// C10 — User profile schema extension. NOT NULL with safe defaults so
	// existing user rows remain valid after the ALTER.
	{"users", "age", "INTEGER NOT NULL DEFAULT 0"},
	{"users", "gender", "TEXT NOT NULL DEFAULT ''"},
	{"users", "first_name", "TEXT NOT NULL DEFAULT ''"},
	{"users", "last_name", "TEXT NOT NULL DEFAULT ''"},

	// Image upload feature — posts and comments gained an `image_url`
	// after the initial release. Nullable TEXT so the ALTER cannot fail
	// on populated tables.
	{"posts", "image_url", "TEXT"},
	{"comments", "image_url", "TEXT"},

	// C09 — DM image attachments. private_messages predates this column, so
	// databases created between C02 and C09 need the ALTER. Nullable so it
	// cannot fail on populated tables.
	{"private_messages", "image_path", "TEXT DEFAULT NULL"},
}

// Migrate is retained for inherited forum fixtures and tests. Production
// InitDB uses numbered SQL migrations and rejects unversioned forum databases.
// It brings an old forum database up to the historical forum schema by adding any
// columns missing from tables that pre-date the current code. Idempotent:
// safe to call on fresh databases (no-op), on already-migrated databases
// (no-op), and on partial-schema fixtures (tables not present are skipped).
//
// Tables that did not exist in the legacy schema (e.g. private_messages) are
// created by forum_schema.sql via CREATE TABLE IF NOT EXISTS, so they need
// no work here.
func Migrate(ctx context.Context, database *sql.DB) error {
	// SQLite's database/sql transactions start in DEFERRED mode, which means
	// two concurrent boots could both observe "column missing" before either
	// runs its ALTER. The forum only ever has a single InitDB caller, so the
	// race window does not exist in practice — if that ever changes, switch
	// the DSN to include `_txlock=immediate` to upgrade every transaction to
	// IMMEDIATE locking.
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return WrapError("begin migration tx", err)
	}
	defer tx.Rollback()

	// Cache PRAGMA results per table. requiredColumns lists multiple columns
	// per table (four on users), so caching avoids redundant introspection.
	seen := map[string]map[string]bool{}

	for _, c := range requiredColumns {
		cols, ok := seen[c.table]
		if !ok {
			cols, err = tableColumns(ctx, tx, c.table)
			if err != nil {
				return WrapError(fmt.Sprintf("introspect %s", c.table), err)
			}
			seen[c.table] = cols
		}
		// Empty result from PRAGMA table_info means the table does not
		// exist. forum_schema.sql is supposed to have created it before
		// Migrate runs; if it didn't, the schema apply or the table list
		// is inconsistent. Skip rather than fail — this keeps Migrate
		// robust against partial-schema test fixtures and against a
		// future schema that retires a table.
		if len(cols) == 0 {
			continue
		}
		if cols[c.column] {
			continue
		}
		// Identifiers come from the hardcoded requiredColumns list — no
		// user input ever reaches this string. Plain %s is correct;
		// adding SQLite-style ("") quoting would be misleading defense.
		stmt := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", c.table, c.column, c.definition)
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return WrapError(fmt.Sprintf("add column %s.%s", c.table, c.column), err)
		}
		// Record the added column so a later spec on the same table
		// observes the new state from the cache.
		cols[c.column] = true
	}

	// Relax the private_messages body CHECK so image-only DMs are allowed.
	// Must run after the column loop above so image_path is guaranteed to
	// exist before the rebuilt table references it.
	if err := migratePrivateMessagesBodyCheck(ctx, tx); err != nil {
		return err
	}

	// Fold legacy mixed-case emails and add the case-insensitive uniqueness
	// guard that the plain UNIQUE constraint cannot provide.
	if err := migrateEmailCaseFolding(ctx, tx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return WrapError("commit migration tx", err)
	}
	return nil
}

// migratePrivateMessagesBodyCheck relaxes the original
// `CHECK (length(trim(body)) > 0)` on private_messages to
// `CHECK ((length(trim(body)) > 0) OR image_path IS NOT NULL)` so a DM may
// carry just an image with no text — matching the posts/comments image-only
// pattern.
//
// SQLite cannot ALTER a CHECK constraint, so the table is rebuilt via the
// documented create-copy-drop-rename procedure. private_messages is not the
// target of any foreign key (no other table references it), so the rebuild is
// safe with foreign_keys left enabled inside the migration transaction.
//
// Idempotent: a fresh database built from forum_schema.sql already carries the
// relaxed constraint, and an already-migrated database does too, so both skip.
func migratePrivateMessagesBodyCheck(ctx context.Context, tx *sql.Tx) error {
	var existing sql.NullString
	err := tx.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='table' AND name='private_messages'`,
	).Scan(&existing)
	if err == sql.ErrNoRows {
		// Table absent (e.g. a partial-schema fixture) — nothing to rebuild.
		return nil
	}
	if err != nil {
		return WrapError("introspect private_messages constraint", err)
	}
	// The relaxed constraint is the only place "image_path IS NOT NULL"
	// appears in the table DDL, so its presence means the rebuild already
	// happened (or the table was created fresh from the new schema).
	if strings.Contains(existing.String, "image_path IS NOT NULL") {
		return nil
	}

	// Rebuild. Columns are listed explicitly in the copy so the result is
	// independent of column ordering. The two indexes are dropped together
	// with the old table, so they are recreated to match forum_schema.sql.
	stmts := []string{
		`CREATE TABLE private_messages_new (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			sender_id     INTEGER NOT NULL,
			recipient_id  INTEGER NOT NULL,
			body          TEXT NOT NULL,
			image_path    TEXT DEFAULT NULL,
			created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
			FOREIGN KEY (sender_id)    REFERENCES users(id) ON DELETE CASCADE,
			FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
			CHECK (sender_id <> recipient_id),
			CHECK ((length(trim(body)) > 0) OR image_path IS NOT NULL)
		)`,
		`INSERT INTO private_messages_new
			(id, sender_id, recipient_id, body, image_path, created_at)
			SELECT id, sender_id, recipient_id, body, image_path, created_at
			FROM private_messages`,
		`DROP TABLE private_messages`,
		`ALTER TABLE private_messages_new RENAME TO private_messages`,
		`CREATE INDEX IF NOT EXISTS idx_pm_sender
			ON private_messages(sender_id, recipient_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_pm_recipient
			ON private_messages(recipient_id, sender_id, created_at DESC)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return WrapError("rebuild private_messages for image-only DMs", err)
		}
	}
	return nil
}

// migrateEmailCaseFolding brings legacy rows in line with the lower-cased email
// that insertUser now writes, and adds a case-insensitive uniqueness guard.
//
// Two problems existed before: registration stored the address exactly as typed
// while login folded it to lower case, so "Alice@Example.com" could never
// authenticate by email; and the UNIQUE constraint on users.email is
// case-sensitive, so the same address could register twice.
//
// Rows whose folded form is already taken by a DIFFERENT row are left alone —
// folding them would violate the existing UNIQUE constraint and abort the boot.
// Those addresses are reported so an operator can merge them by hand; the
// application itself is already correct for every new registration.
func migrateEmailCaseFolding(ctx context.Context, tx *sql.Tx) error {
	cols, err := tableColumns(ctx, tx, "users")
	if err != nil {
		return WrapError("introspect users for email folding", err)
	}
	// Partial-schema fixture: nothing to fold.
	if len(cols) == 0 {
		return nil
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET email = LOWER(email)
		WHERE email <> LOWER(email)
		  AND NOT EXISTS (
			SELECT 1 FROM users other
			WHERE other.id <> users.id
			  AND LOWER(other.email) = LOWER(users.email)
		  )
	`); err != nil {
		return WrapError("fold user emails to lower case", err)
	}

	// The guard is best-effort: a database still carrying two rows for the same
	// address cannot have it. Creating the index is defence in depth — the real
	// fix is insertUser writing a folded address — so a collision is reported
	// rather than allowed to block startup.
	if _, err := tx.ExecContext(ctx,
		`CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email_nocase ON users(LOWER(email))`,
	); err != nil {
		dupes, listErr := duplicateFoldedEmails(ctx, tx)
		if listErr != nil {
			log.Printf("[MIGRATE] case-insensitive email index not created: %v", err)
			return nil
		}
		log.Printf(
			"[MIGRATE] case-insensitive email index not created — these addresses exist more than once and must be merged by hand: %s",
			strings.Join(dupes, ", "),
		)
	}

	return nil
}

// duplicateFoldedEmails lists the addresses held by more than one user row once
// case is ignored. Used only to make the skipped-index warning actionable.
func duplicateFoldedEmails(ctx context.Context, tx *sql.Tx) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT LOWER(email) FROM users
		GROUP BY LOWER(email)
		HAVING COUNT(*) > 1
		ORDER BY LOWER(email)
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, err
		}
		out = append(out, email)
	}
	return out, rows.Err()
}

// tableColumns returns the set of columns present on a table via
// PRAGMA table_info. An empty map means the table does not exist;
// PRAGMA table_info returns no rows in that case, not an error.
//
// `table` must be a hardcoded identifier from requiredColumns. PRAGMA
// statements cannot accept bound parameters, so the table name is
// inlined; no user input reaches this string.
func tableColumns(ctx context.Context, tx *sql.Tx, table string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols := map[string]bool{}
	for rows.Next() {
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = true
	}
	return cols, rows.Err()
}
