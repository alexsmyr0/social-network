package db

import (
	"context"
	"database/sql"
	"time"
)

const notificationsQueryTimeout = 2 * time.Second

type ListNotificationsResult struct {
	Notifications []Notification `json:"notifications"`
	UnreadCount   int            `json:"unread_count"`
}

func ListUserNotifications(
	ctx context.Context,
	db *sql.DB,
	userID int64,
) (ListNotificationsResult, error) {

	ctx, cancel := context.WithTimeout(ctx, notificationsQueryTimeout)
	defer cancel()

	rows, err := db.QueryContext(ctx, `
		SELECT 
			n.id,
			n.recipient_id,
			n.actor_id,
			u.username AS actor_username,
			n.type,

			-- Always return the correct post ID
			COALESCE(n.post_id, p.id) AS post_id,

			n.comment_id,
			n.created_at,
			n.is_read,

			-- Post title for all notification types
			COALESCE(p.title, '') AS post_title,

			-- Comment excerpt logic:
			CASE 
				-- Actual comment (like/dislike)
				WHEN n.comment_id IS NOT NULL AND c.body IS NOT NULL 
					THEN SUBSTR(c.body, 1, 20)

				-- New comment on post (type = 'comment'), no comment_id stored
				WHEN n.type = 'comment' THEN (
					SELECT SUBSTR(body, 1, 20)
					FROM comments 
					WHERE post_id = COALESCE(n.post_id, p.id)
					ORDER BY created_at DESC
					LIMIT 1
				)

				ELSE ''
			END AS comment_excerpt

		FROM notifications n
		JOIN users u ON u.id = n.actor_id
		LEFT JOIN comments c ON c.id = n.comment_id
		LEFT JOIN posts p ON p.id = COALESCE(n.post_id, c.post_id)

		WHERE n.recipient_id = ?
		ORDER BY n.created_at DESC;
	`, userID)
	if err != nil {
		return ListNotificationsResult{}, err
	}
	defer rows.Close()

	var list []Notification

	for rows.Next() {
		var n Notification
		var postID sql.NullInt64
		var commentID sql.NullInt64
		var isRead int

		err := rows.Scan(
			&n.ID,
			&n.RecipientID,
			&n.ActorID,
			&n.ActorUsername,
			&n.Type,
			&postID,
			&commentID,
			&n.CreatedAt,
			&isRead,
			&n.PostTitle,
			&n.CommentExcerpt,
		)
		if err != nil {
			return ListNotificationsResult{}, err
		}

		if postID.Valid {
			n.PostID = &postID.Int64
		}
		if commentID.Valid {
			n.CommentID = &commentID.Int64
		}

		n.IsRead = isRead == 1
		list = append(list, n)
	}

	var unread int
	err = db.QueryRowContext(ctx, `
		SELECT COUNT(*) 
		FROM notifications 
		WHERE recipient_id = ? AND is_read = 0
	`, userID).Scan(&unread)
	if err != nil {
		return ListNotificationsResult{}, err
	}

	return ListNotificationsResult{
		Notifications: list,
		UnreadCount:   unread,
	}, nil
}

func MarkNotificationRead(
	ctx context.Context,
	db *sql.DB,
	userID,
	notificationID int64,
) (bool, error) {

	ctx, cancel := context.WithTimeout(ctx, notificationsQueryTimeout)
	defer cancel()

	res, err := db.ExecContext(ctx, `
		UPDATE notifications
		SET is_read = 1
		WHERE id = ? AND recipient_id = ?
	`, notificationID, userID)
	if err != nil {
		return false, err
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return false, err
	}

	return rows > 0, nil
}

func MarkAllNotificationsRead(
	ctx context.Context,
	db *sql.DB,
	userID int64,
) error {

	ctx, cancel := context.WithTimeout(ctx, notificationsQueryTimeout)
	defer cancel()

	_, err := db.ExecContext(ctx, `
		UPDATE notifications
		SET is_read = 1
		WHERE recipient_id = ?
	`, userID)

	return err
}
