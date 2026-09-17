// tests/notifications_test.go

package tests

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	dbpkg "forum/internal/db"
	repository "forum/internal/db"
)

/*-------------------------------------------------
  Helpers (local to this test file)
--------------------------------------------------*/

func createTestUser(t *testing.T, dbConn *sql.DB, username string) (int64, string) {
	t.Helper()

	email := fmt.Sprintf("%s_%d@example.com", username, time.Now().UnixNano())

	userID, err := dbpkg.CreateUser(context.Background(), dbConn, dbpkg.CreateUserRequest{
		Username:  username,
		Email:     email,
		Password:  "password123",
		FirstName: "First",
		LastName:  "Last",
		Age:       25,
		Gender:    "other",
	})
	if err != nil {
		t.Fatalf("create user: %v", err)
	}

	return userID, email
}

func createTestPost(t *testing.T, dbConn *sql.DB, authorID int64) int64 {
	t.Helper()

	res, err := dbConn.Exec(`
		INSERT INTO posts (author_id, title, body, status)
		VALUES (?, 'title', 'body', 'published')
	`, authorID)
	if err != nil {
		t.Fatalf("create post: %v", err)
	}

	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}

	return id
}

func countNotifications(t *testing.T, dbConn *sql.DB) int {
	t.Helper()

	var count int
	err := dbConn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&count)
	if err != nil {
		t.Fatalf("count notifications: %v", err)
	}

	return count
}

/*-------------------------------------------------
  Tests
--------------------------------------------------*/

func TestNotification_OnPostLike(t *testing.T) {
	dbConn := setupTestDB(t)
	ctx := context.Background()

	authorID, _ := createTestUser(t, dbConn, "author")
	userID, _ := createTestUser(t, dbConn, "user")
	postID := createTestPost(t, dbConn, authorID)

	_, err := repository.ToggleReaction(ctx, dbConn, userID, postID, 1, "post")
	if err != nil {
		t.Fatalf("toggle reaction: %v", err)
	}

	if count := countNotifications(t, dbConn); count != 1 {
		t.Fatalf("expected 1 notification, got %d", count)
	}
}

func TestNotification_NoDuplicateOnRepeatedLike(t *testing.T) {
	dbConn := setupTestDB(t)
	ctx := context.Background()

	authorID, _ := createTestUser(t, dbConn, "author")
	userID, _ := createTestUser(t, dbConn, "user")
	postID := createTestPost(t, dbConn, authorID)

	// like
	_, _ = repository.ToggleReaction(ctx, dbConn, userID, postID, 1, "post")
	// remove
	_, _ = repository.ToggleReaction(ctx, dbConn, userID, postID, 1, "post")
	// like again
	_, _ = repository.ToggleReaction(ctx, dbConn, userID, postID, 1, "post")

	if count := countNotifications(t, dbConn); count != 1 {
		t.Fatalf("expected 1 notification after repeated likes, got %d", count)
	}
}

func TestNotification_NoSelfNotification(t *testing.T) {
	dbConn := setupTestDB(t)
	ctx := context.Background()

	authorID, _ := createTestUser(t, dbConn, "author")
	postID := createTestPost(t, dbConn, authorID)

	_, _ = repository.ToggleReaction(ctx, dbConn, authorID, postID, 1, "post")

	if count := countNotifications(t, dbConn); count != 0 {
		t.Fatalf("expected 0 self-notifications, got %d", count)
	}
}

func TestNotification_OnComment(t *testing.T) {
	dbConn := setupTestDB(t)
	ctx := context.Background()

	authorID, _ := createTestUser(t, dbConn, "author")
	userID, _ := createTestUser(t, dbConn, "user")
	postID := createTestPost(t, dbConn, authorID)

	_, err := repository.CreateComment(ctx, dbConn, repository.CreateCommentInput{
		PostID: postID,
		UserID: userID,
		Body:   "hello",
	})
	if err != nil {
		t.Fatalf("create comment: %v", err)
	}

	if count := countNotifications(t, dbConn); count != 1 {
		t.Fatalf("expected 1 notification for comment, got %d", count)
	}
}
