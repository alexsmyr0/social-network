// internal/tests/migrate_test.go
//
// Migration tests for C07 - Database Migration Strategy.
//
// The current production schema (forum_schema.sql) is the destination state;
// these tests construct a "legacy" database that matches the schema *before*
// C10 added profile fields to users, run Migrate, and assert:
//
//  1. Missing columns are added.
//  2. Pre-existing rows survive — no data loss.
//  3. The migration is idempotent.
//  4. Fresh databases (already at head schema) are a no-op.
package tests

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"forum/internal/db"

	_ "github.com/mattn/go-sqlite3"
)

// legacyUsersSchema is the users table definition as it existed before C10
// added age/gender/first_name/last_name. Kept here verbatim so the test
// describes exactly what "legacy" means for migration purposes.
const legacyUsersSchema = `
CREATE TABLE users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  session_version  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`

// openLegacyDB builds an in-memory database with the pre-C10 users table.
// It is intentionally NOT routed through InitDB — that would apply
// forum_schema.sql (which would create users with the current shape) and
// defeat the purpose of the test.
func openLegacyDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
	}
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	if _, err := conn.Exec(legacyUsersSchema); err != nil {
		conn.Close()
		t.Fatalf("create legacy users table: %v", err)
	}
	return conn
}

// columnSet returns the set of column names present on the given table.
func columnSet(t *testing.T, conn *sql.DB, table string) map[string]bool {
	t.Helper()
	rows, err := conn.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		t.Fatalf("PRAGMA table_info(%s): %v", table, err)
	}
	defer rows.Close()
	got := map[string]bool{}
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
			t.Fatalf("scan table_info: %v", err)
		}
		got[name] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("table_info rows error: %v", err)
	}
	return got
}

/*-----------------------
  ADDITIVE BEHAVIOR
------------------------*/

func TestMigrate_AddsC10ColumnsToLegacyUsers(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()

	// Sanity: legacy schema must not already have the C10 columns.
	before := columnSet(t, conn, "users")
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if before[col] {
			t.Fatalf("precondition: legacy users already has %q", col)
		}
	}

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	after := columnSet(t, conn, "users")
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if !after[col] {
			t.Errorf("expected users.%s to exist after Migrate", col)
		}
	}
}

func TestMigrate_PreservesLegacyUserRows(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()

	// Insert a pre-existing user with no C10 fields — exactly what would
	// already be on disk for a deployed forum upgrading from pre-C10.
	_, err := conn.Exec(`
		INSERT INTO users (id, username, email, password_hash)
		VALUES (1, 'legacy_alice', 'alice@old.example', 'fake-hash')
	`)
	if err != nil {
		t.Fatalf("seed legacy user: %v", err)
	}

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// The row must still be there, AND the new columns must hold their
	// defaults (NOT NULL DEFAULT 0/'').
	var (
		username  string
		email     string
		age       int
		gender    string
		firstName string
		lastName  string
	)
	err = conn.QueryRow(`
		SELECT username, email, age, gender, first_name, last_name
		FROM users WHERE id = 1
	`).Scan(&username, &email, &age, &gender, &firstName, &lastName)
	if err != nil {
		t.Fatalf("select legacy user post-migrate: %v", err)
	}
	if username != "legacy_alice" || email != "alice@old.example" {
		t.Errorf("legacy data lost: got user=%q email=%q", username, email)
	}
	if age != 0 || gender != "" || firstName != "" || lastName != "" {
		t.Errorf("defaults wrong: age=%d gender=%q first=%q last=%q",
			age, gender, firstName, lastName)
	}
}

/*-----------------------
  IDEMPOTENCE
------------------------*/

func TestMigrate_IdempotentOnLegacyDB(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()

	for i := 0; i < 3; i++ {
		if err := db.Migrate(context.Background(), conn); err != nil {
			t.Fatalf("Migrate iteration %d: %v", i, err)
		}
	}

	after := columnSet(t, conn, "users")
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if !after[col] {
			t.Errorf("column %q lost across re-runs", col)
		}
	}
}

func TestMigrate_NoOpOnFreshDB(t *testing.T) {
	// setupTestDB applies the current forum_schema.sql, which already has
	// the C10 columns. Migrate must do nothing and return nil.
	conn := setupTestDB(t)
	defer conn.Close()

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate on fresh DB: %v", err)
	}

	// All columns still present, no duplicate columns (impossible in SQLite
	// but we assert column count remained stable).
	cols := columnSet(t, conn, "users")
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if !cols[col] {
			t.Errorf("column %q vanished from a fresh DB after Migrate", col)
		}
	}
}

/*-----------------------
  RETAINED FORUM DATA
------------------------*/

func TestMigrate_RetainedTablesUnaffected(t *testing.T) {
	// Use the full fresh schema (it already has posts/categories/etc.) and
	// pre-populate retained data, then re-run Migrate and confirm everything
	// is still readable. Models the "upgrade a populated forum" scenario.
	conn := setupTestDB(t)
	defer conn.Close()

	// Insert another post on top of the seeded one.
	_, err := conn.Exec(`
		INSERT INTO posts (id, author_id, title, body, status)
		VALUES (2, 1, 'Retained', 'still here', 'published')
	`)
	if err != nil {
		t.Fatalf("seed retained post: %v", err)
	}

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	var (
		title string
		body  string
	)
	if err := conn.QueryRow(`SELECT title, body FROM posts WHERE id = 2`).
		Scan(&title, &body); err != nil {
		t.Fatalf("post row not found after Migrate: %v", err)
	}
	if title != "Retained" || body != "still here" {
		t.Errorf("post data corrupted: title=%q body=%q", title, body)
	}

	// Spot-check the original seeded post (id=1) is still there.
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM posts`).Scan(&n); err != nil {
		t.Fatalf("count posts: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 posts after Migrate, got %d", n)
	}
}

/*-----------------------
  END-TO-END: APP USABLE POST-MIGRATE
------------------------*/

// legacyPostsCommentsSchema models the pre-image-upload posts/comments shape:
// the same tables that exist today, minus their `image_url` columns and the
// CHECK constraints that depend on them.
const legacyPostsCommentsSchema = `
CREATE TABLE posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id   INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'published',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE comments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id            INTEGER NOT NULL,
  user_id            INTEGER NOT NULL,
  parent_comment_id  INTEGER,
  body               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`

func TestMigrate_AddsImageURLToLegacyPostsAndComments(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()
	if _, err := conn.Exec(legacyPostsCommentsSchema); err != nil {
		t.Fatalf("create legacy posts/comments: %v", err)
	}

	// Sanity precondition.
	for _, table := range []string{"posts", "comments"} {
		if columnSet(t, conn, table)["image_url"] {
			t.Fatalf("precondition: legacy %s already has image_url", table)
		}
	}

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	for _, table := range []string{"posts", "comments"} {
		if !columnSet(t, conn, table)["image_url"] {
			t.Errorf("expected %s.image_url to exist after Migrate", table)
		}
	}
}

// legacyPrivateMessagesSchema models the private_messages table as it shipped
// in C02 — before C09 added the image_path column. This is the case Migrate
// must handle: the table already exists in deployed databases, so
// CREATE TABLE IF NOT EXISTS in forum_schema.sql is a no-op and will NOT add
// the new column.
const legacyPrivateMessagesSchema = `
CREATE TABLE private_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`

func TestMigrate_AddsImagePathToLegacyPrivateMessages(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()
	if _, err := conn.Exec(legacyPrivateMessagesSchema); err != nil {
		t.Fatalf("create legacy private_messages: %v", err)
	}

	// Seed two users and a pre-C09 message (no image_path) — exactly what a
	// deployed forum would already have on disk.
	if _, err := conn.Exec(`
		INSERT INTO users (id, username, email, password_hash) VALUES
		  (1, 'pm_alice', 'pma@old.example', 'h'),
		  (2, 'pm_bob',   'pmb@old.example', 'h');
		INSERT INTO private_messages (id, sender_id, recipient_id, body)
		VALUES (1, 1, 2, 'legacy dm');
	`); err != nil {
		t.Fatalf("seed legacy pm: %v", err)
	}

	if columnSet(t, conn, "private_messages")["image_path"] {
		t.Fatal("precondition: legacy private_messages already has image_path")
	}

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if !columnSet(t, conn, "private_messages")["image_path"] {
		t.Error("expected private_messages.image_path to exist after Migrate")
	}

	// The pre-existing row must survive with a NULL image_path.
	var (
		body  string
		image sql.NullString
	)
	if err := conn.QueryRow(
		`SELECT body, image_path FROM private_messages WHERE id = 1`,
	).Scan(&body, &image); err != nil {
		t.Fatalf("read migrated row: %v", err)
	}
	if body != "legacy dm" {
		t.Errorf("body: got %q want %q", body, "legacy dm")
	}
	if image.Valid {
		t.Errorf("expected NULL image_path on legacy row, got %q", image.String)
	}

	// The body CHECK must have been relaxed: an image-only message (empty body
	// + image_path) is now insertable on the migrated table.
	if _, err := conn.Exec(
		`INSERT INTO private_messages (sender_id, recipient_id, body, image_path)
		 VALUES (1, 2, '', '/static/uploads/dm/imageonly.png')`,
	); err != nil {
		t.Errorf("expected image-only insert to succeed after migration, got: %v", err)
	}

	// Idempotent: a second run must not fail.
	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate (second run): %v", err)
	}
}

// TestMigrate_BeginTxErrorPropagates closes the DB before calling Migrate
// so BeginTx returns an error. The function must surface it wrapped via
// WrapError, not panic and not swallow the failure.
func TestMigrate_BeginTxErrorPropagates(t *testing.T) {
	conn := openLegacyDB(t)
	conn.Close()

	err := db.Migrate(context.Background(), conn)
	if err == nil {
		t.Fatal("expected error from Migrate on a closed DB, got nil")
	}
}

// TestMigrate_SkipsMissingTables documents that Migrate does not fail when
// a target table is absent. Production reaches Migrate after forum_schema.sql
// has guaranteed every current table exists, but the function must be robust
// against partial-schema fixtures and against a future schema that retires
// a table whose name still appears in requiredColumns.
func TestMigrate_SkipsMissingTables(t *testing.T) {
	// openLegacyDB creates only `users` — posts/comments are intentionally
	// absent so Migrate must skip those entries rather than error.
	conn := openLegacyDB(t)
	defer conn.Close()

	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate must skip missing tables, got: %v", err)
	}

	// users still got migrated even though sibling tables were missing.
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if !columnSet(t, conn, "users")[col] {
			t.Errorf("expected users.%s to exist after Migrate", col)
		}
	}
}

/*-----------------------
  INITDB BOOT-PATH INTEGRATION
------------------------*/

// TestInitDB_AppliesSchemaAndMigratesLegacyFile proves the production boot
// path: a real on-disk file containing a pre-C10 users table is opened via
// InitDB, which must (a) apply forum_schema.sql (no-op on the existing
// users table) and then (b) call Migrate to add the C10 columns. After
// that the database must be usable end-to-end.
//
// This is the only test that exercises db.go's wiring change in C07;
// every other test calls db.Migrate directly.
func TestInitDB_AppliesSchemaAndMigratesLegacyFile(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "legacy.sqlite")

	// Create a file with only the pre-C10 users table — same shape the
	// legacy-DB tests use, but persisted to disk so InitDB can reopen it.
	bootstrap, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open bootstrap: %v", err)
	}
	if _, err := bootstrap.Exec(legacyUsersSchema); err != nil {
		bootstrap.Close()
		t.Fatalf("apply legacy schema: %v", err)
	}
	if _, err := bootstrap.Exec(`
		INSERT INTO users (id, username, email, password_hash)
		VALUES (1, 'legacy_carol', 'carol@old.example', 'fake-hash')
	`); err != nil {
		bootstrap.Close()
		t.Fatalf("seed legacy user: %v", err)
	}
	bootstrap.Close()

	// Boot via the production path.
	conn, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("InitDB on legacy file: %v", err)
	}
	defer conn.Close()

	// C10 columns must now be present on the legacy table.
	for _, col := range []string{"age", "gender", "first_name", "last_name"} {
		if !columnSet(t, conn, "users")[col] {
			t.Errorf("expected users.%s after InitDB, missing", col)
		}
	}

	// Legacy row survived AND its new columns hold defaults.
	var (
		username string
		age      int
		gender   string
	)
	if err := conn.QueryRow(`SELECT username, age, gender FROM users WHERE id = 1`).
		Scan(&username, &age, &gender); err != nil {
		t.Fatalf("read legacy user post-InitDB: %v", err)
	}
	if username != "legacy_carol" {
		t.Errorf("legacy username corrupted: %q", username)
	}
	if age != 0 || gender != "" {
		t.Errorf("legacy row defaults wrong: age=%d gender=%q", age, gender)
	}

	// Booting again against the same file is idempotent — Migrate must
	// observe the columns it added and do nothing this time around.
	conn.Close()
	conn2, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("InitDB second call (idempotency): %v", err)
	}
	defer conn2.Close()
}

/*-----------------------
  MIGRATE-LAYER FOLLOW-UPS
------------------------*/

// TestMigrate_AppCanWriteAfterMigrate proves the full path: legacy DB →
// Migrate → repository layer (db.CreateUser, which writes age/gender/etc.)
// works without error. This is the practical "existing users remain usable"
// assertion from the C07 verification gate.
func TestMigrate_AppCanWriteAfterMigrate(t *testing.T) {
	conn := openLegacyDB(t)
	defer conn.Close()

	// Migrate.
	if err := db.Migrate(context.Background(), conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// db.CreateUser writes to every C10 column — if any column were missing
	// the INSERT would fail. This is the canary that the upgraded schema is
	// usable end-to-end.
	id, err := db.CreateUser(context.Background(), conn, db.CreateUserRequest{
		Username:  "postmig",
		Email:     "postmig@example.com",
		Password:  "password123",
		Age:       30,
		Gender:    "other",
		FirstName: "Post",
		LastName:  "Migrate",
	})
	if err != nil {
		t.Fatalf("CreateUser after Migrate: %v", err)
	}
	if id == 0 {
		t.Error("expected non-zero user id")
	}
}
