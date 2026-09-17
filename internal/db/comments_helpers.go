// internal/db/comments_helpers.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

/*------------------
  COMMENTS HELPERS
------------------*/

// Normalize pagination for comments
func normalizeCommentsPagination(params *ListCommentsParams) {
	params.Page, params.PerPage = normalizePagination(params.Page, params.PerPage)
}

// Count comments for a specific post
func countCommentsByPost(
	ctx context.Context,
	db *sql.DB,
	postID int64,
) (int, error) {

	var total int
	if err := db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM comments WHERE post_id = ?`,
		postID,
	).Scan(&total); err != nil {
		return 0, fmt.Errorf("count comments: %w", err)
	}
	return total, nil
}

// Fetch paginated comments for a post (NO reactions here)
func fetchCommentsByPost(
	ctx context.Context,
	db *sql.DB,
	params ListCommentsParams,
) ([]Comment, error) {

	offset := (params.Page - 1) * params.PerPage

	rows, err := db.QueryContext(ctx, `
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
		WHERE c.post_id = ?
		ORDER BY c.created_at ASC
		LIMIT ? OFFSET ?
	`, params.PostID, params.PerPage, offset)
	if err != nil {
		return nil, fmt.Errorf("query comments: %w", err)
	}
	defer rows.Close()

	var comments []Comment

	for rows.Next() {
		var comment Comment
		var parentID sql.NullInt64
		var imageURL sql.NullString

		if err := rows.Scan(
			&comment.ID,
			&comment.PostID,
			&comment.UserID,
			&comment.Username,
			&parentID,
			&comment.Body,
			&imageURL,
			&comment.CreatedAt,
			&comment.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan comment: %w", err)
		}

		if parentID.Valid {
			id := parentID.Int64
			comment.ParentCommentID = &id
		}
		if imageURL.Valid {
			comment.ImageURL = &imageURL.String
		}

		comments = append(comments, comment)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows comments: %w", err)
	}

	return comments, nil
}

// Attach like/dislike counts to each comment
func attachCommentReactions(
	ctx context.Context,
	db *sql.DB,
	comments []Comment,
) error {

	for i := range comments {
		likes, dislikes, err := CountReactionsForComment(ctx, db, comments[i].ID)
		if err != nil {
			return fmt.Errorf("attach comment reactions: %w", err)
		}
		comments[i].Likes = likes
		comments[i].Dislikes = dislikes
	}
	return nil
}

func attachCommentMyReactions(
	ctx context.Context,
	db *sql.DB,
	comments []Comment,
	viewerID int64,
) error {

	if viewerID <= 0 || len(comments) == 0 {
		return nil
	}

	commentIDs := make([]int64, 0, len(comments))
	index := make(map[int64]*Comment)

	for i := range comments {
		commentIDs = append(commentIDs, comments[i].ID)
		index[comments[i].ID] = &comments[i]
	}

	query := `
		SELECT comment_id, value
		FROM reactions
		WHERE user_id = ?
		  AND comment_id IS NOT NULL
		  AND comment_id IN (` + placeholders(len(commentIDs)) + `)
	`

	args := make([]any, 0, len(commentIDs)+1)
	args = append(args, viewerID)
	for _, id := range commentIDs {
		args = append(args, id)
	}

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var commentID int64
		var reaction int
		if err := rows.Scan(&commentID, &reaction); err != nil {
			return err
		}

		if c, ok := index[commentID]; ok {
			c.MyReaction = reaction
		}
	}

	return rows.Err()
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}
