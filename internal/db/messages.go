// internal/db/messages.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type PrivateMessage struct {
	ID          int64   `json:"id"`
	SenderID    int64   `json:"sender_id"`
	RecipientID int64   `json:"recipient_id"`
	Body        string  `json:"body"`
	ImagePath   *string `json:"image_url,omitempty"`
	CreatedAt   string  `json:"created_at"`
}

type CreateMessageRequest struct {
	SenderID    int64
	RecipientID int64
	Body        string
	// ImagePath is the relative URL of an attached DM image
	// (e.g. /static/uploads/dm/abc.png). Empty means no attachment and is
	// stored as NULL.
	ImagePath string
}

// CreateMessage persists a new private message and returns the stored record.
func CreateMessage(ctx context.Context, database *sql.DB, req CreateMessageRequest) (PrivateMessage, error) {
	if req.SenderID == req.RecipientID {
		return PrivateMessage{}, fmt.Errorf("sender and recipient must be different users")
	}
	// A message must carry text or an image attachment; image-only messages
	// (empty body + image) are allowed.
	if strings.TrimSpace(req.Body) == "" && strings.TrimSpace(req.ImagePath) == "" {
		return PrivateMessage{}, fmt.Errorf("message must have a body or an image")
	}

	// Empty ImagePath is stored as NULL so the column means "no attachment"
	// rather than an empty string.
	var imagePath any
	if strings.TrimSpace(req.ImagePath) != "" {
		imagePath = req.ImagePath
	}

	result, err := database.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body, image_path)
		 VALUES (?, ?, ?, ?)`,
		req.SenderID, req.RecipientID, req.Body, imagePath,
	)
	if err != nil {
		return PrivateMessage{}, fmt.Errorf("create message: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return PrivateMessage{}, fmt.Errorf("last insert id: %w", err)
	}

	var (
		msg PrivateMessage
		img sql.NullString
	)
	err = database.QueryRowContext(ctx,
		`SELECT id, sender_id, recipient_id, body, image_path, created_at
		 FROM private_messages WHERE id = ?`, id,
	).Scan(&msg.ID, &msg.SenderID, &msg.RecipientID, &msg.Body, &img, &msg.CreatedAt)
	if err != nil {
		return PrivateMessage{}, fmt.Errorf("fetch created message: %w", err)
	}
	if img.Valid {
		msg.ImagePath = &img.String
	}

	return msg, nil
}

// RosterEntry is a row of the chat roster: a user (other than the caller) plus
// the metadata needed to render and sort the persistent chat list. The
// last-message fields are zero-valued when the pair has no message history.
type RosterEntry struct {
	UserID             int64
	Username           string
	LastMessageAt      string
	LastMessagePreview string
	LastSenderID       int64
}

// rosterPreviewMaxChars caps the size of the last-message preview returned in
// the roster payload. SQLite's substr() operates on Unicode codepoints when
// applied to TEXT, so this cannot split a multi-byte character. A bound here
// keeps the roster response small even when individual DM bodies are large.
const rosterPreviewMaxChars = 200

// GetChatRoster returns one entry per user other than viewerID, with the most
// recent message between viewerID and that user attached when one exists.
//
// Ordering: users with history first, by last_message_at DESC (with msg id as a
// deterministic tiebreak when timestamps collide at second-resolution); users
// without history follow, sorted by username ASC (case-insensitive).
//
// One query, one window-function pass — no per-user N+1.
func GetChatRoster(ctx context.Context, database *sql.DB, viewerID int64) ([]RosterEntry, error) {
	rows, err := database.QueryContext(ctx, `
		WITH pair_msgs AS (
			SELECT
				CASE WHEN sender_id = ?1 THEN recipient_id ELSE sender_id END AS other_id,
				id, sender_id, body, image_path, created_at,
				ROW_NUMBER() OVER (
					PARTITION BY CASE WHEN sender_id = ?1 THEN recipient_id ELSE sender_id END
					ORDER BY id DESC
				) AS rn
			FROM private_messages
			WHERE sender_id = ?1 OR recipient_id = ?1
		),
		latest AS (
			SELECT other_id, id AS msg_id, sender_id, body, image_path, created_at
			FROM pair_msgs WHERE rn = 1
		)
		SELECT
			u.id,
			u.username,
			COALESCE(l.created_at, '') AS last_message_at,
			-- Prefer the text body; for an image-only DM (empty body, image set)
			-- fall back to a "[image]" glyph so the roster preview is never blank.
			COALESCE(
				NULLIF(SUBSTR(COALESCE(l.body, ''), 1, ?2), ''),
				CASE WHEN l.image_path IS NOT NULL THEN '[image]' END,
				''
			) AS last_message_preview,
			COALESCE(l.sender_id, 0) AS last_sender_id
		FROM users u
		LEFT JOIN latest l ON l.other_id = u.id
		WHERE u.id <> ?1
		ORDER BY
			CASE WHEN l.created_at IS NULL THEN 1 ELSE 0 END,
			l.created_at DESC,
			l.msg_id DESC,
			LOWER(u.username) ASC
	`, viewerID, rosterPreviewMaxChars)
	if err != nil {
		return nil, fmt.Errorf("get chat roster: %w", err)
	}
	defer rows.Close()

	var entries []RosterEntry
	for rows.Next() {
		var e RosterEntry
		if err := rows.Scan(&e.UserID, &e.Username, &e.LastMessageAt, &e.LastMessagePreview, &e.LastSenderID); err != nil {
			return nil, fmt.Errorf("scan roster row: %w", err)
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("roster rows: %w", err)
	}
	return entries, nil
}

// GetMessageHistory returns up to 10 messages exchanged between two users,
// ordered oldest-first (render-ready), and a hasMore flag that is true when
// older messages exist beyond this page. Pass beforeID > 0 to paginate
// backwards through history; pass 0 to get the latest 10.
//
// The function fetches 11 rows internally: if 11 arrive, the 11th is discarded
// and hasMore is set to true. This avoids a separate COUNT query.
func GetMessageHistory(ctx context.Context, database *sql.DB, userA, userB, beforeID int64) ([]PrivateMessage, bool, error) {
	const pageSize = 10
	const fetchLimit = pageSize + 1 // fetch one extra to detect a next page

	var rows *sql.Rows
	var err error

	if beforeID > 0 {
		rows, err = database.QueryContext(ctx,
			`SELECT id, sender_id, recipient_id, body, image_path, created_at FROM private_messages
			 WHERE sender_id = ? AND recipient_id = ? AND id < ?
			 UNION ALL
			 SELECT id, sender_id, recipient_id, body, image_path, created_at FROM private_messages
			 WHERE sender_id = ? AND recipient_id = ? AND id < ?
			 ORDER BY id DESC
			 LIMIT ?`,
			userA, userB, beforeID, userB, userA, beforeID, fetchLimit,
		)
	} else {
		rows, err = database.QueryContext(ctx,
			`SELECT id, sender_id, recipient_id, body, image_path, created_at FROM private_messages
			 WHERE sender_id = ? AND recipient_id = ?
			 UNION ALL
			 SELECT id, sender_id, recipient_id, body, image_path, created_at FROM private_messages
			 WHERE sender_id = ? AND recipient_id = ?
			 ORDER BY id DESC
			 LIMIT ?`,
			userA, userB, userB, userA, fetchLimit,
		)
	}
	if err != nil {
		return nil, false, fmt.Errorf("get message history: %w", err)
	}
	defer rows.Close()

	var msgs []PrivateMessage
	for rows.Next() {
		var (
			m   PrivateMessage
			img sql.NullString
		)
		if err := rows.Scan(&m.ID, &m.SenderID, &m.RecipientID, &m.Body, &img, &m.CreatedAt); err != nil {
			return nil, false, fmt.Errorf("scan message: %w", err)
		}
		if img.Valid {
			m.ImagePath = &img.String
		}
		msgs = append(msgs, m)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("rows error: %w", err)
	}

	// If the extra sentinel row arrived, there are older messages beyond this page.
	hasMore := len(msgs) == fetchLimit
	if hasMore {
		msgs = msgs[:pageSize]
	}

	// Reverse to chronological order (oldest first).
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}

	return msgs, hasMore, nil
}
