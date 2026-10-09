package db

import (
	"context"
	"database/sql"
	"encoding/json"
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
	// Group invitation/request notices carry the exact entry identity and the
	// public group reference; resolved entries keep their historical ID here.
	InvitationID *int64       `json:"invitation_id,omitempty"`
	RequestID    *int64       `json:"request_id,omitempty"`
	Group        *NoticeGroup `json:"group,omitempty"`
}

type NoticeGroup struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// Content targets always carry the current nullable post title; follow-request
// and group targets never do.
func (t NoticeTarget) MarshalJSON() ([]byte, error) {
	type alias NoticeTarget
	if t.Kind == "follow_request" || strings.HasPrefix(t.Kind, "group_") {
		return json.Marshal(alias(t))
	}
	return json.Marshal(struct {
		alias
		Title *string `json:"title"`
	}{alias(t), t.Title})
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

// All projections, counts and writes share this access filter: the recipient must
// currently be able to read the published parent post (profile AND audience) and,
// for comment notices, the comment's author must still be active.
const noticeJoins = ` FROM notifications n
 JOIN users a ON a.id=n.actor_id AND a.is_active=1
 JOIN users v ON v.id=n.recipient_id AND v.is_active=1
 LEFT JOIN groups g ON g.id=n.group_id
 LEFT JOIN comments c ON c.id=n.comment_id
 LEFT JOIN posts p ON p.id=COALESCE(n.post_id,c.post_id)
 LEFT JOIN users u ON u.id=p.author_id `

// Group invitation/request notices belong to their recipient and stay listable
// after membership loss: they reveal only public group metadata, never content.
var visibleNotice = `n.recipient_id=? AND (n.type IN ('follow_request','group_invitation','group_join_request') OR
 (p.id IS NOT NULL AND p.status='published' AND ` + strings.ReplaceAll(contentPermission, "?1", "n.recipient_id") + `
 AND (c.id IS NULL OR EXISTS(SELECT 1 FROM users ca WHERE ca.id=c.user_id AND ca.is_active=1))))`

// A group notice is actionable only while its exact entry still exists for the
// recipient: the invitee of a live invitation whose inviter is still an active
// member, or the creator holding a live request from that requester.
const groupActionable = `CASE n.type
 WHEN 'group_invitation' THEN EXISTS(SELECT 1 FROM group_invitations i
   JOIN group_memberships im ON im.group_id=i.group_id AND im.user_id=i.inviter_id
   JOIN users iu ON iu.id=im.user_id AND iu.is_active=1
   WHERE i.id=n.group_entry_id AND i.invitee_id=n.recipient_id AND i.group_id=n.group_id)
 WHEN 'group_join_request' THEN EXISTS(SELECT 1 FROM group_join_requests r JOIN groups rg ON rg.id=r.group_id
   WHERE r.id=n.group_entry_id AND rg.creator_id=n.recipient_id AND r.requester_id=n.actor_id)
 ELSE 0 END`

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
 EXISTS(SELECT 1 FROM follows f WHERE f.id=n.follow_id AND f.follower_id=n.actor_id AND f.followed_id=n.recipient_id AND f.state='pending'),
 n.group_id,n.group_entry_id,n.group_state,g.title,`+groupActionable+noticeJoins+`WHERE `+visibleNotice+` ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?`, viewer, perPage, (page-1)*perPage)
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
		var follow, post, comment, group, entry sql.NullInt64
		var state, title, body, groupState, groupTitle sql.NullString
		var actionable, groupLive bool
		if err := rows.Scan(&x.notice.ID, &x.notice.Type, &x.notice.CreatedAt, &x.notice.IsRead, &x.actor, &follow, &state, &post, &comment, &title, &body, &actionable, &group, &entry, &groupState, &groupTitle, &groupLive); err != nil {
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
		} else if n.Type == "group_invitation" || n.Type == "group_join_request" {
			n.Target = NoticeTarget{Kind: n.Type, State: groupState.String, Group: &NoticeGroup{ID: group.Int64, Title: groupTitle.String}}
			if n.Type == "group_invitation" {
				n.Target.InvitationID = &entry.Int64
			} else {
				n.Target.RequestID = &entry.Int64
			}
			if groupState.String == "pending" && groupLive {
				n.Actions = []string{"accept", "refuse"}
			}
		} else {
			n.Target = NoticeTarget{Kind: "post", PostID: &post.Int64}
			if title.Valid {
				n.Target.Title = &title.String
			}
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
	result, err := tx.ExecContext(ctx, `UPDATE notifications SET is_read=1 WHERE is_read=0 AND id IN (SELECT n.id`+noticeJoins+`WHERE `+where+`)`, args...)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// Repeats and reads that only skip hidden rows change nothing to refresh.
	if changed > 0 {
		fireSocialInvalidation(viewer)
	}
	return nil
}
