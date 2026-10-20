package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

var ErrStaleEventResponse = errors.New("event response changed")

type EventResponse struct {
	Choice  string `json:"choice"`
	Version int64  `json:"version"`
}
type EventCounts struct {
	Going    int `json:"going"`
	NotGoing int `json:"not_going"`
}
type GroupEvent struct {
	ID             int64          `json:"id"`
	GroupID        int64          `json:"group_id"`
	Creator        GroupPerson    `json:"creator"`
	Title          string         `json:"title"`
	Description    string         `json:"description"`
	StartsAt       string         `json:"starts_at"`
	CreatedAt      string         `json:"created_at"`
	Options        []string       `json:"options"`
	Counts         EventCounts    `json:"counts"`
	ViewerResponse *EventResponse `json:"viewer_response"`
}
type GroupEventResponse struct {
	User GroupPerson `json:"user"`
	EventResponse
}
type GroupEventPage struct {
	Items []GroupEvent
	Total int
}
type GroupEventResponsePage struct {
	Items []GroupEventResponse
	Total int
}

// EventMemberSQL adds the group visibility rule to the shared active membership
// predicate. Used by event reads and every event-notice consumer.
func EventMemberSQL(groupExpr, userExpr string) string {
	return GroupMemberSQL(groupExpr, userExpr) + ` AND EXISTS(SELECT 1 FROM groups eg_ JOIN users ec_ ON ec_.id=eg_.creator_id AND ec_.is_active=1 WHERE eg_.id=` + groupExpr + `)`
}

func currentMembershipID(ctx context.Context, q groupQuerier, viewer, gid int64) (int64, error) {
	if err := requireMember(ctx, q, viewer, gid, false); err != nil {
		return 0, err
	}
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM group_memberships WHERE group_id=? AND user_id=?`, gid, viewer).Scan(&id)
	return id, err
}

const eventColumns = `e.id,e.group_id,e.creator_id,u.first_name,u.last_name,u.nickname,u.is_active,e.title,e.description,e.starts_at,e.created_at`

func scanGroupEvent(row interface{ Scan(...any) error }) (GroupEvent, error) {
	e := GroupEvent{Options: []string{"going", "not_going"}}
	var first, last string
	var nickname sql.NullString
	var active bool
	err := row.Scan(&e.ID, &e.GroupID, &e.Creator.ID, &first, &last, &nickname, &active, &e.Title, &e.Description, &e.StartsAt, &e.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrNotFound
	}
	if err != nil {
		return e, err
	}
	e.Creator.DisplayName = "Unavailable account"
	if active {
		e.Creator.DisplayName = groupPersonName(first, last, nickname)
	}
	return e, nil
}

// eventInTx projects aggregates only for current active membership generations.
// The caller has already checked the viewer's membership in the same snapshot.
func eventInTx(ctx context.Context, q groupQuerier, viewer, gid, id int64) (GroupEvent, error) {
	e, err := scanGroupEvent(q.QueryRowContext(ctx, `SELECT `+eventColumns+`
 FROM group_events e JOIN users u ON u.id=e.creator_id WHERE e.group_id=? AND e.id=?`, gid, id))
	if err != nil {
		return e, err
	}
	err = q.QueryRowContext(ctx, `SELECT COALESCE(SUM(r.choice='going'),0),COALESCE(SUM(r.choice='not_going'),0)
 FROM group_event_responses r JOIN group_memberships m ON m.id=r.membership_id AND m.user_id=r.user_id
 JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE r.event_id=? AND m.group_id=?`, id, gid).Scan(&e.Counts.Going, &e.Counts.NotGoing)
	if err != nil {
		return e, err
	}
	var response EventResponse
	err = q.QueryRowContext(ctx, `SELECT r.choice,r.version FROM group_event_responses r
 JOIN group_memberships m ON m.id=r.membership_id AND m.user_id=r.user_id
 WHERE r.event_id=? AND m.group_id=? AND m.user_id=?`, id, gid, viewer).Scan(&response.Choice, &response.Version)
	if err == nil {
		e.ViewerResponse = &response
	} else if !errors.Is(err, sql.ErrNoRows) {
		return e, err
	}
	return e, nil
}

func GetGroupEvent(ctx context.Context, database *sql.DB, viewer, gid, id int64) (GroupEvent, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupEvent{}, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, gid, false); err != nil {
		return GroupEvent{}, err
	}
	e, err := eventInTx(ctx, tx, viewer, gid, id)
	if err != nil {
		return e, err
	}
	return e, tx.Commit()
}
func ListGroupEvents(ctx context.Context, database *sql.DB, viewer, gid int64, page, per int) (GroupEventPage, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return GroupEventPage{}, err
	}
	defer tx.Rollback()
	result, err := eventPageInTx(ctx, tx, viewer, gid, page, per)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// eventPageInTx reads the page and its aggregates in at most four queries regardless of
// page size. Authorization, totals and projections share the caller's snapshot.
func eventPageInTx(ctx context.Context, q groupQuerier, viewer, gid int64, page, per int) (GroupEventPage, error) {
	result := GroupEventPage{Items: []GroupEvent{}}
	if err := requireMember(ctx, q, viewer, gid, false); err != nil {
		return result, err
	}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_events WHERE group_id=?`, gid).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := q.QueryContext(ctx, `SELECT `+eventColumns+`
 FROM group_events e JOIN users u ON u.id=e.creator_id WHERE e.group_id=? ORDER BY e.starts_at,e.id LIMIT ? OFFSET ?`, gid, per, (page-1)*per)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		e, err := scanGroupEvent(rows)
		if err != nil {
			rows.Close()
			return result, err
		}
		result.Items = append(result.Items, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(result.Items) == 0 {
		return result, err
	}
	args := []any{viewer, viewer, gid}
	byID := make(map[int64]*GroupEvent, len(result.Items))
	for i := range result.Items {
		e := &result.Items[i]
		args = append(args, e.ID)
		byID[e.ID] = e
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(result.Items)), ",")
	rows, err = q.QueryContext(ctx, `SELECT r.event_id,SUM(r.choice='going'),SUM(r.choice='not_going'),
 MAX(CASE WHEN r.user_id=? THEN r.choice END),MAX(CASE WHEN r.user_id=? THEN r.version END)
 FROM group_event_responses r JOIN group_memberships m ON m.id=r.membership_id AND m.user_id=r.user_id
 JOIN users u ON u.id=m.user_id AND u.is_active=1
 WHERE m.group_id=? AND r.event_id IN (`+placeholders+`) GROUP BY r.event_id`, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var counts EventCounts
		var choice sql.NullString
		var version sql.NullInt64
		if err := rows.Scan(&id, &counts.Going, &counts.NotGoing, &choice, &version); err != nil {
			return result, err
		}
		e := byID[id]
		e.Counts = counts
		if choice.Valid && version.Valid {
			e.ViewerResponse = &EventResponse{Choice: choice.String, Version: version.Int64}
		}
	}
	return result, rows.Err()
}
func ListGroupEventResponses(ctx context.Context, database *sql.DB, viewer, gid, id int64, page, per int) (GroupEventResponsePage, error) {
	result := GroupEventResponsePage{Items: []GroupEventResponse{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, gid, false); err != nil {
		return result, err
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_events WHERE id=? AND group_id=?)`, id, gid).Scan(&exists); err != nil {
		return result, err
	}
	if !exists {
		return result, ErrNotFound
	}
	const from = ` FROM group_event_responses r JOIN group_memberships m ON m.id=r.membership_id AND m.user_id=r.user_id
 JOIN users u ON u.id=m.user_id AND u.is_active=1 WHERE r.event_id=? AND m.group_id=?`
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, id, gid).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT u.id,u.first_name,u.last_name,u.nickname,r.choice,r.version`+from+` ORDER BY u.id LIMIT ? OFFSET ?`, id, gid, per, (page-1)*per)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var r GroupEventResponse
		var first, last string
		var nickname sql.NullString
		if err := rows.Scan(&r.User.ID, &first, &last, &nickname, &r.Choice, &r.Version); err != nil {
			rows.Close()
			return result, err
		}
		r.User.DisplayName = groupPersonName(first, last, nickname)
		result.Items = append(result.Items, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func CreateGroupEvent(ctx context.Context, database *sql.DB, viewer, gid, membership int64, title, description, startsAt string) (GroupEvent, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupEvent{}, err
	}
	defer tx.Rollback()
	current, err := currentMembershipID(ctx, tx, viewer, gid)
	if err != nil {
		return GroupEvent{}, err
	}
	if current != membership {
		return GroupEvent{}, ErrStaleMembership
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO group_events(group_id,creator_id,title,description,starts_at) VALUES(?,?,?,?,?)`, gid, viewer, title, description, startsAt)
	if err != nil {
		return GroupEvent{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return GroupEvent{}, err
	}
	members := recipientSet{}
	if err := members.addMembers(ctx, tx, gid); err != nil {
		return GroupEvent{}, err
	}
	for _, recipient := range members.sorted() {
		if recipient == viewer {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(recipient_id,actor_id,type,group_id,event_id) VALUES(?,?,'group_event',?,?)`, recipient, viewer, gid, id); err != nil {
			return GroupEvent{}, err
		}
	}
	e, err := eventInTx(ctx, tx, viewer, gid, id)
	if err != nil {
		return e, err
	}
	if err := tx.Commit(); err != nil {
		return e, err
	}
	for _, recipient := range members.sorted() {
		if recipient != viewer {
			fireNotificationHook(recipient)
		}
	}
	fireSocialInvalidation(members.sorted()...)
	return e, nil
}

func RespondGroupEvent(ctx context.Context, database *sql.DB, viewer, gid, id, membership, expected int64, choice string) (GroupEvent, error) {
	if choice != "going" && choice != "not_going" || expected < 0 || expected > MaxSocialID {
		return GroupEvent{}, ErrInvalidInput
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupEvent{}, err
	}
	defer tx.Rollback()
	current, err := currentMembershipID(ctx, tx, viewer, gid)
	if err != nil {
		return GroupEvent{}, err
	}
	if current != membership {
		return GroupEvent{}, ErrStaleMembership
	}
	// Check event identity and the current generation's version without loading
	// creator/aggregate data until the response has actually been written.
	var version int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(r.version,0) FROM group_events e
 LEFT JOIN group_event_responses r ON r.event_id=e.id AND r.membership_id=? AND r.user_id=?
 WHERE e.group_id=? AND e.id=?`, current, viewer, gid, id).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return GroupEvent{}, ErrNotFound
	}
	if err != nil {
		return GroupEvent{}, err
	}
	if version != expected {
		return GroupEvent{}, ErrStaleEventResponse
	}
	if version == MaxSocialID {
		return GroupEvent{}, contentField("expected_version", "INVALID_ID")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO group_event_responses(event_id,user_id,membership_id,choice,version) VALUES(?,?,?,?,?)
 ON CONFLICT(event_id,membership_id) DO UPDATE SET choice=excluded.choice,version=excluded.version,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`, id, viewer, current, choice, version+1)
	if err != nil {
		return GroupEvent{}, err
	}
	e, err := eventInTx(ctx, tx, viewer, gid, id)
	if err != nil {
		return e, err
	}
	members := recipientSet{}
	if err := members.addMembers(ctx, tx, gid); err != nil {
		return e, err
	}
	if err := tx.Commit(); err != nil {
		return e, err
	}
	fireSocialInvalidation(members.sorted()...)
	return e, nil
}
