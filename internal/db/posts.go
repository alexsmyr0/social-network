// internal/db/posts.go
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrInvalidPostCategoryUpdate = errors.New("invalid post category update")

/*-------
  MODEL
-------*/

type Post struct {
	ID         int64          `json:"id"`
	AuthorID   int64          `json:"author_id"`
	Author     string         `json:"author"`
	Title      string         `json:"title"`
	ImageURL   *string        `json:"image_url"`
	Body       string         `json:"body"`
	CreatedAt  string         `json:"created_at"`
	UpdatedAt  string         `json:"updated_at,omitempty"`
	Status     string         `json:"status"`
	Likes      int            `json:"likes"`
	Dislikes   int            `json:"dislikes"`
	MyReaction int            `json:"my_reaction"`
	Categories []PostCategory `json:"categories"`
}

type PostCategory struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

/*------------
  LIST POSTS
------------*/

type ListPostsParams struct {
	Page    int
	PerPage int
}

type ListPostsResult struct {
	Posts []Post
	Total int
}

func ListPosts(ctx context.Context, db *sql.DB, p ListPostsParams, userID int64) (ListPostsResult, error) {
	p.Page, p.PerPage = normalizePagination(p.Page, p.PerPage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	total, err := countPosts(ctx, db)
	if err != nil {
		return ListPostsResult{}, err
	}

	posts, err := fetchPosts(ctx, db, p)
	if err != nil {
		return ListPostsResult{}, err
	}

	if err := attachPostCategories(ctx, db, posts); err != nil {
		return ListPostsResult{}, err
	}
	if err := attachPostReactions(ctx, db, posts, userID); err != nil {
		return ListPostsResult{}, err
	}

	return ListPostsResult{Posts: posts, Total: total}, nil
}

/*----------
  GET POST
----------*/

func GetPost(ctx context.Context, db *sql.DB, id int64) (Post, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var post Post
	var imageURL sql.NullString

	err := db.QueryRowContext(ctx, `
		SELECT
			p.id,
			p.author_id,
			u.username,
			p.title,
			p.image_url,
			p.body,
			p.status,
			p.created_at,
			p.updated_at
		FROM posts p
		JOIN users u ON u.id = p.author_id
		WHERE p.id = ?
	`, id).Scan(
		&post.ID,
		&post.AuthorID,
		&post.Author,
		&post.Title,
		&imageURL,
		&post.Body,
		&post.Status,
		&post.CreatedAt,
		&post.UpdatedAt,
	)
	if err != nil {
		return Post{}, err
	}
	if imageURL.Valid {
		post.ImageURL = &imageURL.String
	}

	// categories (ID + name)
	categories, err := getCategoriesByPostID(ctx, db, id)
	if err != nil {
		return Post{}, err
	}
	post.Categories = categories

	likes, dislikes, err := CountReactionsForPost(ctx, db, id)
	if err != nil {
		return Post{}, err
	}
	post.Likes = likes
	post.Dislikes = dislikes

	return post, nil
}

func GetPostAuthorID(ctx context.Context, db *sql.DB, postID int64) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var authorID int64
	err := db.QueryRowContext(ctx, `SELECT author_id FROM posts WHERE id = ?`, postID).Scan(&authorID)
	if err != nil {
		return 0, err // sql.ErrNoRows propagates
	}
	return authorID, nil
}

/*------------------------------
  CREATE POST (TRANSACTIONAL)
------------------------------*/

func CreatePostWithCategories(
	ctx context.Context,
	db *sql.DB,
	authorID int64,
	title, body, status string,
	categoryIDs []int64,
	imageURL *string,
) (int64, error) {

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	if err := validateCategoriesTx(ctx, tx, categoryIDs); err != nil {
		return 0, err
	}

	res, err := tx.ExecContext(ctx, `
		INSERT INTO posts (author_id, title, body, status, image_url)
		VALUES (?, ?, ?, ?, ?)
		`, authorID, title, body, status, imageURL)

	if err != nil {
		return 0, err
	}

	postID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	if err := insertPostCategoriesTx(ctx, tx, postID, categoryIDs); err != nil {
		return 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	return postID, nil
}

/*-------------
  UPDATE POST
-------------*/

type UpdatePostInput struct {
	Title             *string
	Body              *string
	ImageURL          *string
	HasImageUpdate    bool
	CategoryIDs       []int64
	HasCategoryUpdate bool
}

func UpdatePostContent(ctx context.Context, db *sql.DB, id int64, in UpdatePostInput) error {
	if in.Title == nil && in.Body == nil && !in.HasImageUpdate && !in.HasCategoryUpdate {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if in.HasCategoryUpdate {
		if err := validateCategoriesTx(ctx, tx, in.CategoryIDs); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidPostCategoryUpdate, err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM post_categories WHERE post_id = ?`, id); err != nil {
			return err
		}
		if err := insertPostCategoriesTx(ctx, tx, id, in.CategoryIDs); err != nil {
			return err
		}
	}

	set := []string{}
	args := []any{}

	if in.Title != nil {
		set = append(set, "title = ?")
		args = append(args, *in.Title)
	}

	if in.Body != nil {
		set = append(set, "body = ?")
		args = append(args, *in.Body)
	}

	if in.HasImageUpdate {
		set = append(set, "image_url = ?")
		args = append(args, in.ImageURL)
	}

	if len(set) == 0 && !in.HasCategoryUpdate {
		return nil
	}

	set = append(set, "updated_at = datetime('now')")
	args = append(args, id)

	query := `UPDATE posts SET ` + strings.Join(set, ", ") + ` WHERE id = ?`
	res, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}

	rows, _ := res.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	return nil
}

func UpdatePostStatus(ctx context.Context, db *sql.DB, postID, authorID int64, status string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	res, err := db.ExecContext(ctx, `
        UPDATE posts
        SET status = ?, updated_at = datetime('now')
        WHERE id = ? AND author_id = ?
    `, status, postID, authorID)
	if err != nil {
		return err
	}

	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}

	if affected == 0 {
		return sql.ErrNoRows
	}

	return nil
}

/*-----------------------------
  DELETE POST (TRANSACTIONAL)
-----------------------------*/

func DeletePost(ctx context.Context, db *sql.DB, id int64) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM post_categories WHERE post_id = ?`, id,
	); err != nil {
		return err
	}

	res, err := tx.ExecContext(ctx,
		`DELETE FROM posts WHERE id = ?`, id,
	)
	if err != nil {
		return err
	}

	rows, _ := res.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}

	return tx.Commit()
}

/*-------------------------
  LIST POSTS BY CATEGORY
-------------------------*/

type ListPostsByCategoryParams struct {
	CategoryID int64
	Page       int
	PerPage    int
}

type ListPostsByCategoryResult struct {
	Posts []Post
	Total int
}

func ListPostsByCategory(
	ctx context.Context,
	db *sql.DB,
	p ListPostsByCategoryParams,
	userID int64,
) (ListPostsByCategoryResult, error) {

	p.Page, p.PerPage = normalizePagination(p.Page, p.PerPage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var total int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT post_id)
		FROM post_categories
		WHERE category_id = ?
	`, p.CategoryID).Scan(&total); err != nil {
		return ListPostsByCategoryResult{}, err
	}

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
		JOIN post_categories pc ON pc.post_id = p.id
		WHERE pc.category_id = ?
		GROUP BY p.id
		ORDER BY p.created_at DESC
		LIMIT ? OFFSET ?
	`, p.CategoryID, p.PerPage, offset)
	if err != nil {
		return ListPostsByCategoryResult{}, err
	}
	defer rows.Close()

	var posts []Post
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
			return ListPostsByCategoryResult{}, err
		}
		if imageURL.Valid {
			post.ImageURL = &imageURL.String
		}
		posts = append(posts, post)
	}

	if err := attachPostCategories(ctx, db, posts); err != nil {
		return ListPostsByCategoryResult{}, err
	}
	if err := attachPostReactions(ctx, db, posts, userID); err != nil {
		return ListPostsByCategoryResult{}, err
	}

	return ListPostsByCategoryResult{Posts: posts, Total: total}, nil
}

/*---------------------------------
  LIST POSTS BY AUTHOR (MY POSTS)
---------------------------------*/

type ListPostsByAuthorParams struct {
	AuthorID int64
	Page     int
	PerPage  int
	Status   *string // nil means no filter
}

type ListPostsByAuthorResult struct {
	Posts []Post
	Total int
}

func ListPostsByAuthor(
	ctx context.Context,
	db *sql.DB,
	p ListPostsByAuthorParams,
	userID int64,
) (ListPostsByAuthorResult, error) {

	p.Page, p.PerPage = normalizePagination(p.Page, p.PerPage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	// Build WHERE
	where := "WHERE p.author_id = ?"
	args := []any{p.AuthorID}

	if p.Status != nil {
		where += " AND p.status = ?"
		args = append(args, *p.Status)
	}

	var total int
	if err := db.QueryRowContext(ctx, `
        SELECT COUNT(*)
        FROM posts p
    `+where, args...).Scan(&total); err != nil {
		return ListPostsByAuthorResult{}, err
	}

	offset := (p.Page - 1) * p.PerPage
	selectArgs := append(append([]any{}, args...), p.PerPage, offset)

	rows, err := db.QueryContext(ctx, `
        SELECT
            p.id,
            p.author_id,
            u.username,
            p.title,
            p.image_url,
            p.body,
            p.created_at,
            p.updated_at,
            p.status
        FROM posts p
        JOIN users u ON u.id = p.author_id
        `+where+`
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    `, selectArgs...)
	if err != nil {
		return ListPostsByAuthorResult{}, err
	}
	defer rows.Close()

	var posts []Post
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
			&post.Status,
		); err != nil {
			return ListPostsByAuthorResult{}, err
		}

		if imageURL.Valid {
			post.ImageURL = &imageURL.String
		}

		posts = append(posts, post)
	}

	if err := attachPostCategories(ctx, db, posts); err != nil {
		return ListPostsByAuthorResult{}, err
	}

	if err := attachPostReactions(ctx, db, posts, userID); err != nil {
		return ListPostsByAuthorResult{}, err
	}

	return ListPostsByAuthorResult{Posts: posts, Total: total}, nil
}

/*---------------------------
  LIST POSTS LIKED BY USER
---------------------------*/

type ListPostsByUserReactionParams struct {
	UserID   int64
	Page     int
	PerPage  int
	Reaction int
}

type ListPostsByUserReactionResult struct {
	Posts []Post
	Total int
}

func ListPostsByUserReaction(
	ctx context.Context,
	db *sql.DB,
	p ListPostsByUserReactionParams,
	userID int64,
) (ListPostsByUserReactionResult, error) {

	p.Page, p.PerPage = normalizePagination(p.Page, p.PerPage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	total, err := countPostsByUserReaction(ctx, db, p.UserID, p.Reaction)
	if err != nil {
		return ListPostsByUserReactionResult{}, err
	}

	posts, err := fetchPostsByReaction(ctx, db, p)
	if err != nil {
		return ListPostsByUserReactionResult{}, err
	}

	if err := attachPostCategories(ctx, db, posts); err != nil {
		return ListPostsByUserReactionResult{}, err
	}

	if err := attachPostReactions(ctx, db, posts, userID); err != nil {
		return ListPostsByUserReactionResult{}, err
	}

	return ListPostsByUserReactionResult{Posts: posts, Total: total}, nil
}

func countPostsByUserReaction(
	ctx context.Context,
	db *sql.DB,
	userID int64,
	reaction int,
) (int, error) {
	if reaction != ReactionLike && reaction != ReactionDislike {
		return 0, fmt.Errorf("invalid reaction: %d", reaction)
	}

	var total int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT r.post_id)
		FROM reactions r
		WHERE r.user_id = ?
		  AND r.post_id IS NOT NULL
		  AND r.value = ?
	`, userID, reaction).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

/*--------------------
  HELPERS (TX SAFE)
--------------------*/

func validateCategoriesTx(ctx context.Context, tx *sql.Tx, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}

	// de-duplicate ids
	unique := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		if id > 0 {
			unique[id] = struct{}{}
		}
	}

	if len(unique) == 0 {
		return fmt.Errorf("no valid categories provided")
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(unique)), ",")
	query := `SELECT COUNT(*) FROM categories WHERE id IN (` + placeholders + `)`

	args := make([]any, 0, len(unique))
	for id := range unique {
		args = append(args, id)
	}

	var count int
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return err
	}

	if count != len(unique) {
		return fmt.Errorf("one or more categories do not exist")
	}

	return nil
}

func insertPostCategoriesTx(ctx context.Context, tx *sql.Tx, postID int64, ids []int64) error {
	seen := make(map[int64]struct{}, len(ids))

	for _, cid := range ids {
		if cid <= 0 {
			continue
		}
		if _, ok := seen[cid]; ok {
			continue
		}
		seen[cid] = struct{}{}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO post_categories (post_id, category_id) VALUES (?, ?)`,
			postID, cid,
		); err != nil {
			return err
		}
	}

	return nil
}

/*-----------------
  IMAGE QUERIES
-----------------*/

func GetPostRelatedImageURLs(ctx context.Context, db *sql.DB, postID int64) ([]string, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT image_url
		FROM posts
		WHERE id = ? AND image_url IS NOT NULL
		UNION
		SELECT image_url
		FROM comments
		WHERE post_id = ? AND image_url IS NOT NULL
	`, postID, postID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		urls = append(urls, raw)
	}
	return urls, rows.Err()
}

func GetImageUsageCount(ctx context.Context, db *sql.DB, imageURL string) (int, error) {
	var count int
	err := db.QueryRowContext(ctx, `
		SELECT
			(SELECT COUNT(1) FROM posts WHERE image_url = ?) +
			(SELECT COUNT(1) FROM comments WHERE image_url = ?)
	`, imageURL, imageURL).Scan(&count)
	return count, err
}
