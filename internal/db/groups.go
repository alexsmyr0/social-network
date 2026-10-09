package db

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

// Group state is separate from content. Members see membership, never a
// guarantee of profile access; every writer takes BeginSocialWrite before it
// reads membership or entry state, repeats role checks and only then commits.
var (
	ErrAlreadyMember      = errors.New("already a member")
	ErrSelfInvite         = errors.New("cannot invite self")
	ErrCreatorCannotLeave = errors.New("creator cannot leave")
	ErrStaleInvitation    = errors.New("invitation changed")
	ErrStaleJoinRequest   = errors.New("join request changed")
	ErrStaleMembership    = errors.New("membership changed")
)

type GroupPerson struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"display_name"`
}
type GroupViewerInvitation struct {
	ID        int64       `json:"id"`
	CreatedAt string      `json:"created_at"`
	Inviter   GroupPerson `json:"inviter"`
}
type GroupViewerRequest struct {
	ID        int64  `json:"id"`
	CreatedAt string `json:"created_at"`
}
type GroupViewer struct {
	Role         string                  `json:"role"`
	MembershipID *int64                  `json:"membership_id"`
	Invitations  []GroupViewerInvitation `json:"invitations"`
	JoinRequest  *GroupViewerRequest     `json:"join_request"`
}

// Group is the role-dependent discovery shape: member_count exists only for members.
type Group struct {
	ID          int64       `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	CreatedAt   string      `json:"created_at"`
	Creator     GroupPerson `json:"creator"`
	MemberCount *int        `json:"member_count,omitempty"`
	Viewer      GroupViewer `json:"viewer"`
}
type GroupSummary struct {
	ID          int64       `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Creator     GroupPerson `json:"creator"`
}
type Membership struct {
	ID       int64  `json:"id"`
	GroupID  int64  `json:"group_id"`
	UserID   int64  `json:"user_id"`
	Role     string `json:"role"`
	JoinedAt string `json:"joined_at"`
}
type MemberInfo struct {
	ID       int64  `json:"id"`
	Role     string `json:"role"`
	JoinedAt string `json:"joined_at"`
}
type GroupMember struct {
	Person
	Membership MemberInfo `json:"membership"`
}
type GroupInvitation struct {
	ID        int64        `json:"id"`
	CreatedAt string       `json:"created_at"`
	Group     GroupSummary `json:"group"`
	Inviter   Person       `json:"inviter"`
	Invitee   Person       `json:"invitee"`
}
type GroupJoinRequest struct {
	ID        int64        `json:"id"`
	CreatedAt string       `json:"created_at"`
	Group     GroupSummary `json:"group"`
	Requester Person       `json:"requester"`
}
type GroupPage struct {
	Items []Group
	Total int
}
type GroupMemberPage struct {
	Items []GroupMember
	Total int
}
type GroupInvitationPage struct {
	Items []GroupInvitation
	Total int
}
type GroupJoinRequestPage struct {
	Items []GroupJoinRequest
	Total int
}

type groupQuerier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// GroupMemberSQL is the shared membership predicate for B19: it is true when the
// user named by userExpr is an active current member of the group named by groupExpr.
func GroupMemberSQL(groupExpr, userExpr string) string {
	return `EXISTS(SELECT 1 FROM group_memberships gm_ JOIN users mu_ ON mu_.id=gm_.user_id AND mu_.is_active=1
 WHERE gm_.group_id=` + groupExpr + ` AND gm_.user_id=` + userExpr + `)`
}

// IsGroupMember reports current active membership.
func IsGroupMember(ctx context.Context, q groupQuerier, viewer, group int64) (bool, error) {
	var member bool
	err := q.QueryRowContext(ctx, `SELECT `+GroupMemberSQL("?1", "?2"), group, viewer).Scan(&member)
	return member, err
}

func groupPersonName(first, last string, nickname sql.NullString) string {
	var nick *string
	if nickname.Valid {
		nick = &nickname.String
	}
	return displayName(first, last, nick)
}

func activeUser(ctx context.Context, q groupQuerier, id int64) (bool, error) {
	var active bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, id).Scan(&active)
	return active, err
}

func groupCreatorRef(ctx context.Context, q groupQuerier, gid int64) (GroupPerson, error) {
	var p GroupPerson
	var first, last string
	var nick sql.NullString
	err := q.QueryRowContext(ctx, `SELECT c.id,c.first_name,c.last_name,c.nickname FROM groups g
 JOIN users c ON c.id=g.creator_id AND c.is_active=1 WHERE g.id=?`, gid).Scan(&p.ID, &first, &last, &nick)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	p.DisplayName = groupPersonName(first, last, nick)
	return p, err
}

func groupSummaryInTx(ctx context.Context, q groupQuerier, gid int64) (GroupSummary, error) {
	s := GroupSummary{ID: gid}
	err := q.QueryRowContext(ctx, `SELECT title,description FROM groups WHERE id=?`, gid).Scan(&s.Title, &s.Description)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	if err != nil {
		return s, err
	}
	s.Creator, err = groupCreatorRef(ctx, q, gid)
	return s, err
}

// groupInTx projects one group for the viewer. A group whose creator account is
// inactive is hidden like every other inactive participant.
func groupInTx(ctx context.Context, q groupQuerier, viewer, gid int64) (Group, error) {
	g := Group{ID: gid, Viewer: GroupViewer{Role: "none", Invitations: []GroupViewerInvitation{}}}
	if ok, err := activeUser(ctx, q, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return g, err
	}
	err := q.QueryRowContext(ctx, `SELECT title,description,created_at FROM groups WHERE id=?`, gid).Scan(&g.Title, &g.Description, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return g, ErrNotFound
	}
	if err != nil {
		return g, err
	}
	if g.Creator, err = groupCreatorRef(ctx, q, gid); err != nil {
		return g, err
	}
	var membershipID int64
	var role string
	err = q.QueryRowContext(ctx, `SELECT id,role FROM group_memberships WHERE group_id=? AND user_id=?`, gid, viewer).Scan(&membershipID, &role)
	switch {
	case err == nil:
		g.Viewer.Role = role
		g.Viewer.MembershipID = &membershipID
		var count int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1 WHERE gm.group_id=?`, gid).Scan(&count); err != nil {
			return g, err
		}
		g.MemberCount = &count
		return g, nil
	case !errors.Is(err, sql.ErrNoRows):
		return g, err
	}
	rows, err := q.QueryContext(ctx, `SELECT i.id,i.created_at,u.id,u.first_name,u.last_name,u.nickname FROM group_invitations i
 JOIN users u ON u.id=i.inviter_id AND u.is_active=1
 JOIN group_memberships gm ON gm.group_id=i.group_id AND gm.user_id=i.inviter_id
 WHERE i.group_id=? AND i.invitee_id=? ORDER BY i.created_at,i.id`, gid, viewer)
	if err != nil {
		return g, err
	}
	for rows.Next() {
		var inv GroupViewerInvitation
		var first, last string
		var nick sql.NullString
		if err := rows.Scan(&inv.ID, &inv.CreatedAt, &inv.Inviter.ID, &first, &last, &nick); err != nil {
			rows.Close()
			return g, err
		}
		inv.Inviter.DisplayName = groupPersonName(first, last, nick)
		g.Viewer.Invitations = append(g.Viewer.Invitations, inv)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return g, err
	}
	var request GroupViewerRequest
	err = q.QueryRowContext(ctx, `SELECT id,created_at FROM group_join_requests WHERE group_id=? AND requester_id=?`, gid, viewer).Scan(&request.ID, &request.CreatedAt)
	if err == nil {
		g.Viewer.JoinRequest = &request
	} else if !errors.Is(err, sql.ErrNoRows) {
		return g, err
	}
	return g, nil
}

func collectIDs(rows *sql.Rows) ([]int64, error) {
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CreateGroup stores one group; the schema trigger inserts the creator membership.
func CreateGroup(ctx context.Context, database *sql.DB, viewer int64, title, description string) (Group, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback()
	if ok, err := activeUser(ctx, tx, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return Group{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO groups(creator_id,title,description,title_search) VALUES(?,?,?,?)`,
		viewer, title, description, strings.ToLower(title))
	if err != nil {
		return Group{}, err
	}
	gid, err := result.LastInsertId()
	if err != nil {
		return Group{}, err
	}
	group, err := groupInTx(ctx, tx, viewer, gid)
	if err != nil {
		return group, err
	}
	if group.Viewer.Role != "creator" {
		return group, errors.New("group creation lost creator membership")
	}
	if err := tx.Commit(); err != nil {
		return group, err
	}
	// Discovery lists change for everyone: empty recipients means all sockets.
	fireSocialInvalidation()
	return group, nil
}

func GetGroup(ctx context.Context, database *sql.DB, viewer, gid int64) (Group, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Group{}, err
	}
	defer tx.Rollback()
	group, err := groupInTx(ctx, tx, viewer, gid)
	if err != nil {
		return group, err
	}
	return group, tx.Commit()
}

// ListGroups browses every group with an active creator, newest first. q is a
// literal case-insensitive title substring.
func ListGroups(ctx context.Context, database *sql.DB, viewer int64, memberOnly bool, q string, page, perPage int) (GroupPage, error) {
	result := GroupPage{Items: []Group{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	where := `EXISTS(SELECT 1 FROM users v WHERE v.id=? AND v.is_active=1) AND EXISTS(SELECT 1 FROM users c WHERE c.id=g.creator_id AND c.is_active=1)`
	args := []any{viewer}
	if memberOnly {
		where += ` AND EXISTS(SELECT 1 FROM group_memberships gm WHERE gm.group_id=g.id AND gm.user_id=?)`
		args = append(args, viewer)
	}
	if q != "" {
		where += ` AND instr(g.title_search,?)>0`
		args = append(args, strings.ToLower(q))
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM groups g WHERE `+where, args...).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT g.id FROM groups g WHERE `+where+` ORDER BY g.created_at DESC,g.id DESC LIMIT ? OFFSET ?`,
		append(args, perPage, (page-1)*perPage)...)
	if err != nil {
		return result, err
	}
	ids, err := collectIDs(rows)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		g, err := groupInTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, g)
	}
	return result, tx.Commit()
}

func requireMember(ctx context.Context, q groupQuerier, viewer, gid int64, creatorOnly bool) error {
	var role string
	err := q.QueryRowContext(ctx, `SELECT gm.role FROM group_memberships gm
 JOIN users u ON u.id=gm.user_id AND u.is_active=1
 JOIN groups g ON g.id=gm.group_id
 JOIN users c ON c.id=g.creator_id AND c.is_active=1
 WHERE gm.group_id=? AND gm.user_id=?`, gid, viewer).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) || err == nil && creatorOnly && role != "creator" {
		return ErrNotFound
	}
	return err
}

// ListGroupMembers is members-only. Entries reuse People redaction: membership
// grants no extra profile access.
func ListGroupMembers(ctx context.Context, database *sql.DB, viewer, gid int64, page, perPage int) (GroupMemberPage, error) {
	result := GroupMemberPage{Items: []GroupMember{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, gid, false); err != nil {
		return result, err
	}
	const from = ` FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1 WHERE gm.group_id=?`
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, gid).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT gm.id,gm.user_id,gm.role,gm.joined_at`+from+` ORDER BY u.display_name_search,u.id LIMIT ? OFFSET ?`, gid, perPage, (page-1)*perPage)
	if err != nil {
		return result, err
	}
	type member struct {
		info MemberInfo
		user int64
	}
	members := []member{}
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.info.ID, &m.user, &m.info.Role, &m.info.JoinedAt); err != nil {
			rows.Close()
			return result, err
		}
		members = append(members, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, m := range members {
		person, err := personInTx(ctx, tx, viewer, m.user)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, GroupMember{Person: person, Membership: m.info})
	}
	return result, tx.Commit()
}

func invitationInTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (GroupInvitation, error) {
	var inv GroupInvitation
	var group, inviter, invitee int64
	err := tx.QueryRowContext(ctx, `SELECT group_id,inviter_id,invitee_id,created_at FROM group_invitations WHERE id=?`, id).Scan(&group, &inviter, &invitee, &inv.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return inv, ErrStaleInvitation
	}
	if err != nil {
		return inv, err
	}
	inv.ID = id
	if inv.Group, err = groupSummaryInTx(ctx, tx, group); err != nil {
		return inv, err
	}
	if inv.Inviter, err = personInTx(ctx, tx, viewer, inviter); err != nil {
		return inv, err
	}
	inv.Invitee, err = personInTx(ctx, tx, viewer, invitee)
	return inv, err
}

func joinRequestInTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (GroupJoinRequest, error) {
	var r GroupJoinRequest
	var group, requester int64
	err := tx.QueryRowContext(ctx, `SELECT group_id,requester_id,created_at FROM group_join_requests WHERE id=?`, id).Scan(&group, &requester, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrStaleJoinRequest
	}
	if err != nil {
		return r, err
	}
	r.ID = id
	if r.Group, err = groupSummaryInTx(ctx, tx, group); err != nil {
		return r, err
	}
	r.Requester, err = personInTx(ctx, tx, viewer, requester)
	return r, err
}

// ListGroupInvitations returns the caller's usable pending invitations. An
// invitation from an inactive or departed inviter is not usable and is omitted.
func ListGroupInvitations(ctx context.Context, database *sql.DB, viewer int64, page, perPage int) (GroupInvitationPage, error) {
	result := GroupInvitationPage{Items: []GroupInvitation{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	const from = ` FROM group_invitations i
 JOIN users v ON v.id=i.invitee_id AND v.is_active=1
 JOIN users a ON a.id=i.inviter_id AND a.is_active=1
 JOIN group_memberships gm ON gm.group_id=i.group_id AND gm.user_id=i.inviter_id
 JOIN groups g ON g.id=i.group_id
 JOIN users c ON c.id=g.creator_id AND c.is_active=1
 WHERE i.invitee_id=?`
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, viewer).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT i.id`+from+` ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?`, viewer, perPage, (page-1)*perPage)
	if err != nil {
		return result, err
	}
	ids, err := collectIDs(rows)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		inv, err := invitationInTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, inv)
	}
	return result, tx.Commit()
}

// ListGroupJoinRequests is creator-only; everyone else sees 404.
func ListGroupJoinRequests(ctx context.Context, database *sql.DB, viewer, gid int64, page, perPage int) (GroupJoinRequestPage, error) {
	result := GroupJoinRequestPage{Items: []GroupJoinRequest{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, gid, true); err != nil {
		return result, err
	}
	const from = ` FROM group_join_requests r JOIN users u ON u.id=r.requester_id AND u.is_active=1 WHERE r.group_id=?`
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, gid).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT r.id`+from+` ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?`, gid, perPage, (page-1)*perPage)
	if err != nil {
		return result, err
	}
	ids, err := collectIDs(rows)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		r, err := joinRequestInTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, r)
	}
	return result, tx.Commit()
}

// ---------------------------------------------------------------- transitions

type recipientSet map[int64]bool

func (s recipientSet) sorted() []int64 {
	ids := make([]int64, 0, len(s))
	for id := range s {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// addMembers adds every active member after the transition. Called only when a
// membership row was inserted or deleted, so member lists and permissions refresh.
func (s recipientSet) addMembers(ctx context.Context, tx *sql.Tx, gid int64) error {
	rows, err := tx.QueryContext(ctx, `SELECT gm.user_id FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1 WHERE gm.group_id=?`, gid)
	if err != nil {
		return err
	}
	ids, err := collectIDs(rows)
	for _, id := range ids {
		s[id] = true
	}
	return err
}

const (
	noticeInvitation  = "group_invitation"
	noticeJoinRequest = "group_join_request"
)

func insertGroupNotice(ctx context.Context, tx *sql.Tx, kind string, recipient, actor, group, entry int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)
 VALUES(?,?,?,?,?,'pending')`, recipient, actor, kind, group, entry)
	return err
}

// resolveGroupNotice records the entry's outcome in notice history and marks it
// read, in the transaction that deletes the entry. The users it names are added
// to the post-commit refresh set.
func resolveGroupNotice(ctx context.Context, tx *sql.Tx, kind string, entry int64, state string, named recipientSet) error {
	rows, err := tx.QueryContext(ctx, `SELECT recipient_id,actor_id FROM notifications WHERE type=? AND group_entry_id=?`, kind, entry)
	if err != nil {
		return err
	}
	for rows.Next() {
		var recipient, actor int64
		if err := rows.Scan(&recipient, &actor); err != nil {
			rows.Close()
			return err
		}
		named[recipient], named[actor] = true, true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE notifications SET group_state=?,is_read=1 WHERE type=? AND group_entry_id=?`, state, kind, entry)
	return err
}

func activeGroupMember(ctx context.Context, tx *sql.Tx, gid, user int64) (bool, string, error) {
	var role string
	err := tx.QueryRowContext(ctx, `SELECT gm.role FROM group_memberships gm JOIN users u ON u.id=gm.user_id AND u.is_active=1
 WHERE gm.group_id=? AND gm.user_id=?`, gid, user).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", nil
	}
	return err == nil, role, err
}

// CreateGroupInvitation lets a current member invite an active nonmember. The
// same inviter/invitee pair is idempotent; another inviter gets a separate entry.
func CreateGroupInvitation(ctx context.Context, database *sql.DB, viewer, gid, target int64) (GroupInvitation, bool, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupInvitation{}, false, err
	}
	defer tx.Rollback()
	if err := requireMember(ctx, tx, viewer, gid, false); err != nil {
		return GroupInvitation{}, false, err
	}
	if viewer == target {
		return GroupInvitation{}, false, ErrSelfInvite
	}
	if ok, err := activeUser(ctx, tx, target); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return GroupInvitation{}, false, err
	}
	if member, _, err := activeGroupMember(ctx, tx, gid, target); err != nil || member {
		if err == nil {
			err = ErrAlreadyMember
		}
		return GroupInvitation{}, false, err
	}
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM group_invitations WHERE group_id=? AND inviter_id=? AND invitee_id=?`, gid, viewer, target).Scan(&id)
	if err == nil {
		inv, err := invitationInTx(ctx, tx, viewer, id)
		return inv, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return GroupInvitation{}, false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id) VALUES(?,?,?)`, gid, viewer, target)
	if err != nil {
		return GroupInvitation{}, false, err
	}
	if id, err = result.LastInsertId(); err != nil {
		return GroupInvitation{}, false, err
	}
	if err := insertGroupNotice(ctx, tx, noticeInvitation, target, viewer, gid, id); err != nil {
		return GroupInvitation{}, false, err
	}
	inv, err := invitationInTx(ctx, tx, viewer, id)
	if err != nil {
		return inv, false, err
	}
	if err := tx.Commit(); err != nil {
		return inv, false, err
	}
	fireNotificationHook(target)
	fireSocialInvalidation(recipientSet{viewer: true, target: true}.sorted()...)
	return inv, true, nil
}

// CreateGroupJoinRequest records a nonmember's request; only the creator decides.
func CreateGroupJoinRequest(ctx context.Context, database *sql.DB, viewer, gid int64) (GroupJoinRequest, bool, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return GroupJoinRequest{}, false, err
	}
	defer tx.Rollback()
	if ok, err := activeUser(ctx, tx, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return GroupJoinRequest{}, false, err
	}
	if _, err := groupCreatorRef(ctx, tx, gid); err != nil {
		return GroupJoinRequest{}, false, err
	}
	if member, _, err := activeGroupMember(ctx, tx, gid, viewer); err != nil || member {
		if err == nil {
			err = ErrAlreadyMember
		}
		return GroupJoinRequest{}, false, err
	}
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM group_join_requests WHERE group_id=? AND requester_id=?`, gid, viewer).Scan(&id)
	if err == nil {
		r, err := joinRequestInTx(ctx, tx, viewer, id)
		return r, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return GroupJoinRequest{}, false, err
	}
	var creator int64
	if err := tx.QueryRowContext(ctx, `SELECT creator_id FROM groups WHERE id=?`, gid).Scan(&creator); err != nil {
		return GroupJoinRequest{}, false, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO group_join_requests(group_id,requester_id) VALUES(?,?)`, gid, viewer)
	if err != nil {
		return GroupJoinRequest{}, false, err
	}
	if id, err = result.LastInsertId(); err != nil {
		return GroupJoinRequest{}, false, err
	}
	if err := insertGroupNotice(ctx, tx, noticeJoinRequest, creator, viewer, gid, id); err != nil {
		return GroupJoinRequest{}, false, err
	}
	r, err := joinRequestInTx(ctx, tx, viewer, id)
	if err != nil {
		return r, false, err
	}
	if err := tx.Commit(); err != nil {
		return r, false, err
	}
	fireNotificationHook(creator)
	fireSocialInvalidation(recipientSet{viewer: true, creator: true}.sorted()...)
	return r, true, nil
}

// admit resolves the person's pending entries for the group (winner accepted,
// the others superseded), then inserts the one membership. The schema trigger is
// a backstop that deletes whatever remains.
func admit(ctx context.Context, tx *sql.Tx, gid, user, winningInvitation, winningRequest int64, named recipientSet) (Membership, error) {
	named[user] = true
	rows, err := tx.QueryContext(ctx, `SELECT id,inviter_id FROM group_invitations WHERE group_id=? AND invitee_id=?`, gid, user)
	if err != nil {
		return Membership{}, err
	}
	type entry struct{ id, inviter int64 }
	invitations := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.inviter); err != nil {
			rows.Close()
			return Membership{}, err
		}
		invitations = append(invitations, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Membership{}, err
	}
	for _, e := range invitations {
		state := "superseded"
		if e.id == winningInvitation {
			state = "accepted"
		}
		named[e.inviter] = true
		if err := resolveGroupNotice(ctx, tx, noticeInvitation, e.id, state, named); err != nil {
			return Membership{}, err
		}
	}
	var requestID int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM group_join_requests WHERE group_id=? AND requester_id=?`, gid, user).Scan(&requestID)
	if err == nil {
		state := "superseded"
		if requestID == winningRequest {
			state = "accepted"
		}
		if err := resolveGroupNotice(ctx, tx, noticeJoinRequest, requestID, state, named); err != nil {
			return Membership{}, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Membership{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO group_memberships(group_id,user_id,role) VALUES(?,?,'member')`, gid, user)
	if err != nil {
		return Membership{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Membership{}, err
	}
	var m Membership
	err = tx.QueryRowContext(ctx, `SELECT id,group_id,user_id,role,joined_at FROM group_memberships WHERE id=?`, id).Scan(&m.ID, &m.GroupID, &m.UserID, &m.Role, &m.JoinedAt)
	if err != nil {
		return m, err
	}
	return m, named.addMembers(ctx, tx, gid)
}

// DecideGroupInvitation is invitee-only and addresses the exact invitation ID.
// Accept returns the new membership; refuse returns the zero value.
func DecideGroupInvitation(ctx context.Context, database *sql.DB, viewer, id int64, decision string) (Membership, error) {
	if decision != "accept" && decision != "refuse" {
		return Membership{}, ErrInvalidInput
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Membership{}, err
	}
	defer tx.Rollback()
	var gid, inviter, invitee int64
	err = tx.QueryRowContext(ctx, `SELECT group_id,inviter_id,invitee_id FROM group_invitations WHERE id=?`, id).Scan(&gid, &inviter, &invitee)
	if errors.Is(err, sql.ErrNoRows) {
		return Membership{}, ErrStaleInvitation
	}
	if err != nil {
		return Membership{}, err
	}
	if invitee != viewer {
		return Membership{}, ErrNotFound
	}
	if ok, err := activeUser(ctx, tx, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return Membership{}, err
	}
	// An inviter who is no longer an active member cannot back a usable invitation.
	if member, _, err := activeGroupMember(ctx, tx, gid, inviter); err != nil || !member {
		if err == nil {
			err = ErrStaleInvitation
		}
		return Membership{}, err
	}
	named := recipientSet{viewer: true, inviter: true}
	var membership Membership
	if decision == "accept" {
		if member, _, err := activeGroupMember(ctx, tx, gid, viewer); err != nil || member {
			if err == nil {
				err = ErrAlreadyMember
			}
			return Membership{}, err
		}
		if membership, err = admit(ctx, tx, gid, viewer, id, 0, named); err != nil {
			return Membership{}, err
		}
	} else {
		if err := resolveGroupNotice(ctx, tx, noticeInvitation, id, "refused", named); err != nil {
			return Membership{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_invitations WHERE id=?`, id); err != nil {
			return Membership{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return membership, err
	}
	fireSocialInvalidation(named.sorted()...)
	return membership, nil
}

// DecideGroupJoinRequest is creator-only and addresses the exact request ID.
func DecideGroupJoinRequest(ctx context.Context, database *sql.DB, viewer, id int64, decision string) (Membership, error) {
	if decision != "accept" && decision != "refuse" {
		return Membership{}, ErrInvalidInput
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Membership{}, err
	}
	defer tx.Rollback()
	var gid, requester, creator int64
	err = tx.QueryRowContext(ctx, `SELECT r.group_id,r.requester_id,g.creator_id FROM group_join_requests r JOIN groups g ON g.id=r.group_id WHERE r.id=?`, id).Scan(&gid, &requester, &creator)
	if errors.Is(err, sql.ErrNoRows) {
		return Membership{}, ErrStaleJoinRequest
	}
	if err != nil {
		return Membership{}, err
	}
	if creator != viewer {
		return Membership{}, ErrNotFound
	}
	if ok, err := activeUser(ctx, tx, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return Membership{}, err
	}
	named := recipientSet{viewer: true, requester: true}
	var membership Membership
	if decision == "accept" {
		if ok, err := activeUser(ctx, tx, requester); err != nil || !ok {
			if err == nil {
				err = ErrStaleJoinRequest
			}
			return Membership{}, err
		}
		if member, _, err := activeGroupMember(ctx, tx, gid, requester); err != nil || member {
			if err == nil {
				err = ErrAlreadyMember
			}
			return Membership{}, err
		}
		if membership, err = admit(ctx, tx, gid, requester, 0, id, named); err != nil {
			return Membership{}, err
		}
	} else {
		if err := resolveGroupNotice(ctx, tx, noticeJoinRequest, id, "refused", named); err != nil {
			return Membership{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_join_requests WHERE id=?`, id); err != nil {
			return Membership{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return membership, err
	}
	fireSocialInvalidation(named.sorted()...)
	return membership, nil
}

// RemoveGroupMembership is leave when the row is the caller's and removal when
// the caller is the group's creator. The membership ID is the generation, so an
// old ID can never remove a returned member. The creator never leaves.
func RemoveGroupMembership(ctx context.Context, database *sql.DB, viewer, id int64) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var gid, member int64
	var role string
	err = tx.QueryRowContext(ctx, `SELECT group_id,user_id,role FROM group_memberships WHERE id=?`, id).Scan(&gid, &member, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrStaleMembership
	}
	if err != nil {
		return err
	}
	if ok, err := activeUser(ctx, tx, viewer); err != nil || !ok {
		if err == nil {
			err = ErrNotFound
		}
		return err
	}
	if member == viewer {
		if role == "creator" {
			return ErrCreatorCannotLeave
		}
	} else if isMember, actorRole, err := activeGroupMember(ctx, tx, gid, viewer); err != nil || !isMember || actorRole != "creator" {
		if err == nil {
			err = ErrNotFound
		}
		return err
	}
	named := recipientSet{member: true}
	rows, err := tx.QueryContext(ctx, `SELECT id,invitee_id FROM group_invitations WHERE group_id=? AND inviter_id=?`, gid, member)
	if err != nil {
		return err
	}
	type entry struct{ id, invitee int64 }
	cancelled := []entry{}
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.id, &e.invitee); err != nil {
			rows.Close()
			return err
		}
		cancelled = append(cancelled, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range cancelled {
		named[e.invitee] = true
		if err := resolveGroupNotice(ctx, tx, noticeInvitation, e.id, "cancelled", named); err != nil {
			return err
		}
	}
	// The departure trigger deletes the cancelled invitations in this statement.
	if _, err := tx.ExecContext(ctx, `DELETE FROM group_memberships WHERE id=?`, id); err != nil {
		return err
	}
	if err := named.addMembers(ctx, tx, gid); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation(named.sorted()...)
	return nil
}
