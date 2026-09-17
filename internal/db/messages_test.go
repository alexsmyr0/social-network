// internal/db/messages_test.go
package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

// TestGetChatRoster_QueryErrorPropagates exercises the QueryContext error branch
// in GetChatRoster — closing the DB before the call guarantees the driver
// returns an error rather than rows. The function must wrap and return it.
func TestGetChatRoster_QueryErrorPropagates(t *testing.T) {
	dbConn := setupTestDB(t)
	if err := dbConn.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	_, err := GetChatRoster(context.Background(), dbConn, 1)
	if err == nil {
		t.Fatal("expected error from closed DB, got nil")
	}
	if !strings.Contains(err.Error(), "get chat roster") {
		t.Errorf("error not wrapped with context: %v", err)
	}
}

// TestGetChatRoster_ImageOnlyPreview verifies the #52 fix: when the latest DM
// in a pair is image-only (empty body, image_path set — which the schema CHECK
// permits), the roster preview falls back to the "[image]" glyph instead of an
// empty string.
func TestGetChatRoster_ImageOnlyPreview(t *testing.T) {
	dbConn := setupTestDB(t)
	defer dbConn.Close()
	ctx := context.Background()

	mkUser := func(name string) int64 {
		id, err := CreateUser(ctx, dbConn, CreateUserRequest{
			Username: name, Email: name + "@example.com", Password: "password123",
			Age: 25, Gender: "other", FirstName: name, LastName: "Test",
		})
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		return id
	}
	alice := mkUser("alice")
	bob := mkUser("bob")

	// Insert an image-only DM directly (the handler layer blocks empty bodies,
	// but the DB schema allows body='' when image_path is present).
	if _, err := dbConn.ExecContext(ctx, `
		INSERT INTO private_messages (sender_id, recipient_id, body, image_path)
		VALUES (?, ?, '', '/static/uploads/dm/pic.jpg')
	`, bob, alice); err != nil {
		t.Fatalf("insert image-only DM: %v", err)
	}

	entries, err := GetChatRoster(ctx, dbConn, alice)
	if err != nil {
		t.Fatalf("GetChatRoster: %v", err)
	}
	var got string
	for _, e := range entries {
		if e.UserID == bob {
			got = e.LastMessagePreview
		}
	}
	if got != "[image]" {
		t.Errorf("image-only roster preview = %q, want %q", got, "[image]")
	}
}

// TestGetChatRoster_ScanErrorPropagates exercises the rows.Scan error branch by
// pointing the function at a synthetic table whose column types don't match the
// scan targets. We achieve that by overriding `users` and `private_messages`
// with stand-in views that return the wrong types.
//
// The Scan call expects (int64, string, string, string, int64). We return a
// non-numeric blob in place of `id`, which fails int64 scanning.
func TestGetChatRoster_ScanErrorPropagates(t *testing.T) {
	dbConn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer dbConn.Close()
	dbConn.SetMaxOpenConns(1)
	dbConn.SetMaxIdleConns(1)

	// Create minimal schema sufficient for the CTE to plan, then replace the
	// `users` table with one whose `id` column is TEXT-not-numeric — Scan into
	// an int64 will fail.
	if _, err := dbConn.Exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
		CREATE TABLE private_messages (
			id INTEGER PRIMARY KEY,
			sender_id INTEGER NOT NULL,
			recipient_id INTEGER NOT NULL,
			body TEXT NOT NULL,
			image_path TEXT,
			created_at TEXT NOT NULL DEFAULT ''
		);
		INSERT INTO users (id, username) VALUES ('not-an-int', 'mallory');
	`); err != nil {
		t.Fatalf("schema setup: %v", err)
	}

	_, err = GetChatRoster(context.Background(), dbConn, 1)
	if err == nil {
		t.Fatal("expected scan error, got nil")
	}
	if !strings.Contains(err.Error(), "scan roster row") {
		t.Errorf("error not wrapped with context: %v", err)
	}
}
