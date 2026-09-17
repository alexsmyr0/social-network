// Internal/db/posts_helpers.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
)

const ReactionLike = 1
const ReactionDislike = -1

/*-------------------------------
  COUNT POSTS (PUBLISHED ONLY)
-------------------------------*/

func countPosts(ctx context.Context, db *sql.DB) (int, error) {
	var total int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM posts
		WHERE status = 'published'
	`).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

/*-------------------------------
  FETCH POSTS (PUBLISHED ONLY)
-------------------------------*/

func fetchPosts(
	ctx context.Context,
	db *sql.DB,
	p ListPostsParams,
) ([]Post, error) {

	offset := (p.Page - 1) * p.PerPage

	rows, err := db.QueryContext(ctx, `
		SELECT
			p.id,
			p.author_id,
			u.username,
			p.title,
			p.image_url,
			p.body,
			p.created_at,
			p.updated_at
		FROM posts p
		JOIN users u ON u.id = p.author_id
		WHERE p.status = 'published'
		ORDER BY p.created_at DESC
		LIMIT ? OFFSET ?
	`, p.PerPage, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	posts := make([]Post, 0)

	for rows.Next() {
		var post Post
		var imageURL sql.NullString
		if err := rows.Scan(
			&post.ID,
			&post.AuthorID,
			&post.Author,
			&post.Title,
			&imageURL,
			&post.Body,
			&post.CreatedAt,
			&post.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if imageURL.Valid {
			post.ImageURL = &imageURL.String
		}
		posts = append(posts, post)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return posts, nil
}

/*------------------------------------
  ATTACH CATEGORIES (ID + NAME ONLY)
------------------------------------*/

func attachPostCategories(ctx context.Context, db *sql.DB, posts []Post) error {
	for i := range posts {
		categories, err := getCategoriesByPostID(ctx, db, posts[i].ID)
		if err != nil {
			return err
		}
		posts[i].Categories = categories
	}
	return nil
}

func getCategoriesByPostID(
	ctx context.Context,
	db *sql.DB,
	postID int64,
) ([]PostCategory, error) {

	rows, err := db.QueryContext(ctx, `
		SELECT c.id, c.name
		FROM categories c
		JOIN post_categories pc ON pc.category_id = c.id
		WHERE pc.post_id = ?
		ORDER BY c.name ASC
	`, postID)
	if err != nil {
		return nil, fmt.Errorf("load post categories: %w", err)
	}
	defer rows.Close()

	var categories []PostCategory
	for rows.Next() {
		var c PostCategory
		if err := rows.Scan(&c.ID, &c.Name); err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return categories, nil
}

/*-------------------
  ATTACH REACTIONS
-------------------*/

func attachPostReactions(ctx context.Context, db *sql.DB, posts []Post, userID int64) error {
	if len(posts) == 0 {
		return nil
	}

	// Always attach total counts
	for i := range posts {
		likes, dislikes, err := CountReactionsForPost(ctx, db, posts[i].ID)
		if err != nil {
			return err
		}
		posts[i].Likes = likes
		posts[i].Dislikes = dislikes
		posts[i].MyReaction = 0
	}

	if userID <= 0 {
		return nil
	}

	// Collect post IDs
	ids := make([]any, 0, len(posts))
	placeholders := make([]string, 0, len(posts))

	for _, p := range posts {
		ids = append(ids, p.ID)
		placeholders = append(placeholders, "?")
	}

	query := fmt.Sprintf(`
		SELECT post_id, value
		FROM reactions
		WHERE user_id = ?
		AND post_id IN (%s)
		AND post_id IS NOT NULL
	`, strings.Join(placeholders, ","))

	args := append([]any{userID}, ids...)

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	reactionMap := make(map[int64]int)

	for rows.Next() {
		var postID int64
		var val int
		if err := rows.Scan(&postID, &val); err != nil {
			return err
		}
		reactionMap[postID] = val
	}

	for i := range posts {
		if val, ok := reactionMap[posts[i].ID]; ok {
			posts[i].MyReaction = val
		}
	}

	return nil
}

/*---------------------
  FETCH REACTED POSTS
---------------------*/

// fetchPostsByReaction fetches according to reaction selected,
// like -> p.Reaction = 1, dislike -> p.Reaction = -1
func fetchPostsByReaction(
	ctx context.Context,
	db *sql.DB,
	p ListPostsByUserReactionParams,
) ([]Post, error) {
	offset := (p.Page - 1) * p.PerPage

	rows, err := db.QueryContext(ctx, `
		SELECT
			p.id,
			p.author_id,
			u.username,
			p.title,
			p.image_url,
			p.body,
			p.created_at,
			p.updated_at
		FROM posts p
		JOIN users u ON u.id = p.author_id
		JOIN reactions r ON r.post_id = p.id
		WHERE r.user_id = ?
		AND r.value = ?
		ORDER BY r.created_at ASC
		LIMIT ? OFFSET ?
	`, p.UserID, p.Reaction, p.PerPage, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	posts := make([]Post, 0)
	for rows.Next() {
		var post Post
		var imageURL sql.NullString
		if err := rows.Scan(
			&post.ID,
			&post.AuthorID,
			&post.Author,
			&post.Title,
			&imageURL,
			&post.Body,
			&post.CreatedAt,
			&post.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if imageURL.Valid {
			post.ImageURL = &imageURL.String
		}
		posts = append(posts, post)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return posts, nil
}

func GetUserReactionForPost(ctx context.Context, db *sql.DB, userID, postID int64) (int, error) {
	var val int
	err := db.QueryRowContext(ctx, `
		SELECT value FROM reactions
		WHERE user_id = ?
		AND post_id = ?
		AND post_id IS NOT NULL
	`, userID, postID).Scan(&val)

	if err == sql.ErrNoRows {
		return 0, nil
	}
	return val, err
}

/*-------------------------
  IMAGE URL HELPERS
-------------------------*/

func NormalizeUploadedImageURL(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false
	}

	if cut := strings.IndexAny(value, "?#"); cut >= 0 {
		value = value[:cut]
	}

	const prefix = "/static/uploads/"
	if !strings.HasPrefix(value, prefix) {
		return "", false
	}

	filename := strings.TrimPrefix(value, prefix)
	if filename == "" {
		return "", false
	}

	if filename == "." || filename == ".." {
		return "", false
	}

	if strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		return "", false
	}

	if filepath.Base(filename) != filename {
		return "", false
	}

	return prefix + filename, true
}

func GetUploadedImageDiskPath(imageURL string) (string, bool) {
	normalizedURL, ok := NormalizeUploadedImageURL(imageURL)
	if !ok {
		return "", false
	}
	filename := strings.TrimPrefix(normalizedURL, "/static/uploads/")
	return filepath.Join("web", "static", "uploads", filename), true
}
