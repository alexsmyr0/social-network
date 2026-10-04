package db

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
)

func socialCreatePost(ctx context.Context, database *sql.DB, viewer int64, title, body, status string, categories []int64, image *string) (int64, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer).Scan(&active); err != nil {
		return 0, err
	}
	if !active {
		return 0, sql.ErrNoRows
	}
	if err := validateCategoriesTx(ctx, tx, categories); err != nil {
		return 0, err
	}
	if err := claimMediaTx(ctx, tx, viewer, "post", 0, image, 0); err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO posts(author_id,title,body,status,image_url) VALUES(?,?,?,?,?)`, viewer, title, body, status, image)
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err := insertPostCategoriesTx(ctx, tx, id, categories); err != nil {
		return 0, err
	}
	if err := finishMediaClaimTx(ctx, tx, image); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	fireSocialInvalidation()
	return id, nil
}
func socialUpdatePost(ctx context.Context, database *sql.DB, viewer, id int64, in UpdatePostInput, draftOnly bool) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requirePostAccess(ctx, tx, viewer, id, true); err != nil {
		return err
	}
	if draftOnly {
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM posts WHERE id=?`, id).Scan(&status); err != nil {
			return err
		}
		if status != "draft" {
			return sql.ErrNoRows
		}
	}
	if in.HasCategoryUpdate {
		if err := validateCategoriesTx(ctx, tx, in.CategoryIDs); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidPostCategoryUpdate, err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM post_categories WHERE post_id=?`, id); err != nil {
			return err
		}
		if err := insertPostCategoriesTx(ctx, tx, id, in.CategoryIDs); err != nil {
			return err
		}
	}
	sets := []string{}
	args := []any{}
	if in.Title != nil {
		sets = append(sets, "title=?")
		args = append(args, *in.Title)
	}
	if in.Body != nil {
		sets = append(sets, "body=?")
		args = append(args, *in.Body)
	}
	if in.Status != nil {
		sets = append(sets, "status=?")
		args = append(args, *in.Status)
	}
	if in.HasImageUpdate {
		if err := claimMediaTx(ctx, tx, viewer, "post", id, in.ImageURL, 0); err != nil {
			return err
		}
		sets = append(sets, "image_url=?")
		args = append(args, in.ImageURL)
	}
	sets = append(sets, "updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')")
	args = append(args, id)
	if _, err := tx.ExecContext(ctx, `UPDATE posts SET `+strings.Join(sets, ",")+` WHERE id=?`, args...); err != nil {
		return err
	}
	if in.HasImageUpdate {
		if err := finishMediaClaimTx(ctx, tx, in.ImageURL); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation()
	if err := CleanupMedia(ctx, database, false); err != nil {
		log.Printf("media cleanup deferred to restart: %v", err)
	}
	return nil
}
func socialDeleteContent(ctx context.Context, database *sql.DB, viewer, id int64, kind string, draftOnly bool) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	table := "posts"
	if kind == "comment" {
		table = "comments"
		if _, err := requireCommentAccess(ctx, tx, viewer, id, true); err != nil {
			return err
		}
	} else {
		if err := requirePostAccess(ctx, tx, viewer, id, true); err != nil {
			return err
		}
		if draftOnly {
			var status string
			if err := tx.QueryRowContext(ctx, `SELECT status FROM posts WHERE id=?`, id).Scan(&status); err != nil {
				return err
			}
			if status != "draft" {
				return sql.ErrNoRows
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE id=?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation()
	if err := CleanupMedia(ctx, database, false); err != nil {
		log.Printf("media cleanup deferred to restart: %v", err)
	}
	return nil
}
func socialUpdateComment(ctx context.Context, database *sql.DB, viewer, id int64, in UpdateCommentInput) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := requireCommentAccess(ctx, tx, viewer, id, true); err != nil {
		return err
	}
	sets := []string{"updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')"}
	args := []any{}
	if in.Body != nil {
		sets = append(sets, "body=?")
		args = append(args, *in.Body)
	}
	if in.HasImageUpdate {
		if err := claimMediaTx(ctx, tx, viewer, "comment", id, in.ImageURL, 0); err != nil {
			return err
		}
		sets = append(sets, "image_url=?")
		args = append(args, in.ImageURL)
	}
	args = append(args, id)
	if _, err := tx.ExecContext(ctx, `UPDATE comments SET `+strings.Join(sets, ",")+` WHERE id=?`, args...); err != nil {
		return err
	}
	if in.HasImageUpdate {
		if err := finishMediaClaimTx(ctx, tx, in.ImageURL); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation()
	if err := CleanupMedia(ctx, database, false); err != nil {
		log.Printf("media cleanup deferred to restart: %v", err)
	}
	return nil
}

// ContentRequestAccess checks before parsing/uploads. Mutations repeat these
// checks under their write transaction; this early guard is never their authority.
func ContentRequestAccess(ctx context.Context, database *sql.DB, viewer, id int64, kind string, owner bool) error {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if kind == "comment" {
		_, err = requireCommentAccess(ctx, tx, viewer, id, owner)
	} else {
		err = requirePostAccess(ctx, tx, viewer, id, owner)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
