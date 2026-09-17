// Internal/db/posts_public_helpers.go
package db

import (
	"context"
	"database/sql"
	"fmt"
)

/*--------------------------------
  PUBLIC POSTS HELPERS (PRIVATE)
--------------------------------*/
// These helpers are intentionally unexported.
// They support ListPublicPosts orchestration only.

// Load category names for a single post
func loadCategoriesForPost(
	ctx context.Context,
	db *sql.DB,
	postID int64,
) ([]string, error) {

	rows, err := db.QueryContext(ctx, sqlSelectCategories, postID)
	if err != nil {
		return nil, fmt.Errorf("select categories: %w", err)
	}
	defer rows.Close()

	var categoryNames []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan category: %w", err)
		}
		categoryNames = append(categoryNames, name)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows categories: %w", err)
	}

	return categoryNames, nil
}
