package tests

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	repository "forum/internal/db"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	if _, err := db.Exec(`PRAGMA foreign_keys = ON;`); err != nil {
		t.Fatalf("enable foreign_keys: %v", err)
	}

	schemaBytes, err := os.ReadFile("../db/forum_schema.sql")
	if err != nil {
		t.Fatalf("read schema: %v", err)
	}

	if _, err := db.Exec(string(schemaBytes)); err != nil {
		t.Fatalf("exec schema: %v", err)
	}

	return db
}

func seedUserAndPost(t *testing.T, db *sql.DB) (userID, postID int64) {
	t.Helper()

	res, err := db.Exec(
		`INSERT INTO users (username, email, password_hash, first_name, last_name, age, gender) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"user1",
		"u1@example.com",
		"hash",
		"First",
		"Last",
		25,
		"Other",
	)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	userID, _ = res.LastInsertId()

	res, err = db.Exec(
		`INSERT INTO posts (author_id, title, body, status) VALUES (?, ?, ?, ?)`,
		userID,
		"t",
		"b",
		"published",
	)
	if err != nil {
		t.Fatalf("insert post: %v", err)
	}
	postID, _ = res.LastInsertId()

	return userID, postID
}

func TestCreateGetUpdateDeleteComment(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)
	ctx := context.Background()

	// CREATE
	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID: postID,
		UserID: userID,
		Body:   "hello",
	})
	if err != nil {
		t.Fatalf("CreateComment: %v", err)
	}
	if commentID == 0 {
		t.Fatalf("expected non-zero commentID")
	}

	// GET
	c, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor: %v", err)
	}

	if c.ID != commentID || c.PostID != postID || c.UserID != userID {
		t.Fatalf("unexpected comment: %+v", c)
	}
	if c.Body != "hello" {
		t.Fatalf("expected body 'hello', got %q", c.Body)
	}
	if c.Username != "user1" {
		t.Fatalf("expected username 'user1', got %q", c.Username)
	}
	if c.ParentCommentID != nil {
		t.Fatalf("expected nil parent_comment_id")
	}
	if c.Likes != 0 || c.Dislikes != 0 {
		t.Fatalf("expected 0 likes/dislikes, got %d/%d", c.Likes, c.Dislikes)
	}
	if strings.TrimSpace(c.CreatedAt) == "" {
		t.Fatalf("expected CreatedAt to be set")
	}

	// UPDATE
	newBody := "updated"
	if err := repository.UpdateComment(ctx, db, commentID, repository.UpdateCommentInput{
		Body: &newBody,
	}); err != nil {
		t.Fatalf("UpdateComment: %v", err)
	}

	c2, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor after update: %v", err)
	}
	if c2.Body != "updated" {
		t.Fatalf("expected updated body, got %q", c2.Body)
	}

	// DELETE
	if err := repository.DeleteComment(ctx, db, commentID); err != nil {
		t.Fatalf("DeleteComment: %v", err)
	}

	_, err = repository.GetCommentWithAuthor(ctx, db, commentID)
	if err == nil {
		t.Fatalf("expected error after delete")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows after delete, got %v", err)
	}
}

func TestCreateComment_ImageOnlyAllowed(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)
	ctx := context.Background()

	imageURL := "/static/uploads/comment-image.jpg"
	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID:   postID,
		UserID:   userID,
		Body:     "",
		ImageURL: &imageURL,
	})
	if err != nil {
		t.Fatalf("CreateComment image-only: %v", err)
	}
	if commentID == 0 {
		t.Fatalf("expected non-zero commentID for image-only comment")
	}

	comment, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor image-only: %v", err)
	}
	if comment.ImageURL == nil || *comment.ImageURL != imageURL {
		t.Fatalf("expected image_url %q, got %v", imageURL, comment.ImageURL)
	}
	if comment.Body != "" {
		t.Fatalf("expected empty body for image-only comment, got %q", comment.Body)
	}
}

func TestUpdateComment_NoFieldsIsNoop(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)
	ctx := context.Background()

	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID: postID,
		UserID: userID,
		Body:   "x",
	})
	if err != nil {
		t.Fatalf("CreateComment: %v", err)
	}

	if err := repository.UpdateComment(ctx, db, commentID, repository.UpdateCommentInput{}); err != nil {
		t.Fatalf("UpdateComment noop: %v", err)
	}
}

func TestUpdateComment_ImageURLUpdateAndRemove(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)
	ctx := context.Background()

	initialImageURL := "/static/uploads/initial-comment.jpg"
	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID:   postID,
		UserID:   userID,
		Body:     "hello with image",
		ImageURL: &initialImageURL,
	})
	if err != nil {
		t.Fatalf("CreateComment: %v", err)
	}

	updatedImageURL := "/static/uploads/updated-comment.png"
	if err := repository.UpdateComment(ctx, db, commentID, repository.UpdateCommentInput{
		ImageURL:       &updatedImageURL,
		HasImageUpdate: true,
	}); err != nil {
		t.Fatalf("UpdateComment image replace: %v", err)
	}

	updatedComment, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor after image replace: %v", err)
	}
	if updatedComment.ImageURL == nil || *updatedComment.ImageURL != updatedImageURL {
		t.Fatalf("expected replaced image_url %q, got %v", updatedImageURL, updatedComment.ImageURL)
	}

	if err := repository.UpdateComment(ctx, db, commentID, repository.UpdateCommentInput{
		ImageURL:       nil,
		HasImageUpdate: true,
	}); err != nil {
		t.Fatalf("UpdateComment image remove: %v", err)
	}

	removedImageComment, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor after image remove: %v", err)
	}
	if removedImageComment.ImageURL != nil {
		t.Fatalf("expected nil image_url after remove, got %v", removedImageComment.ImageURL)
	}
}

func TestUpdateComment_RemoveImageWithoutBodyFails(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)
	ctx := context.Background()

	initialImageURL := "/static/uploads/image-only-comment.jpg"
	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID:   postID,
		UserID:   userID,
		Body:     "",
		ImageURL: &initialImageURL,
	})
	if err != nil {
		t.Fatalf("CreateComment image-only: %v", err)
	}

	err = repository.UpdateComment(ctx, db, commentID, repository.UpdateCommentInput{
		ImageURL:       nil,
		HasImageUpdate: true,
	})
	if err == nil {
		t.Fatalf("expected error when removing image from image-only comment")
	}
}

func TestCreateComment_FKEnforced(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	ctx := context.Background()

	_, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID: 999,
		UserID: 999,
		Body:   "x",
	})
	if err == nil {
		t.Fatalf("expected fk error")
	}
}

func TestCommentReactions_CountsFlowThroughGetCommentWithAuthor(t *testing.T) {
	db := newTestDB(t)
	defer db.Close()

	userID, postID := seedUserAndPost(t, db)

	res, err := db.Exec(
		`INSERT INTO users (username, email, password_hash, first_name, last_name, age, gender) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"user2",
		"u2@example.com",
		"hash",
		"First2",
		"Last2",
		30,
		"Other",
	)
	if err != nil {
		t.Fatalf("insert user2: %v", err)
	}
	user2, _ := res.LastInsertId()

	ctx := context.Background()
	commentID, err := repository.CreateComment(ctx, db, repository.CreateCommentInput{
		PostID: postID,
		UserID: userID,
		Body:   "hello",
	})
	if err != nil {
		t.Fatalf("CreateComment: %v", err)
	}

	_, err = db.Exec(
		`INSERT INTO reactions (user_id, comment_id, value) VALUES (?, ?, ?)`,
		userID,
		commentID,
		1,
	)
	if err != nil {
		t.Fatalf("insert like reaction: %v", err)
	}

	_, err = db.Exec(
		`INSERT INTO reactions (user_id, comment_id, value) VALUES (?, ?, ?)`,
		user2,
		commentID,
		-1,
	)
	if err != nil {
		t.Fatalf("insert dislike reaction: %v", err)
	}

	time.Sleep(5 * time.Millisecond)

	c, err := repository.GetCommentWithAuthor(ctx, db, commentID)
	if err != nil {
		t.Fatalf("GetCommentWithAuthor: %v", err)
	}

	if c.Likes != 1 || c.Dislikes != 1 {
		t.Fatalf("expected likes/dislikes 1/1, got %d/%d", c.Likes, c.Dislikes)
	}
}
