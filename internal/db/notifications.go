// /internal/db/notifications.go
package db

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

const notificationTimeout = 2 * time.Second

/* =========================================================
   DELIVERY HOOK
========================================================= */

// notificationHook is invoked with the recipient's user id whenever a
// notification row is successfully created. It exists so the SPA can be told
// "you have something new" over the WebSocket that is already open, instead of
// polling GET /notifications on a timer.
//
// It is a package-level hook rather than a parameter because internal/db is a
// set of free functions and threading a transport through CreateComment and
// ToggleReaction would push knowledge of the hub down into the persistence
// layer. cmd/backend wires it to ws.Hub.NotifyNotification at startup; it stays
// nil in tests, where the call is a no-op.
var (
	notificationHookMu sync.RWMutex
	notificationHook   func(recipientID int64)
)

// SetNotificationHook registers the delivery hook. Pass nil to clear it.
func SetNotificationHook(hook func(recipientID int64)) {
	notificationHookMu.Lock()
	defer notificationHookMu.Unlock()
	notificationHook = hook
}

// fireNotificationHook notifies the registered hook, if any. Callers must only
// invoke it once the write is durable — after COMMIT for transactional paths —
// so a rolled-back insert can never announce itself.
func fireNotificationHook(recipientID int64) {
	notificationHookMu.RLock()
	hook := notificationHook
	notificationHookMu.RUnlock()

	if hook != nil {
		hook(recipientID)
	}
}

type Notification struct {
	ID             int64  `json:"id"`
	RecipientID    int64  `json:"recipient_id"`
	ActorID        int64  `json:"actor_id"`
	ActorUsername  string `json:"actor_username"`
	Type           string `json:"type"`
	PostID         *int64 `json:"post_id,omitempty"`
	CommentID      *int64 `json:"comment_id,omitempty"`
	CreatedAt      string `json:"created_at"`
	IsRead         bool   `json:"is_read"`
	PostTitle      string `json:"post_title,omitempty"`
	CommentExcerpt string `json:"comment_excerpt,omitempty"`
}

/* =========================================================
   MAIN INSERT (POSTS & COMMENTS – NOT REACTIONS)
========================================================= */

func InsertNotification(
	ctx context.Context,
	db *sql.DB,
	recipientID int64,
	actorID int64,
	notificationType string,
	postID *int64,
	commentID *int64,
) error {

	if recipientID == actorID {
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, notificationTimeout)
	defer cancel()

	var finalCommentID *int64

	// IMPORTANT: For post comments, commentID must be NULL to avoid unique index conflicts
	// The unique index ux_notification_comment only applies when comment_id IS NOT NULL
	if notificationType == "comment" {
		finalCommentID = nil
	} else {
		finalCommentID = commentID
	}

	query := `
		INSERT INTO notifications
			(recipient_id, actor_id, type, post_id, comment_id, created_at, is_read)
		VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 0)
		ON CONFLICT DO NOTHING
	`

	result, err := db.ExecContext(ctx, query,
		recipientID,
		actorID,
		notificationType,
		postID,
		finalCommentID,
	)
	if err != nil {
		return err
	}

	// ON CONFLICT DO NOTHING means a duplicate is a no-op, not a new
	// notification — only announce a row that was actually inserted.
	if affected, affErr := result.RowsAffected(); affErr == nil && affected > 0 {
		fireNotificationHook(recipientID)
	}

	return nil
}

/* =========================================================
   REACTION NOTIFICATIONS (LIKE/DISLIKE)
   — ALWAYS INSERT NEW, NEVER CONFLICT
========================================================= */

// handleReactionNotificationTx inserts the like/dislike notification inside the
// caller's transaction. It returns the recipient id when a row was actually
// created and 0 otherwise, so the caller can announce the notification AFTER
// its COMMIT — announcing from inside the transaction could tell a client about
// a row that then rolls back.
func handleReactionNotificationTx(
	ctx context.Context,
	tx *sql.Tx,
	ownerID,
	userID,
	objectID int64,
	newValue int,
	targetType string,
) (int64, error) {

	if ownerID == userID {
		return 0, nil
	}

	var notificationType string
	var postID *int64
	var commentID *int64

	switch targetType {

	case "post":
		postID = &objectID
		if newValue == 1 {
			notificationType = "post_like"
		} else {
			notificationType = "post_dislike"
		}

	case "comment":
		commentID = &objectID
		if newValue == 1 {
			notificationType = "comment_like"
		} else {
			notificationType = "comment_dislike"
		}

	default:
		return 0, nil
	}

	query := `
		INSERT INTO notifications
			(recipient_id, actor_id, type, post_id, comment_id, created_at, is_read)
		VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 0)
		ON CONFLICT DO NOTHING
	`

	result, err := tx.ExecContext(
		ctx,
		query,
		ownerID,
		userID,
		notificationType,
		postID,
		commentID,
	)
	if err != nil {
		return 0, err
	}

	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return 0, nil
	}

	return ownerID, nil
}
