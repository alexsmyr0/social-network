// internal/db/categories.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

/*------------
   MODELS
------------*/

// Category represents a forum category.
type Category struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

// CategoryWithPosts represents a subforum view.
type CategoryWithPosts struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Posts []Post `json:"posts"`
}

const categoryTimeout = 2 * time.Second

/*-----------------
  LIST CATEGORIES
-----------------*/

func ListCategories(ctx context.Context, db *sql.DB) ([]Category, error) {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT id, name, created_at
		FROM categories
		ORDER BY name ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}
	defer rows.Close()

	var categories []Category

	for rows.Next() {
		var c Category
		if err := rows.Scan(
			&c.ID,
			&c.Name,
			&c.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan category: %w", err)
		}
		categories = append(categories, c)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate categories: %w", err)
	}

	return categories, nil
}

/*----------------
   GET CATEGORY
----------------*/

func GetCategory(ctx context.Context, db *sql.DB, id int64) (Category, error) {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	var category Category

	err := db.QueryRowContext(ctx, `
		SELECT id, name, created_at
		FROM categories
		WHERE id = ?
	`, id).Scan(
		&category.ID,
		&category.Name,
		&category.CreatedAt,
	)

	if err != nil {
		return Category{}, err // sql.ErrNoRows handled by caller
	}

	return category, nil
}

/*------------------
  CREATE CATEGORY
------------------*/

func CreateCategory(ctx context.Context, db *sql.DB, name string) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	res, err := db.ExecContext(ctx, `
		INSERT INTO categories (name, created_at)
		VALUES (?, datetime('now'))
	`, name)
	if err != nil {
		return 0, fmt.Errorf("create category: %w", err)
	}

	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("last insert id: %w", err)
	}

	return id, nil
}

/*------------------
  UPDATE CATEGORY
------------------*/

func UpdateCategoryName(ctx context.Context, db *sql.DB, id int64, name string) error {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	res, err := db.ExecContext(ctx, `
		UPDATE categories
		SET name = ?
		WHERE id = ?
	`, name, id)
	if err != nil {
		return fmt.Errorf("update category: %w", err)
	}

	rows, err := res.RowsAffected()
	if err == nil && rows == 0 {
		return sql.ErrNoRows
	}

	return nil
}

/*------------------
  DELETE CATEGORY
------------------*/

func DeleteCategory(ctx context.Context, db *sql.DB, id int64) error {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	res, err := db.ExecContext(ctx, `
		DELETE FROM categories
		WHERE id = ?
	`, id)
	if err != nil {
		return fmt.Errorf("delete category: %w", err)
	}

	rows, err := res.RowsAffected()
	if err == nil && rows == 0 {
		return sql.ErrNoRows
	}

	return nil
}

/*--------------------------------------------
  LIST CATEGORIES WITH POSTS (SUBFORUM VIEW)
--------------------------------------------*/

func ListCategoriesWithPosts(ctx context.Context, db *sql.DB, userID int64) ([]CategoryWithPosts, error) {
	ctx, cancel := context.WithTimeout(ctx, categoryTimeout)
	defer cancel()

	categories, err := ListCategories(ctx, db)
	if err != nil {
		return nil, err
	}

	result := make([]CategoryWithPosts, 0, len(categories))
	index := make(map[int64]*CategoryWithPosts)

	for _, c := range categories {
		cp := CategoryWithPosts{
			ID:    c.ID,
			Name:  c.Name,
			Posts: []Post{},
		}
		result = append(result, cp)
		index[c.ID] = &result[len(result)-1]
	}

	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT
			c.id,
			p.id, p.author_id, p.title, p.body, p.created_at, p.updated_at
		FROM categories c
		JOIN post_categories pc ON pc.category_id = c.id
		JOIN posts p ON p.id = pc.post_id
		ORDER BY c.name ASC, p.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var (
			categoryID int64
			post       Post
		)

		if err := rows.Scan(
			&categoryID,
			&post.ID,
			&post.AuthorID,
			&post.Title,
			&post.Body,
			&post.CreatedAt,
			&post.UpdatedAt,
		); err != nil {
			return nil, err
		}

		index[categoryID].Posts = append(index[categoryID].Posts, post)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range result {
		if err := attachPostCategories(ctx, db, result[i].Posts); err != nil {
			return nil, err
		}
		if err := attachPostReactions(ctx, db, result[i].Posts, userID); err != nil {
			return nil, err
		}
	}

	return result, nil
}
