// /internal/db/post_navigation.go
package db

import (
	"context"
	"database/sql"
)

// PostNavigation represents previous / next post ids
// within the same category.
type PostNavigation struct {
	PrevID *int64
	NextID *int64
}

// GetPostNavigationByCategory returns the previous and next post
// relative to postID, restricted to the same category.
// Ordering is based on posts.created_at.
func GetPostNavigationByCategory(
	ctx context.Context,
	db *sql.DB,
	postID int64,
	categoryID int64,
) (*PostNavigation, error) {
	if viewer, ok := SocialViewer(ctx); ok {
		return socialNavigation(ctx, db, viewer, postID, categoryID, 0, false)
	}
	var nav PostNavigation

	// ------------------------------------------------------------
	// Previous post (same category, older than current)
	// ------------------------------------------------------------
	prevQuery := `
		SELECT p.id
		FROM posts p
		INNER JOIN post_categories pc ON pc.post_id = p.id
		WHERE pc.category_id = $1
		  AND p.created_at < (
			  SELECT created_at FROM posts WHERE id = $2
		  )
		ORDER BY p.created_at DESC
		LIMIT 1
	`

	var prevID int64
	err := db.QueryRowContext(ctx, prevQuery, categoryID, postID).Scan(&prevID)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err == nil {
		nav.PrevID = &prevID
	}

	// ------------------------------------------------------------
	// Next post (same category, newer than current)
	// ------------------------------------------------------------
	nextQuery := `
		SELECT p.id
		FROM posts p
		INNER JOIN post_categories pc ON pc.post_id = p.id
		WHERE pc.category_id = $1
		  AND p.created_at > (
			  SELECT created_at FROM posts WHERE id = $2
		  )
		ORDER BY p.created_at ASC
		LIMIT 1
	`

	var nextID int64
	err = db.QueryRowContext(ctx, nextQuery, categoryID, postID).Scan(&nextID)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err == nil {
		nav.NextID = &nextID
	}

	return &nav, nil
}

// SocialPostNavigation resolves optional category, group and Following filters.
// The source post must itself be readable, published and inside every filter.
// A group scope requires current membership; without one, neighbours come from
// the viewer's home scope (readable personal posts plus member groups' posts).
func SocialPostNavigation(ctx context.Context, db *sql.DB, viewer, postID, categoryID, groupID int64, following bool) (*PostNavigation, error) {
	return socialNavigation(ctx, db, viewer, postID, categoryID, groupID, following)
}
