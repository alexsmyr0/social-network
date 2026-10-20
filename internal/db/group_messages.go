package db

import (
	"context"
	"database/sql"
	"errors"
)

// GroupMessage is the approved room message DTO. Text only; no image field exists.
type GroupMessage struct {
	ID             int64   `json:"id"`
	GroupID        int64   `json:"group_id"`
	SenderID       int64   `json:"sender_id"`
	SenderUsername string  `json:"sender_username"`
	Body           string  `json:"body"`
	CreatedAt      string  `json:"created_at"`
	ClientID       *string `json:"client_id"`
}

type GroupRoomRef struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// GroupRoom is one summary row for a current membership.
type GroupRoom struct {
	Group         GroupRoomRef  `json:"group"`
	MembershipID  int64         `json:"membership_id"`
	LastMessage   *GroupMessage `json:"last_message"`
	ReadThroughID int64         `json:"read_through_id"`
	UnreadCount   int           `json:"unread_count"`
}

type GroupRoomPage struct {
	Items []GroupRoom
	Total int
}

type GroupHistoryPage struct {
	Messages     []GroupMessage
	HasMore      bool
	NextBeforeID *int64
}

// GroupRecipient is one current member and the generation their queued frame
// belongs to. Delivery rechecks both when the frame is written.
type GroupRecipient struct {
	UserID       int64
	MembershipID int64
}

type GroupSendRequest struct {
	SenderID     int64
	GroupID      int64
	MembershipID int64
	ClientID     string
	// Body is already canonical (LF line endings, trimmed) and not blank.
	Body string
}

type GroupSendResult struct {
	Message   GroupMessage
	Duplicate bool
	// Recipients is the committed member snapshot, sender included. It is empty
	// for an exact retry, which fans nothing out.
	Recipients []GroupRecipient
}

type GroupReadResult struct {
	MembershipID int64
	ThroughID    int64
	UnreadCount  int
	// Changed is true only when the persisted cursor advanced.
	Changed bool
}

// A retained message from an account that is no longer active shows the
// unavailable-account label instead of a name.
const groupMessageSelect = `SELECT m.id,m.group_id,m.sender_id,
 CASE WHEN s.is_active=1 THEN COALESCE(NULLIF(s.nickname,''),s.first_name||' '||s.last_name) ELSE 'Unavailable account' END,
 m.body,m.created_at,m.client_id
 FROM group_messages m JOIN users s ON s.id=m.sender_id`

func scanGroupMessage(row interface{ Scan(...any) error }) (GroupMessage, error) {
	var m GroupMessage
	var client sql.NullString
	if err := row.Scan(&m.ID, &m.GroupID, &m.SenderID, &m.SenderUsername, &m.Body, &m.CreatedAt, &client); err != nil {
		return m, err
	}
	if client.Valid {
		m.ClientID = &client.String
	}
	return m, nil
}

// GroupDeliveryAllowed reports whether a queued frame for one membership
// generation may still be written to viewer: that exact membership must still
// exist for the viewer in this group, in a visible group. A returned member holds
// a new generation, so a frame queued before the departure is never delivered
// after readmission.
func GroupDeliveryAllowed(ctx context.Context, q groupQuerier, viewer, group, membership int64) (bool, error) {
	var ok bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1
 JOIN groups g ON g.id=gm.group_id JOIN users cu ON cu.id=g.creator_id AND cu.is_active=1
 WHERE gm.id=? AND gm.group_id=? AND gm.user_id=?)`, membership, group, viewer).Scan(&ok)
	return ok, err
}

// SendGroupMessage is the one send command shared by HTTP and the socket. The
// membership check, generation check, retry lookup and insert share one
// serialized write transaction, so a departure either precedes the send (nothing
// is stored) or follows it (the message stays stored; only its delivery stops).
func SendGroupMessage(ctx context.Context, database *sql.DB, req GroupSendRequest) (GroupSendResult, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupSendResult{}, err
	}
	defer tx.Rollback()
	current, err := currentMembershipID(ctx, tx, req.SenderID, req.GroupID)
	if err != nil {
		return GroupSendResult{}, err
	}
	if current != req.MembershipID {
		return GroupSendResult{}, ErrStaleMembership
	}
	// Membership and generation precede the retry lookup, so a departed member
	// cannot replay a stored result.
	var existing int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM group_messages WHERE sender_id=? AND client_id=?`, req.SenderID, req.ClientID).Scan(&existing)
	if err == nil {
		var group, generation int64
		var body string
		if err := tx.QueryRowContext(ctx, `SELECT group_id,sender_membership_id,body FROM group_messages WHERE id=?`, existing).Scan(&group, &generation, &body); err != nil {
			return GroupSendResult{}, err
		}
		if group != req.GroupID || generation != current || body != req.Body {
			return GroupSendResult{}, ErrMessageConflict
		}
		prior, err := scanGroupMessage(tx.QueryRowContext(ctx, groupMessageSelect+` WHERE m.id=?`, existing))
		if err != nil {
			return GroupSendResult{}, err
		}
		return GroupSendResult{Message: prior, Duplicate: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return GroupSendResult{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO group_messages(group_id,sender_id,sender_membership_id,client_id,body) VALUES(?,?,?,?,?)`,
		req.GroupID, req.SenderID, current, req.ClientID, req.Body)
	if err != nil {
		return GroupSendResult{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return GroupSendResult{}, err
	}
	message, err := scanGroupMessage(tx.QueryRowContext(ctx, groupMessageSelect+` WHERE m.id=?`, id))
	if err != nil {
		return GroupSendResult{}, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT gm.user_id,gm.id FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1
 WHERE gm.group_id=? ORDER BY gm.user_id`, req.GroupID)
	if err != nil {
		return GroupSendResult{}, err
	}
	recipients := []GroupRecipient{}
	for rows.Next() {
		var r GroupRecipient
		if err := rows.Scan(&r.UserID, &r.MembershipID); err != nil {
			rows.Close()
			return GroupSendResult{}, err
		}
		recipients = append(recipients, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return GroupSendResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return GroupSendResult{}, err
	}
	return GroupSendResult{Message: message, Recipients: recipients}, nil
}

// GroupHistory returns one snapshot page, ascending within the page. Only a
// current member may read; departed authors' retained messages remain.
func GroupHistory(ctx context.Context, database *sql.DB, viewer, group, before int64, limit int) (GroupHistoryPage, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupHistoryPage{}, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, group, false); err != nil {
		return GroupHistoryPage{}, err
	}
	rows, err := tx.QueryContext(ctx, groupMessageSelect+` WHERE m.group_id=?1 AND (?2=0 OR m.id<?2) ORDER BY m.id DESC LIMIT ?3`, group, before, limit+1)
	if err != nil {
		return GroupHistoryPage{}, err
	}
	pending := []GroupMessage{}
	for rows.Next() {
		m, err := scanGroupMessage(rows)
		if err != nil {
			rows.Close()
			return GroupHistoryPage{}, err
		}
		pending = append(pending, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return GroupHistoryPage{}, err
	}
	page := GroupHistoryPage{Messages: []GroupMessage{}}
	if len(pending) > limit {
		pending = pending[:limit]
		page.HasMore = true
	}
	for i := len(pending) - 1; i >= 0; i-- {
		page.Messages = append(page.Messages, pending[i])
	}
	if page.HasMore {
		first := page.Messages[0].ID
		page.NextBeforeID = &first
	}
	return page, tx.Commit()
}

// currentRooms joins one viewer's current memberships to their visible groups.
// ?1 is the viewer.
const currentRooms = ` FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1
 JOIN groups g ON g.id=gm.group_id JOIN users cu ON cu.id=g.creator_id AND cu.is_active=1
 LEFT JOIN group_read_cursors c ON c.membership_id=gm.id
 WHERE gm.user_id=?1`

// GroupRooms lists the viewer's current rooms, including empty ones, by group ID.
func GroupRooms(ctx context.Context, database *sql.DB, viewer int64, page, per int) (GroupRoomPage, error) {
	result := GroupRoomPage{Items: []GroupRoom{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+currentRooms, viewer).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT g.id,g.title,gm.id,COALESCE(c.through_id,0),
 (SELECT COUNT(*) FROM group_messages x WHERE x.group_id=g.id AND x.sender_id<>?1 AND x.id>COALESCE(c.through_id,0)),
 (SELECT MAX(id) FROM group_messages WHERE group_id=g.id)`+currentRooms+` ORDER BY g.id LIMIT ?2 OFFSET ?3`, viewer, per, (page-1)*per)
	if err != nil {
		return result, err
	}
	lastIDs := []sql.NullInt64{}
	for rows.Next() {
		var room GroupRoom
		var last sql.NullInt64
		if err := rows.Scan(&room.Group.ID, &room.Group.Title, &room.MembershipID, &room.ReadThroughID, &room.UnreadCount, &last); err != nil {
			rows.Close()
			return result, err
		}
		result.Items = append(result.Items, room)
		lastIDs = append(lastIDs, last)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for i, last := range lastIDs {
		if !last.Valid {
			continue
		}
		m, err := scanGroupMessage(tx.QueryRowContext(ctx, groupMessageSelect+` WHERE m.id=?`, last.Int64))
		if err != nil {
			return result, err
		}
		result.Items[i].LastMessage = &m
	}
	return result, tx.Commit()
}

// GroupUnreadTotal counts other members' messages after each cursor across the
// viewer's current rooms only, independent of room paging.
func GroupUnreadTotal(ctx context.Context, database *sql.DB, viewer int64) (int, error) {
	var total int
	err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_messages x
 JOIN group_memberships gm ON gm.group_id=x.group_id AND gm.user_id=?1 JOIN users u ON u.id=gm.user_id AND u.is_active=1
 JOIN groups g ON g.id=gm.group_id JOIN users cu ON cu.id=g.creator_id AND cu.is_active=1
 LEFT JOIN group_read_cursors c ON c.membership_id=gm.id
 WHERE x.sender_id<>?1 AND x.id>COALESCE(c.through_id,0)`, viewer).Scan(&total)
	return total, err
}

func groupRoomUnread(ctx context.Context, q groupQuerier, viewer, group, membership int64) (int64, int, error) {
	var through int64
	var unread int
	err := q.QueryRowContext(ctx, `SELECT COALESCE(c.through_id,0),(SELECT COUNT(*) FROM group_messages x WHERE x.group_id=?2 AND x.sender_id<>?1 AND x.id>COALESCE(c.through_id,0))
 FROM (SELECT 1) LEFT JOIN group_read_cursors c ON c.membership_id=?3`, viewer, group, membership).Scan(&through, &unread)
	return through, unread, err
}

// MarkGroupRead advances the cursor of the caller's current membership
// monotonically. Zero is a no-op; a nonzero ID must be a message of this room.
func MarkGroupRead(ctx context.Context, database *sql.DB, viewer, group, membership, through int64) (GroupReadResult, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupReadResult{}, err
	}
	defer tx.Rollback()
	current, err := currentMembershipID(ctx, tx, viewer, group)
	if err != nil {
		return GroupReadResult{}, err
	}
	if current != membership {
		return GroupReadResult{}, ErrStaleMembership
	}
	if through > 0 {
		var belongs bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_messages WHERE id=? AND group_id=?)`, through, group).Scan(&belongs); err != nil {
			return GroupReadResult{}, err
		}
		if !belongs {
			return GroupReadResult{}, contentField("through_id", "INVALID_ID")
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO group_read_cursors(membership_id,through_id) VALUES(?,0)`, current); err != nil {
		return GroupReadResult{}, err
	}
	stored, _, err := groupRoomUnread(ctx, tx, viewer, group, current)
	if err != nil {
		return GroupReadResult{}, err
	}
	result := GroupReadResult{MembershipID: current, ThroughID: stored}
	if through > stored {
		if _, err := tx.ExecContext(ctx, `UPDATE group_read_cursors SET through_id=? WHERE membership_id=? AND through_id<?`, through, current, through); err != nil {
			return GroupReadResult{}, err
		}
		result.ThroughID, result.Changed = through, true
	}
	if _, result.UnreadCount, err = groupRoomUnread(ctx, tx, viewer, group, current); err != nil {
		return GroupReadResult{}, err
	}
	return result, tx.Commit()
}
