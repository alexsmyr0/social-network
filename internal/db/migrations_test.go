package db

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestInitDBMigratesFreshDatabaseAndRepeats(t *testing.T) {
	path := filepath.Join(t.TempDir(), "social.sqlite")
	ctx := context.Background()

	conn, err := InitDB(ctx, path)
	if err != nil {
		t.Fatalf("first InitDB: %v", err)
	}
	var version, dirty int
	if err := conn.QueryRow(`SELECT version, dirty FROM schema_migrations`).Scan(&version, &dirty); err != nil {
		t.Fatalf("read migration state: %v", err)
	}
	if version != 1 || dirty != 0 {
		t.Fatalf("migration state = (%d, %d), want (1, 0)", version, dirty)
	}
	if _, err := conn.Exec(`INSERT INTO users
		(username, email, password_hash, first_name, last_name, date_of_birth)
		VALUES ('fixture_1', 'fixture@example.com', 'hash', 'Fixture', 'One', '2000-02-29')`); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}

	conn, err = InitDB(ctx, path)
	if err != nil {
		t.Fatalf("second InitDB: %v", err)
	}
	defer conn.Close()
	for table, want := range map[string]int{"users": 1, "categories": 5, "schema_migrations": 1} {
		var got int
		if err := conn.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		if got != want {
			t.Errorf("%s rows = %d, want %d", table, got, want)
		}
	}
}

func TestSocialAccountAndSessionConstraints(t *testing.T) {
	conn, err := InitDB(context.Background(), filepath.Join(t.TempDir(), "social.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	insert := func(username, email, first, last string, birth, nickname, about any) error {
		_, err := conn.Exec(`INSERT INTO users
			(username, email, password_hash, first_name, last_name, date_of_birth, nickname, about_me)
			VALUES (?, ?, 'hash', ?, ?, ?, ?, ?)`, username, email, first, last, birth, nickname, about)
		return err
	}
	if err := insert("account_1", "alex@example.com", "Alex", "One", "2000-02-29", nil, nil); err != nil {
		t.Fatalf("required-only account: %v", err)
	}
	if err := insert("account_2", "sam@example.com", "Sam", "Two", "2001-01-01", "Sam", "About Sam"); err != nil {
		t.Fatalf("account with optionals: %v", err)
	}
	for name, args := range map[string][]any{
		"missing birthdate":   {"account_3", "other@example.com", "Other", "Three", nil},
		"blank first name":    {"account_3", "other@example.com", "", "Three", "2000-01-01"},
		"uppercase email":     {"account_3", "Other@Example.com", "Other", "Three", "2000-01-01"},
		"duplicate email":     {"account_3", "alex@example.com", "Other", "Three", "2000-01-01"},
		"malformed birthdate": {"account_3", "other@example.com", "Other", "Three", "01/01/2000"},
	} {
		if err := insert(args[0].(string), args[1].(string), args[2].(string), args[3].(string), args[4], nil, nil); err == nil {
			t.Errorf("%s unexpectedly accepted", name)
		}
	}

	var nickname, about sql.NullString
	if err := conn.QueryRow(`SELECT nickname, about_me FROM users WHERE email = 'alex@example.com'`).Scan(&nickname, &about); err != nil {
		t.Fatal(err)
	}
	if nickname.Valid || about.Valid {
		t.Fatalf("omitted optionals = (%v, %v), want NULL", nickname, about)
	}

	for _, token := range []string{"one", "two"} {
		if _, err := conn.Exec(`INSERT INTO sessions (user_id, token) VALUES (1, ?)`, token); err != nil {
			t.Fatalf("independent nonexpiring session %s: %v", token, err)
		}
	}
	if _, err := conn.Exec(`INSERT INTO sessions (user_id, token) VALUES (999, 'invalid-user')`); err == nil {
		t.Fatal("session with missing user unexpectedly accepted")
	}
}

func TestLegacyDatabaseIsRejectedWithoutDeletion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forum.sqlite")
	old, err := sql.Open("sqlite3", path+"?_foreign_keys=on")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
		CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES users(id));
		INSERT INTO users VALUES (7, 'legacy@example.com');
		INSERT INTO posts VALUES (9, 7);`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	conn, err := InitDB(context.Background(), path)
	if conn != nil || !errors.Is(err, ErrLegacyDatabase) {
		t.Fatalf("InitDB = (%v, %v), want legacy rejection", conn, err)
	}

	old, err = sql.Open("sqlite3", path+"?_foreign_keys=on")
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	var postID, authorID int
	if err := old.QueryRow(`SELECT posts.id, users.id FROM posts JOIN users ON posts.author_id = users.id`).Scan(&postID, &authorID); err != nil {
		t.Fatalf("legacy relationship lost: %v", err)
	}
	if postID != 9 || authorID != 7 {
		t.Fatalf("legacy relationship changed: (%d, %d)", postID, authorID)
	}
	var versionTables int
	if err := old.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'`).Scan(&versionTables); err != nil {
		t.Fatal(err)
	}
	if versionTables != 0 {
		t.Fatal("legacy DB gained a migration version table")
	}
}

func TestFailedMigrationPreventsReadiness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "failed.sqlite")
	conn, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	broken := fstest.MapFS{
		"migrations/sqlite/000001_broken.up.sql":   &fstest.MapFile{Data: []byte("CREATE TABLE broken (id INTEGER); INVALID SQL;")},
		"migrations/sqlite/000001_broken.down.sql": &fstest.MapFile{Data: []byte("DROP TABLE broken;")},
	}
	if err := applyMigrationsFromFS(conn, fs.FS(broken)); err == nil {
		t.Fatal("broken migration unexpectedly succeeded")
	}
	conn.Close()

	ready, err := InitDB(context.Background(), path)
	if ready != nil || err == nil || !strings.Contains(err.Error(), "Dirty database version") {
		t.Fatalf("InitDB = (%v, %v), want dirty migration failure", ready, err)
	}
}
