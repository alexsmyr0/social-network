package db

import (
	"context"
	"database/sql"
	"strings"
)

type NoticeTarget struct {
	Kind      string  `json:"kind"`
	FollowID  *int64  `json:"follow_id,omitempty"`
	State     string  `json:"state,omitempty"`
	PostID    *int64  `json:"post_id,omitempty"`
	CommentID *int64  `json:"comment_id,omitempty"`
	Title     *string `json:"title,omitempty"`
	Excerpt   *string `json:"excerpt,omitempty"`
}
type SocialNotice struct {
	ID        int64        `json:"id"`
	Type      string       `json:"type"`
	CreatedAt string       `json:"created_at"`
	IsRead    bool         `json:"is_read"`
	Actor     Person       `json:"actor"`
	Target    NoticeTarget `json:"target"`
	Actions   []string     `json:"actions"`
}
type SocialNotificationsPage struct {
	Notifications []SocialNotice `json:"notifications"`
	UnreadCount   int            `json:"unread_count"`
	Total         int            `json:"-"`
}

// All projections, counts and writes share this access filter. Personal content
// inherits its post author's profile privacy; B16 adds the future audience model.
const noticeJoins = ` FROM notifications n
 JOIN users a ON a.id=n.actor_id AND a.is_active=1
 JOIN users v ON v.id=n.recipient_id AND v.is_active=1
 LEFT JOIN comments c ON c.id=n.comment_id
 LEFT JOIN posts p ON p.id=COALESCE(n.post_id,c.post_id)
 LEFT JOIN users u ON u.id=p.author_id `

var visibleNotice = `n.recipient_id=? AND (n.type='follow_request' OR
 (p.id IS NOT NULL AND p.status='published' AND u.is_active=1 AND ` + strings.ReplaceAll(profilePermission, "?", "n.recipient_id") + `))`

func ListSocialNotifications(ctx context.Context, database *sql.DB, viewer int64, page, perPage int) (SocialNotificationsPage, error) {
	result := SocialNotificationsPage{Notifications: []SocialNotice{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(CASE WHEN n.is_read=0 THEN 1 ELSE 0 END),0)`+noticeJoins+`WHERE `+visibleNotice, viewer).Scan(&result.Total, &result.UnreadCount); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT n.id,n.type,n.created_at,n.is_read,n.actor_id,n.follow_id,n.follow_state,p.id,n.comment_id,p.title,c.body,
 EXISTS(SELECT 1 FROM follows f WHERE f.id=n.follow_id AND f.follower_id=n.actor_id AND f.followed_id=n.recipient_id AND f.state='pending')`+noticeJoins+`WHERE `+visibleNotice+` ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`, viewer, perPage, (page-1)*perPage)
	if err != nil {
		return result, err
	}
	type item struct {
		notice SocialNotice
		actor  int64
	}
	items := []item{}
	for rows.Next() {
		var x item
		var follow, post, comment sql.NullInt64
		var state, title, body sql.NullString
		var actionable bool
		if err := rows.Scan(&x.notice.ID, &x.notice.Type, &x.notice.CreatedAt, &x.notice.IsRead, &x.actor, &follow, &state, &post, &comment, &title, &body, &actionable); err != nil {
			rows.Close()
			return result, err
		}
		n := &x.notice
		n.Actions = []string{}
		if n.Type == "follow_request" {
			n.Target = NoticeTarget{Kind: "follow_request", FollowID: &follow.Int64, State: state.String}
			if state.String == "pending" && actionable {
				n.Actions = []string{"accept", "decline"}
			}
		} else {
			n.Target = NoticeTarget{Kind: "post", PostID: &post.Int64, Title: &title.String}
			if comment.Valid {
				n.Target.Kind = "comment"
				n.Target.CommentID = &comment.Int64
				// Stored bodies are plain text; truncate Unicode code points, not UTF-8 bytes.
				runes := []rune(body.String)
				if len(runes) > 20 {
					runes = runes[:20]
				}
				excerpt := string(runes)
				n.Target.Excerpt = &excerpt
			}
		}
		items = append(items, x)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, x := range items {
		x.notice.Actor, err = personInTx(ctx, tx, viewer, x.actor)
		if err != nil {
			return result, err
		}
		result.Notifications = append(result.Notifications, x.notice)
	}
	return result, tx.Commit()
}

// MarkSocialNotificationsRead serializes authorization with relationship/privacy
// writes. id=0 selects all visible notices; hidden stored flags stay untouched.
func MarkSocialNotificationsRead(ctx context.Context, database *sql.DB, viewer, id int64) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	where := visibleNotice
	args := []any{viewer}
	if id != 0 {
		where += ` AND n.id=?`
		args = append(args, id)
	}
	if id != 0 {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1`+noticeJoins+`WHERE `+where+`)`, args...).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE notifications SET is_read=1 WHERE id IN (SELECT n.id`+noticeJoins+`WHERE `+where+`)`, args...); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation(viewer)
	return nil
}
