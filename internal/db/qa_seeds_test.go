package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestApplyQASeeds(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "qa-seed.db")

	conn, err := InitDB(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("InitDB() error = %v", err)
	}
	defer conn.Close()

	if err := ApplyQASeeds(context.Background(), conn); err != nil {
		t.Fatalf("ApplyQASeeds() error = %v", err)
	}

	assertCount := func(table string, want int) {
		t.Helper()

		var got int
		if err := conn.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}

		if got != want {
			t.Fatalf("%s count = %d, want %d", table, got, want)
		}
	}

	assertCount("categories", 5)
	assertCount("users", 7)
	assertCount("posts", 12)
	assertCount("post_categories", 12)
	assertCount("comments", 11)
	assertCount("reactions", 12)
	assertCount("notifications", 17)
	assertCount("sessions", 0)

	// Social sample data: relationships, audiences, groups, events and chat.
	assertCount("follows", 12)
	assertCount("post_selected_followers", 1)
	assertCount("groups", 2)
	assertCount("group_memberships", 6)
	assertCount("group_invitations", 1)
	assertCount("group_join_requests", 1)
	assertCount("group_events", 2)
	assertCount("group_event_responses", 2)
	assertCount("private_messages", 4)
	assertCount("group_messages", 3)
	for kind, want := range map[string]int{"follow_request": 3, "group_invitation": 1, "group_join_request": 1, "group_event": 4} {
		var got int
		if err := conn.QueryRow(`SELECT COUNT(*) FROM notifications WHERE type=?`, kind).Scan(&got); err != nil || got != want {
			t.Fatalf("%s notifications = %d (%v), want %d", kind, got, err, want)
		}
	}

	// Seeding twice gives the same data: the reset clears the social rows too.
	if err := ApplyQASeeds(context.Background(), conn); err != nil {
		t.Fatalf("second ApplyQASeeds() error = %v", err)
	}
	assertCount("follows", 12)
	assertCount("groups", 2)
	assertCount("private_messages", 4)
	assertCount("notifications", 17)

	user, err := LoginUser(context.Background(), conn, LoginRequest{
		Username: "alexriver",
		Password: "password123",
	})
	if err != nil {
		t.Fatalf("LoginUser() error = %v", err)
	}

	if user.ID != 1 {
		t.Fatalf("LoginUser() returned user ID %d, want 1", user.ID)
	}
}

// assertSeedAllocation checks that a table holds only rows the QA seed inserted
// after its reset, numbered from 1, so earlier rows and their IDs are gone.
func assertSeedAllocation(t *testing.T, database *sql.DB, table string) {
	t.Helper()
	var rows, maxID, seq int
	if err := database.QueryRow(`SELECT COUNT(*), COALESCE(MAX(id), 0) FROM `+table).Scan(&rows, &maxID); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	if err := database.QueryRow(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name=?), 0)`, table).Scan(&seq); err != nil {
		t.Fatalf("sequence %s: %v", table, err)
	}
	if maxID != rows || seq != rows {
		t.Fatalf("%s: %d rows, max id %d, sequence %d; reset did not restart allocation", table, rows, maxID, seq)
	}
}
