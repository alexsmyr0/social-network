// internal/db/reactions.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

const reactionTimeout = 2 * time.Second

// ToggleReaction toggles like/dislike for posts or comments.
// Returns: newReaction (1, -1, or 0 when removed)
func ToggleReaction(
	ctx context.Context,
	db *sql.DB,
	userID,
	objectID int64,
	targetReaction int,
	targetType string,
) (int, error) {

	if targetReaction != 1 && targetReaction != -1 {
		return 0, fmt.Errorf("invalid target reaction: %d", targetReaction)
	}

	ctx, cancel := context.WithTimeout(ctx, reactionTimeout)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Find ownership (who gets notified)
	ownerID, err := getReactionTargetOwnerTx(ctx, tx, objectID, targetType)
	if err != nil {
		return 0, err
	}

	// Find existing reaction
	current, err := getReactionValueTx(ctx, tx, userID, objectID, targetType)
	if err != nil {
		return 0, err
	}

	// Apply
	newValue, err := applyReactionToggleTx(
		ctx,
		tx,
		userID,
		objectID,
		current,
		targetReaction,
		targetType,
	)
	if err != nil {
		return 0, err
	}

	// Do NOT send notification if reaction was removed (newValue = 0)
	var notifiedUserID int64
	if newValue != 0 {
		notifiedUserID, _ = handleReactionNotificationTx(
			ctx,
			tx,
			ownerID,
			userID,
			objectID,
			newValue,
			targetType,
		)
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}

	// Announce only once the insert is durable, so a rolled-back transaction
	// can never push a notification the recipient will not find.
	if notifiedUserID != 0 {
		fireNotificationHook(notifiedUserID)
	}

	return newValue, nil
}

/* =========================================================
   INTERNAL HELPERS (TX SAFE)
========================================================= */

func getReactionValueTx(
	ctx context.Context,
	tx *sql.Tx,
	userID,
	objectID int64,
	targetType string,
) (int, error) {

	var value int
	var err error

	switch targetType {

	case "post":
		err = tx.QueryRowContext(ctx,
			`SELECT value FROM reactions WHERE user_id = ? AND post_id = ?`,
			userID, objectID,
		).Scan(&value)

	case "comment":
		err = tx.QueryRowContext(ctx,
			`SELECT value FROM reactions WHERE user_id = ? AND comment_id = ?`,
			userID, objectID,
		).Scan(&value)

	default:
		return 0, fmt.Errorf("invalid target type: %s", targetType)
	}

	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("select reaction: %w", err)
	}

	return value, nil
}

func getReactionTargetOwnerTx(
	ctx context.Context,
	tx *sql.Tx,
	objectID int64,
	targetType string,
) (int64, error) {

	var ownerID int64

	switch targetType {

	case "post":
		err := tx.QueryRowContext(
			ctx,
			`SELECT author_id FROM posts WHERE id = ?`,
			objectID,
		).Scan(&ownerID)
		if err != nil {
			if err == sql.ErrNoRows {
				return 0, ErrNotFound
			}
			return 0, err
		}

	case "comment":
		err := tx.QueryRowContext(
			ctx,
			`SELECT user_id FROM comments WHERE id = ?`,
			objectID,
		).Scan(&ownerID)
		if err != nil {
			if err == sql.ErrNoRows {
				return 0, ErrNotFound
			}
			return 0, err
		}

	default:
		return 0, fmt.Errorf("invalid target type: %s", targetType)
	}

	return ownerID, nil
}

func applyReactionToggleTx(
	ctx context.Context,
	tx *sql.Tx,
	userID,
	objectID int64,
	current,
	targetReaction int,
	targetType string,
) (int, error) {

	var idColumn string
	var conflictTarget string

	switch targetType {
	case "post":
		idColumn = "post_id"
		conflictTarget = "ON CONFLICT(user_id, post_id) WHERE post_id IS NOT NULL"

	case "comment":
		idColumn = "comment_id"
		conflictTarget = "ON CONFLICT(user_id, comment_id) WHERE comment_id IS NOT NULL"

	default:
		return 0, fmt.Errorf("invalid target type: %s", targetType)
	}

	// If same reaction exists → remove it
	if current == targetReaction {
		query := fmt.Sprintf(`DELETE FROM reactions WHERE user_id = ? AND %s = ?`, idColumn)
		if _, err := tx.ExecContext(ctx, query, userID, objectID); err != nil {
			return 0, fmt.Errorf("delete reaction: %w", err)
		}
		return 0, nil
	}

	// INSERT or UPDATE
	query := fmt.Sprintf(`
		INSERT INTO reactions (user_id, %s, value, created_at)
		VALUES (?, ?, ?, strftime('%%Y-%%m-%%dT%%H:%%M:%%SZ','now'))
		%s
		DO UPDATE SET value = excluded.value, created_at = excluded.created_at
	`, idColumn, conflictTarget)

	if _, err := tx.ExecContext(ctx, query, userID, objectID, targetReaction); err != nil {
		return 0, fmt.Errorf("upsert reaction: %w", err)
	}

	return targetReaction, nil
}
