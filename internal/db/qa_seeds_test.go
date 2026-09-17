package db

import (
	"context"
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
	assertCount("posts", 8)
	assertCount("post_categories", 12)
	assertCount("comments", 10)
	assertCount("reactions", 12)
	assertCount("notifications", 8)
	assertCount("sessions", 0)

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
