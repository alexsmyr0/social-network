// internal/db/users_test.go
package db

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()

	dbConn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory sqlite: %v", err)
	}

	dbConn.SetMaxOpenConns(1)
	dbConn.SetMaxIdleConns(1)

	// Load schema
	schemaPath := filepath.Join(".", "forum_schema.sql")
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		dbConn.Close()
		t.Fatalf("failed to read schema file %s: %v", schemaPath, err)
	}

	if _, err := dbConn.Exec(string(schemaBytes)); err != nil {
		dbConn.Close()
		t.Fatalf("failed to exec schema: %v", err)
	}

	return dbConn
}

func TestGetUsersByIDs(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	ctx := context.Background()

	// Create test users
	id1, err := CreateUser(ctx, db, CreateUserRequest{
		Username:  "user1",
		Email:     "user1@test.com",
		Password:  "password123",
		Age:       20,
		Gender:    "male",
		FirstName: "User",
		LastName:  "One",
	})
	if err != nil {
		t.Fatal(err)
	}

	id2, err := CreateUser(ctx, db, CreateUserRequest{
		Username:  "user2",
		Email:     "user2@test.com",
		Password:  "password123",
		Age:       21,
		Gender:    "female",
		FirstName: "User",
		LastName:  "Two",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Test fetching multiple users
	users, err := GetUsersByIDs(ctx, db, []int64{id1, id2})
	if err != nil {
		t.Fatalf("GetUsersByIDs failed: %v", err)
	}

	if len(users) != 2 {
		t.Errorf("expected 2 users, got %d", len(users))
	}

	// Verify IDs
	idMap := make(map[int64]bool)
	for _, u := range users {
		idMap[u.ID] = true
	}
	if !idMap[id1] || !idMap[id2] {
		t.Error("returned users don't match requested IDs")
	}
}

func TestGetUsersByIDs_EmptyList(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	ctx := context.Background()

	users, err := GetUsersByIDs(ctx, db, []int64{})
	if err != nil {
		t.Fatalf("GetUsersByIDs failed: %v", err)
	}

	if users != nil {
		t.Errorf("expected nil for empty input, got %v", users)
	}
}

func TestGetUsersByIDs_PartialFound(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	ctx := context.Background()

	// Create one user
	id1, err := CreateUser(ctx, db, CreateUserRequest{
		Username:  "user1",
		Email:     "user1@test.com",
		Password:  "password123",
		Age:       20,
		Gender:    "male",
		FirstName: "User",
		LastName:  "One",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Request non-existent IDs along with existing
	users, err := GetUsersByIDs(ctx, db, []int64{id1, 99999, 88888})
	if err != nil {
		t.Fatalf("GetUsersByIDs failed: %v", err)
	}

	// Should only return the user that exists
	if len(users) != 1 {
		t.Errorf("expected 1 user, got %d", len(users))
	}
	if users[0].ID != id1 {
		t.Errorf("expected user id %d, got %d", id1, users[0].ID)
	}
}
