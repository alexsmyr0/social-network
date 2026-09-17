// Internal/db/post_drafts.go
package db

import (
	"context"
	"database/sql"
	"time"
)

type Draft struct {
	ID          int64   `json:"id"`
	Title       string  `json:"title"`
	ImageURL    *string `json:"image_url"`
	Body        string  `json:"body"`
	UpdatedAt   string  `json:"updated_at"`
	CategoryIDs []int64 `json:"category_ids"`
}

func DraftCreate(
	ctx context.Context,
	db *sql.DB,
	userID int64,
	title, body string,
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

	//Insert new draft post
	res, err := tx.ExecContext(ctx, `
		INSERT INTO posts (author_id, title, body, status, image_url)
		VALUES (?, ?, ?, 'draft', ?)
	`, userID, title, body, imageURL)
	if err != nil {
		return 0, err
	}

	draftID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}

	//insert category links
	for _, cid := range categoryIDs {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO post_categories (post_id, category_id)
			VALUES (?, ?)
		`, draftID, cid)
		if err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return draftID, nil
}

func DraftUpdate(
	ctx context.Context,
	db *sql.DB,
	userID, draftID int64,
	title, body string,
	categoryIDs []int64,
	imageURL *string,
) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `
		UPDATE posts
		SET title = ?, body = ?, image_url = ?, updated_at = datetime('now')
		WHERE id = ? AND author_id = ? AND status = 'draft'
	`, title, body, imageURL, draftID, userID)
	if err != nil {
		return err
	}

	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		//Not found, not owned by user, or not a draft anymore
		return sql.ErrNoRows
	}

	//Replace category links
	_, err = tx.ExecContext(ctx, `
		DELETE FROM post_categories
		WHERE post_id = ?
	`, draftID)
	if err != nil {
		return err
	}

	for _, cid := range categoryIDs {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO post_categories (post_id, category_id)
			VALUES (?, ?)
		`, draftID, cid)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func DraftGet(
	ctx context.Context,
	db *sql.DB,
	userID int64,
) (*Draft, error) {

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var d Draft
	err := db.QueryRowContext(ctx, `
		SELECT id, title, image_url, body, updated_at
		FROM posts
		WHERE author_id = ? AND status = 'draft'
		ORDER BY updated_at DESC
		LIMIT 1
	`, userID).Scan(&d.ID, &d.Title, &d.ImageURL, &d.Body, &d.UpdatedAt)

	if err != nil {
		return nil, err
	}

	// Fetch category ids
	rows, err := db.QueryContext(ctx, `
		SELECT category_id
		FROM post_categories
		WHERE post_id = ?
		ORDER BY category_id
	`, d.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int64
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		d.CategoryIDs = append(d.CategoryIDs, cid)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &d, nil
}

func DraftDelete(
	ctx context.Context,
	db *sql.DB,
	userID,
	draftID int64,
) error {

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	res, err := db.ExecContext(ctx, `
		DELETE FROM posts
		WHERE id = ? AND author_id = ? AND status = 'draft'
	`, draftID, userID)

	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func DraftGetImageURLByID(
	ctx context.Context,
	db *sql.DB,
	userID, draftID int64,
) (*string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var imageURL sql.NullString
	err := db.QueryRowContext(ctx, `
		SELECT image_url
		FROM posts
		WHERE id = ? AND author_id = ? AND status = 'draft'
	`, draftID, userID).Scan(&imageURL)
	if err != nil {
		return nil, err
	}
	if !imageURL.Valid {
		return nil, nil
	}
	value := imageURL.String
	return &value, nil
}
