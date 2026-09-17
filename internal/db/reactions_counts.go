// Internal/db/reactions_counts.go
package db

import (
	"context"
	"database/sql"
	"fmt"
)

// CountReactionsForPost returns total likes and dislikes for a post.
func CountReactionsForPost(
	ctx context.Context,
	db *sql.DB,
	postID int64,
) (likes int, dislikes int, err error) {

	err = db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)
		FROM reactions
		WHERE post_id = ?
	`, postID).Scan(&likes, &dislikes)

	if err != nil {
		if err == sql.ErrNoRows {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("count post reactions: %w", err)
	}

	return likes, dislikes, nil
}

// CountReactionsForComment returns total likes and dislikes for a comment.
func CountReactionsForComment(
	ctx context.Context,
	db *sql.DB,
	commentID int64,
) (likes int, dislikes int, err error) {

	err = db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)
		FROM reactions
		WHERE comment_id = ?
	`, commentID).Scan(&likes, &dislikes)

	if err != nil {
		if err == sql.ErrNoRows {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("count comment reactions: %w", err)
	}

	return likes, dislikes, nil
}
