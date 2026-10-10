// internal/db/comments.go
package db

import (
	"context"
	"database/sql"
	"encoding/json"
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
	Version         int64   `json:"version,omitempty"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at,omitempty"`
	Likes           int     `json:"likes"`
	Dislikes        int     `json:"dislikes"`
	MyReaction      int     `json:"my_reaction"`
	// Post is the parent post projection a profile comment list attaches to
	// comments on group posts, so the group scope stays visible. It is nil (and
	// omitted) everywhere else, including every personal-post comment.
	Post *CommentParent `json:"post,omitempty"`
}

// CommentParent is the activity-style parent post of a profile comment on a
// group post.
type CommentParent struct {
	ID         int64          `json:"id"`
	AuthorID   int64          `json:"author_id"`
	Author     string         `json:"author"`
	Title      *string        `json:"title"`
	ImageURL   *string        `json:"image_url"`
	Categories []PostCategory `json:"categories"`
	Likes      int            `json:"likes"`
	Dislikes   int            `json:"dislikes"`
	MyReaction int            `json:"my_reaction"`
	Group      *PostGroup     `json:"group"`
}

// A stored version marks the social wire shape: parent_comment_id is always
// present (null for top-level comments). Historical forum rows keep omitempty.
func (c Comment) MarshalJSON() ([]byte, error) {
	type alias Comment
	if c.Version == 0 {
		return json.Marshal(alias(c))
	}
	return json.Marshal(struct {
		alias
		ParentCommentID *int64 `json:"parent_comment_id"`
	}{alias(c), c.ParentCommentID})
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
	if viewer, ok := SocialViewer(ctx); ok {
		return socialCommentPage(ctx, db, viewer, p.PostID, p.Page, p.PerPage)
	}

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
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	// Acquire the write lock before reading ownership or permissions.
	if _, err := tx.ExecContext(ctx, `UPDATE posts SET id=id WHERE 0`); err != nil {
		return 0, err
	}
	var owner int64
	if err := tx.QueryRowContext(ctx, `SELECT author_id FROM posts WHERE id=?`, input.PostID).Scan(&owner); err != nil {
		return 0, err
	}
	if input.ParentCommentID != nil {
		var parentPost int64
		if err := tx.QueryRowContext(ctx, `SELECT post_id FROM comments WHERE id=?`, *input.ParentCommentID).Scan(&parentPost); err != nil {
			return 0, err
		}
		if parentPost != input.PostID {
			return 0, sql.ErrNoRows
		}
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO comments(post_id,user_id,parent_comment_id,body,image_url) VALUES(?,?,?,?,?)`, input.PostID, input.UserID, input.ParentCommentID, input.Body, input.ImageURL)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	var announced bool
	if owner != input.UserID {
		res, err := tx.ExecContext(ctx, `INSERT INTO notifications(recipient_id,actor_id,type,post_id,comment_id) VALUES(?,?,'comment',?,NULL) ON CONFLICT DO NOTHING`, owner, input.UserID, input.PostID)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		announced = n > 0
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	if announced {
		fireNotificationHook(owner)
	}
	return id, nil

}

/*-------------
  GET COMMENT
-------------*/

func GetCommentWithAuthor(
	ctx context.Context,
	db *sql.DB,
	id int64,
) (Comment, error) {
	if viewer, ok := SocialViewer(ctx); ok {
		return socialGetComment(ctx, db, viewer, id)
	}

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
