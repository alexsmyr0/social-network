package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStartupMigrationsFreshAndRepeated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "social.db")
	ctx := context.Background()
	first, err := InitDB(ctx, path)
	if err != nil {
		t.Fatalf("first startup: %v", err)
	}
	if _, err := first.ExecContext(ctx, `INSERT INTO users
		(username, email, password_hash, first_name, last_name, date_of_birth)
		VALUES ('internal1', 'first@example.com', 'hash', 'First', 'Person', '2000-02-29')`); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	first.Close()

	second, err := InitDB(ctx, path)
	if err != nil {
		t.Fatalf("second startup: %v", err)
	}
	defer second.Close()
	var users, categories, version int
	if err := second.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := second.QueryRow(`SELECT COUNT(*) FROM categories`).Scan(&categories); err != nil {
		t.Fatal(err)
	}
	if err := second.QueryRow(`SELECT version FROM schema_migrations WHERE dirty = 0`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if users != 1 || categories != 5 || version != 3 {
		t.Fatalf("repeated startup: users=%d categories=%d version=%d", users, categories, version)
	}
}

func TestStartupMigrationFailurePreventsReadiness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "broken.db")
	files := fstest.MapFS{
		"migrations/sqlite/000001_broken.up.sql":   &fstest.MapFile{Data: []byte("CREATE TABLE users (id INTEGER); INVALID SQL;")},
		"migrations/sqlite/000001_broken.down.sql": &fstest.MapFile{Data: []byte("DROP TABLE users;")},
	}
	if conn, err := initDBWithMigrations(context.Background(), path, files); err == nil {
		conn.Close()
		t.Fatal("failed migration allowed startup")
	}
	if conn, err := InitDB(context.Background(), path); err == nil {
		conn.Close()
		t.Fatal("dirty migration allowed normal startup")
	}
	conn, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var version, dirty int
	if err := conn.QueryRow(`SELECT version, dirty FROM schema_migrations`).Scan(&version, &dirty); err != nil {
		t.Fatal(err)
	}
	if version != 1 || dirty != 1 {
		t.Fatalf("failed migration state = %d, %d; want version 1 dirty", version, dirty)
	}
}

func TestStartupRejectsLegacyDatabaseWithoutChangingRelationships(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forum.db")
	conn, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
		CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES users(id));
		INSERT INTO users VALUES (4, 'old@example.com');
		INSERT INTO posts VALUES (9, 4);`)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()

	if opened, err := InitDB(context.Background(), path); err == nil {
		opened.Close()
		t.Fatal("legacy database accepted")
	} else if !strings.Contains(err.Error(), "fresh DB_PATH") {
		t.Fatalf("legacy error lacks recovery action: %v", err)
	}
	conn, err = sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var email string
	if err := conn.QueryRow(`SELECT u.email FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = 9`).Scan(&email); err != nil || email != "old@example.com" {
		t.Fatalf("legacy relationship changed: email=%q err=%v", email, err)
	}
	var versioned int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name='schema_migrations'`).Scan(&versioned); err != nil || versioned != 0 {
		t.Fatalf("legacy database modified: versioned=%d err=%v", versioned, err)
	}
}

func TestStartupAccountAndSessionConstraints(t *testing.T) {
	conn, err := InitDB(context.Background(), filepath.Join(t.TempDir(), "constraints.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	insert := `INSERT INTO users (username, email, password_hash, first_name, last_name, date_of_birth, nickname, about_me)
		VALUES (?, ?, 'hash', ?, 'Person', ?, ?, ?)`
	for _, tc := range []struct {
		name, email, first, dob string
		nickname, about         any
		valid                   bool
	}{
		{"required", "required@example.com", "A", "2000-01-01", nil, nil, true},
		{"optional", "optional@example.com", "B", "2000-01-02", "B", "About", true},
		{"missing name", "no-name@example.com", "", "2000-01-03", nil, nil, false},
		{"missing date", "no-date@example.com", "C", "", nil, nil, false},
		{"bad shape", "shape@example.com", "D", "20000104", nil, nil, false},
		{"duplicate email", "REQUIRED@example.com", "E", "2000-01-05", nil, nil, false},
	} {
		_, err := conn.Exec(insert, tc.name, tc.email, tc.first, tc.dob, tc.nickname, tc.about)
		if (err == nil) != tc.valid {
			t.Fatalf("%s: insert err=%v, valid=%v", tc.name, err, tc.valid)
		}
	}
	var userID int64
	if err := conn.QueryRow(`SELECT id FROM users WHERE email='required@example.com'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"one", "two"} {
		if _, err := conn.Exec(`INSERT INTO sessions (user_id, token, ip, user_agent) VALUES (?, ?, '', '')`, userID, token); err != nil {
			t.Fatalf("independent session %s: %v", token, err)
		}
	}
	if _, err := conn.Exec(`UPDATE sessions SET is_valid=0, revoked_at='2026-09-27T00:00:00Z' WHERE token='one'`); err != nil {
		t.Fatalf("revoke one session: %v", err)
	}
	var active int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM sessions WHERE is_valid=1`).Scan(&active); err != nil || active != 1 {
		t.Fatalf("independent revocation: active=%d err=%v", active, err)
	}
}
