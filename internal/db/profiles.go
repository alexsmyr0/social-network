package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

const MaxSocialID int64 = 9007199254740991

// ProfileReader allows permission checks to share the caller's snapshot/transaction.
type ProfileReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Relationship struct {
	State    string `json:"state"`
	FollowID *int64 `json:"follow_id"`
}

type Person struct {
	ID           int64        `json:"id"`
	DisplayName  string       `json:"display_name"`
	Access       string       `json:"access"`
	Relationship Relationship `json:"relationship"`
	// A pointer to a nullable URL distinguishes full-without-avatar from teaser omission.
	AvatarURL **string `json:"avatar_url,omitempty"`
}

type ProfileDetails struct {
	Email          string  `json:"email"`
	FirstName      string  `json:"first_name"`
	LastName       string  `json:"last_name"`
	DateOfBirth    string  `json:"date_of_birth"`
	Nickname       *string `json:"nickname"`
	AboutMe        *string `json:"about_me"`
	AvatarURL      *string `json:"avatar_url"`
	Visibility     string  `json:"visibility"`
	FollowersCount int     `json:"followers_count"`
	FollowingCount int     `json:"following_count"`
	Version        *int64  `json:"version,omitempty"`
}

type Profile struct {
	ID           int64           `json:"id"`
	DisplayName  string          `json:"display_name"`
	Access       string          `json:"access"`
	Relationship Relationship    `json:"relationship"`
	Details      *ProfileDetails `json:"profile,omitempty"`
}

type PeoplePage struct {
	Items []Person
	Total int
}
type FollowRequest struct {
	ID        int64  `json:"id"`
	CreatedAt string `json:"created_at"`
	Requester Person `json:"requester"`
}
type FollowRequestsPage struct {
	Items []FollowRequest
	Total int
}

const profilePermission = `(u.id = ? OR u.profile_visibility = 'public' OR EXISTS (
 SELECT 1 FROM follows pf WHERE pf.follower_id = ? AND pf.followed_id = u.id AND pf.state = 'accepted'))`

// CanViewProfile requires active viewer/subject and uses the same predicate as projections.
func CanViewProfile(ctx context.Context, q ProfileReader, viewer, subject int64) (bool, error) {
	var allowed bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u WHERE u.id = ? AND u.is_active = 1
 AND EXISTS(SELECT 1 FROM users v WHERE v.id = ? AND v.is_active = 1) AND `+profilePermission+`)`, subject, viewer, viewer, viewer).Scan(&allowed)
	return allowed, err
}

func displayName(first, last string, nickname *string) string {
	if nickname != nil && strings.TrimSpace(*nickname) != "" {
		return *nickname
	}
	return first + " " + last
}

// BackfillProfileSearch is restartable before readiness and leaves Phase 1-only fixtures alone.
func BackfillProfileSearch(ctx context.Context, database *sql.DB) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := backfillProfileSearchTx(ctx, tx); err != nil {
		return err
	}
	return tx.Commit()
}
func backfillProfileSearchTx(ctx context.Context, tx *sql.Tx) error {
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('users') WHERE name = 'display_name_search'`).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, first_name, last_name, nickname, display_name_search FROM users`)
	if err != nil {
		return err
	}
	type keyUpdate struct {
		id  int64
		key string
	}
	updates := []keyUpdate{}
	for rows.Next() {
		var id int64
		var first, last, key string
		var nickname sql.NullString
		if err := rows.Scan(&id, &first, &last, &nickname, &key); err != nil {
			rows.Close()
			return err
		}
		var nick *string
		if nickname.Valid {
			nick = &nickname.String
		}
		expected := strings.ToLower(displayName(first, last, nick))
		if expected == "" {
			rows.Close()
			return errors.New("empty profile search key")
		}
		if key != expected {
			updates = append(updates, keyUpdate{id, expected})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, u := range updates {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name_search = ? WHERE id = ?`, u.key, u.id); err != nil {
			return err
		}
	}
	return nil
}

func profileInTx(ctx context.Context, tx *sql.Tx, viewer, subject int64) (Profile, error) {
	var p Profile
	var d ProfileDetails
	var nick, about, avatar sql.NullString
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT id,email,first_name,last_name,date_of_birth,nickname,about_me,avatar_key,profile_visibility,profile_version
 FROM users WHERE id = ? AND is_active = 1 AND EXISTS(SELECT 1 FROM users WHERE id = ? AND is_active = 1)`, subject, viewer).Scan(
		&p.ID, &d.Email, &d.FirstName, &d.LastName, &d.DateOfBirth, &nick, &about, &avatar, &d.Visibility, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	if nick.Valid {
		d.Nickname = &nick.String
	}
	if about.Valid {
		d.AboutMe = &about.String
	}
	p.DisplayName = displayName(d.FirstName, d.LastName, d.Nickname)
	p.Relationship = Relationship{State: "none"}
	if viewer == subject {
		p.Relationship.State = "self"
	} else {
		var id int64
		var state string
		err = tx.QueryRowContext(ctx, `SELECT id,state FROM follows WHERE follower_id = ? AND followed_id = ?`, viewer, subject).Scan(&id, &state)
		if err == nil {
			p.Relationship = Relationship{state, &id}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return p, err
		}
	}
	allowed, err := CanViewProfile(ctx, tx, viewer, subject)
	if err != nil {
		return p, err
	}
	p.Access = "teaser"
	if !allowed {
		return p, nil
	}
	p.Access = "full"
	if avatar.Valid {
		url := fmt.Sprintf("/api/v1/users/%d/avatar", subject)
		d.AvatarURL = &url
	}
	if viewer == subject {
		d.Version = &version
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=? AND f.state='accepted' AND u.is_active=1`, subject).Scan(&d.FollowersCount); err != nil {
		return p, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM follows f JOIN users u ON u.id=f.followed_id WHERE f.follower_id=? AND f.state='accepted' AND u.is_active=1`, subject).Scan(&d.FollowingCount); err != nil {
		return p, err
	}
	p.Details = &d
	return p, nil
}
func GetProfile(ctx context.Context, database *sql.DB, viewer, subject int64) (Profile, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Profile{}, err
	}
	defer tx.Rollback()
	p, err := profileInTx(ctx, tx, viewer, subject)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func personInTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Person, error) {
	var p Person
	var first, last string
	var nickname, avatar, state sql.NullString
	var followID sql.NullInt64
	var allowed bool
	err := tx.QueryRowContext(ctx, `SELECT u.id,u.first_name,u.last_name,u.nickname,u.avatar_key,`+profilePermission+`,f.id,f.state
 FROM users u LEFT JOIN follows f ON f.follower_id=? AND f.followed_id=u.id
 WHERE u.id=? AND u.is_active=1 AND EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer, viewer, viewer, id, viewer).Scan(&p.ID, &first, &last, &nickname, &avatar, &allowed, &followID, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	if err != nil {
		return p, err
	}
	var nick *string
	if nickname.Valid {
		nick = &nickname.String
	}
	p.DisplayName = displayName(first, last, nick)
	p.Relationship = Relationship{State: "none"}
	if viewer == id {
		p.Relationship.State = "self"
	} else if followID.Valid {
		p.Relationship = Relationship{State: state.String, FollowID: &followID.Int64}
	}
	p.Access = "teaser"
	if allowed {
		p.Access = "full"
		var url *string
		if avatar.Valid {
			s := fmt.Sprintf("/api/v1/users/%d/avatar", id)
			url = &s
		}
		p.AvatarURL = &url
	}
	return p, nil
}

// ListPeople filters active subjects before pagination. Member projection is viewer-specific.
// kind is empty for discovery or followers/following for an authorized subject's list.
func ListPeople(ctx context.Context, database *sql.DB, viewer, subject int64, kind, q string, page, perPage int) (PeoplePage, error) {
	result := PeoplePage{Items: []Person{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	where := `u.is_active=1 AND EXISTS(SELECT 1 FROM users v WHERE v.id=? AND v.is_active=1)`
	args := []any{viewer}
	if kind != "" {
		allowed, err := CanViewProfile(ctx, tx, viewer, subject)
		if err != nil {
			return result, err
		}
		if !allowed {
			return result, ErrNotFound
		}
		switch kind {
		case "followers":
			where += ` AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=u.id AND f.followed_id=? AND f.state='accepted')`
		case "following":
			where += ` AND EXISTS(SELECT 1 FROM follows f WHERE f.followed_id=u.id AND f.follower_id=? AND f.state='accepted')`
		default:
			return result, ErrInvalidInput
		}
		args = append(args, subject)
	} else if q != "" {
		where += ` AND instr(u.display_name_search,?)>0`
		args = append(args, strings.ToLower(q))
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u WHERE `+where, args...).Scan(&result.Total); err != nil {
		return result, err
	}
	listArgs := append(append([]any{}, args...), perPage, (page-1)*perPage)
	rows, err := tx.QueryContext(ctx, `SELECT u.id FROM users u WHERE `+where+` ORDER BY u.display_name_search,u.id LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return result, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		person, err := personInTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, person)
	}
	return result, tx.Commit()
}
func ListFollowRequests(ctx context.Context, database *sql.DB, viewer int64, page, perPage int) (FollowRequestsPage, error) {
	result := FollowRequestsPage{Items: []FollowRequest{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	from := ` FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=? AND f.state='pending' AND u.is_active=1 AND EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, viewer, viewer).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT f.id,f.created_at,f.follower_id`+from+` ORDER BY f.created_at DESC,f.id DESC LIMIT ? OFFSET ?`, viewer, viewer, perPage, (page-1)*perPage)
	if err != nil {
		return result, err
	}
	type requestRow struct {
		id, actor int64
		created   string
	}
	items := []requestRow{}
	for rows.Next() {
		var item requestRow
		if err := rows.Scan(&item.id, &item.created, &item.actor); err != nil {
			rows.Close()
			return result, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, item := range items {
		person, err := personInTx(ctx, tx, viewer, item.actor)
		if err != nil {
			return result, err
		}
		result.Items = append(result.Items, FollowRequest{item.id, item.created, person})
	}
	return result, tx.Commit()
}
func ProfileAvatarKey(ctx context.Context, database *sql.DB, viewer, subject int64) (string, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	allowed, err := CanViewProfile(ctx, tx, viewer, subject)
	if err != nil {
		return "", err
	}
	if !allowed {
		return "", ErrNotFound
	}
	var key sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT avatar_key FROM users WHERE id=?`, subject).Scan(&key)
	if err != nil {
		return "", err
	}
	if !key.Valid {
		return "", ErrNotFound
	}
	return key.String, tx.Commit()
}
