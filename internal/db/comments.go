// internal/db/comments.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

/*-----------------
  DATA STRUCTURES
-----------------*/

type Comment struct {
	ID              int64   `json:"id"`
	PostID          int64   `json:"post_id"`
	UserID          int64   `json:"user_id"`
	Username        string  `json:"username"`
	ParentCommentID *int64  `json:"parent_comment_id,omitempty"`
	Body            string  `json:"body"`
	ImageURL        *string `json:"image_url"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at,omitempty"`
	Likes           int     `json:"likes"`
	Dislikes        int     `json:"dislikes"`
	MyReaction      int     `json:"my_reaction"`
}

type ListCommentsParams struct {
	PostID  int64
	Page    int
	PerPage int
}

type ListCommentsResult struct {
	Comments []Comment
	Total    int
}

/*-----------------
  LIST COMMENTS
-----------------*/

func ListCommentsByPost(
	ctx context.Context,
	db *sql.DB,
	p ListCommentsParams,
	viewerID int64,
) (ListCommentsResult, error) {

	// use p not params
	normalizeCommentsPagination(&p)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	total, err := countCommentsByPost(ctx, db, p.PostID)
	if err != nil {
		return ListCommentsResult{}, err
	}

	comments, err := fetchCommentsByPost(ctx, db, p)
	if err != nil {
		return ListCommentsResult{}, err
	}

	// total reactions
	if err := attachCommentReactions(ctx, db, comments); err != nil {
		return ListCommentsResult{}, err
	}

	// CRITICAL PART
	if viewerID > 0 {
		if err := attachCommentMyReactions(ctx, db, comments, viewerID); err != nil {
			return ListCommentsResult{}, err
		}
	}

	return ListCommentsResult{
		Comments: comments,
		Total:    total,
	}, nil
}

/*----------------
  CREATE COMMENT
----------------*/

type CreateCommentInput struct {
	PostID          int64
	UserID          int64
	ParentCommentID *int64
	Body            string
	ImageURL        *string
}

func CreateComment(
	ctx context.Context,
	db *sql.DB,
	input CreateCommentInput,
) (int64, error) {

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	if err := ensurePostExists(ctx, db, input.PostID); err != nil {
		return 0, err
	}

	const query = `
		INSERT INTO comments (post_id, user_id, parent_comment_id, body, image_url, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
	`

	res, err := db.ExecContext(ctx, query,
		input.PostID,
		input.UserID,
		input.ParentCommentID,
		input.Body,
		input.ImageURL,
	)
	if err != nil {
		return 0, fmt.Errorf("create comment: %w", err)
	}

	commentID, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("last insert id: %w", err)
	}

	/* =====================================================
	   SEND NOTIFICATION TO POST OWNER
	 ===================================================== */

	postOwnerID, err := GetPostAuthorID(ctx, db, input.PostID)
	if err == nil && postOwnerID != input.UserID {

		_ = InsertNotification(
			ctx,
			db,
			postOwnerID,   // recipient
			input.UserID,  // actor
			"comment",     // notification type
			&input.PostID, // MUST provide postID
			&commentID,    // also include commentID for redirect
		)
	}

	return commentID, nil
}

/*-------------
  GET COMMENT
-------------*/

func GetCommentWithAuthor(
	ctx context.Context,
	db *sql.DB,
	id int64,
) (Comment, error) {

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	const query = `
		SELECT
			c.id,
			c.post_id,
			c.user_id,
			u.username,
			c.parent_comment_id,
			c.body,
			c.image_url,
			c.created_at,
			c.updated_at
		FROM comments c
		JOIN users u ON u.id = c.user_id
		WHERE c.id = ?
	`

	var comment Comment
	var parentID sql.NullInt64
	var imageURL sql.NullString

	err := db.QueryRowContext(ctx, query, id).
		Scan(
			&comment.ID,
			&comment.PostID,
			&comment.UserID,
			&comment.Username,
			&parentID,
			&comment.Body,
			&imageURL,
			&comment.CreatedAt,
			&comment.UpdatedAt,
		)
	if err != nil {
		return Comment{}, err
	}

	if parentID.Valid {
		pid := parentID.Int64
		comment.ParentCommentID = &pid
	}
	if imageURL.Valid {
		comment.ImageURL = &imageURL.String
	}

	likes, dislikes, err := CountReactionsForComment(ctx, db, id)
	if err != nil {
		return Comment{}, err
	}
	comment.Likes = likes
	comment.Dislikes = dislikes

	return comment, nil
}

/*----------------
  UPDATE COMMENT
----------------*/

type UpdateCommentInput struct {
	Body           *string
	ImageURL       *string
	HasImageUpdate bool
}

func UpdateComment(ctx context.Context, db *sql.DB, id int64, in UpdateCommentInput) error {

	setParts := []string{}
	args := []any{}

	if in.Body != nil {
		setParts = append(setParts, "body = ?")
		args = append(args, *in.Body)
	}

	if in.HasImageUpdate {
		setParts = append(setParts, "image_url = ?")
		args = append(args, in.ImageURL)
	}

	if len(setParts) == 0 {
		return nil
	}

	setParts = append(setParts, "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')")
	args = append(args, id)

	query := `UPDATE comments SET ` + strings.Join(setParts, ", ") + ` WHERE id = ?`

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	_, err := db.ExecContext(ctx, query, args...)
	return err
}

/*----------------
  DELETE COMMENT
----------------*/

func DeleteComment(ctx context.Context, db *sql.DB, id int64) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	_, err := db.ExecContext(ctx, `DELETE FROM comments WHERE id = ?`, id)
	return err
}

/*---------
  HELPERS
---------*/

func ensurePostExists(ctx context.Context, db *sql.DB, postID int64) error {
	var exists bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM posts WHERE id = ?)`,
		postID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("check post exists: %w", err)
	}

	if !exists {
		return sql.ErrNoRows
	}

	return nil
}
