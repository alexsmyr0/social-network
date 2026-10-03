package db

import (
	"context"
	"database/sql"
	"errors"
	"github.com/mattn/go-sqlite3"
)

var (
	ErrSelfFollow   = errors.New("cannot follow self")
	ErrStaleFollow  = errors.New("relationship changed")
	ErrStaleProfile = errors.New("profile changed")
)

type Follow struct {
	ID         int64   `json:"id"`
	FollowerID int64   `json:"follower_id"`
	FollowedID int64   `json:"followed_id"`
	State      string  `json:"state"`
	CreatedAt  string  `json:"created_at"`
	AcceptedAt *string `json:"accepted_at"`
}
type PrivacyChange struct {
	Profile  Profile
	Changed  bool
	Accepted []Follow
}

// BeginSocialWrite obtains SQLite's write lock before any state read. A zero-row
// UPDATE starts a write transaction without changing rows or firing row triggers.
// Reads elsewhere remain deferred snapshots. B12 can add notices in this same Tx.
func BeginSocialWrite(ctx context.Context, database *sql.DB) (*sql.Tx, error) {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE follows SET id=id WHERE 0`); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}
func IsTemporaryDatabaseError(err error) bool {
	var e sqlite3.Error
	return errors.As(err, &e) && (e.Code == sqlite3.ErrBusy || e.Code == sqlite3.ErrLocked)
}
func followInTx(ctx context.Context, tx *sql.Tx, id int64) (Follow, error) {
	var f Follow
	var accepted sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT id,follower_id,followed_id,state,created_at,accepted_at FROM follows WHERE id=?`, id).Scan(&f.ID, &f.FollowerID, &f.FollowedID, &f.State, &f.CreatedAt, &accepted)
	if errors.Is(err, sql.ErrNoRows) {
		return f, ErrStaleFollow
	}
	if err != nil {
		return f, err
	}
	if accepted.Valid {
		f.AcceptedAt = &accepted.String
	}
	return f, nil
}
func activeFollowParticipants(ctx context.Context, tx *sql.Tx, f Follow) error {
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id IN (?,?) AND is_active=1`, f.FollowerID, f.FollowedID).Scan(&count); err != nil {
		return err
	}
	if count != 2 {
		return ErrNotFound
	}
	return nil
}

// CreateFollowTx requires a transaction from BeginSocialWrite; the caller owns commit.
func CreateFollowTx(ctx context.Context, tx *sql.Tx, viewer, target int64) (Follow, bool, error) {
	if viewer == target {
		return Follow{}, false, ErrSelfFollow
	}
	var visibility string
	err := tx.QueryRowContext(ctx, `SELECT profile_visibility FROM users WHERE id=? AND is_active=1 AND EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, target, viewer).Scan(&visibility)
	if errors.Is(err, sql.ErrNoRows) {
		return Follow{}, false, ErrNotFound
	}
	if err != nil {
		return Follow{}, false, err
	}
	var existing int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM follows WHERE follower_id=? AND followed_id=?`, viewer, target).Scan(&existing)
	if err == nil {
		f, err := followInTx(ctx, tx, existing)
		return f, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Follow{}, false, err
	}
	state := "pending"
	if visibility == "public" {
		state = "accepted"
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO follows(follower_id,followed_id,state,accepted_at) VALUES (?,?,?,CASE WHEN ?='accepted' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END)`, viewer, target, state, state)
	if err != nil {
		return Follow{}, false, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Follow{}, false, err
	}
	f, err := followInTx(ctx, tx, id)
	return f, true, err
}
func CreateFollow(ctx context.Context, database *sql.DB, viewer, target int64) (Follow, bool, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Follow{}, false, err
	}
	defer tx.Rollback()
	f, created, err := CreateFollowTx(ctx, tx, viewer, target)
	if err != nil {
		return f, false, err
	}
	return f, created, tx.Commit()
}

// RemoveFollowTx returns the removed identity/state for B12 notice reconciliation.
// B15 extends this transaction to remove selections when that schema exists.
func RemoveFollowTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Follow, error) {
	f, err := followInTx(ctx, tx, id)
	if err != nil {
		return f, err
	}
	if f.FollowerID != viewer {
		return f, ErrNotFound
	}
	if err := activeFollowParticipants(ctx, tx, f); err != nil {
		return f, err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM follows WHERE id=?`, id)
	return f, err
}
func RemoveFollow(ctx context.Context, database *sql.DB, viewer, id int64) (Follow, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Follow{}, err
	}
	defer tx.Rollback()
	f, err := RemoveFollowTx(ctx, tx, viewer, id)
	if err != nil {
		return f, err
	}
	return f, tx.Commit()
}
func DecideFollowTx(ctx context.Context, tx *sql.Tx, viewer, id int64, decision string) (Follow, error) {
	if decision != "accept" && decision != "decline" {
		return Follow{}, ErrInvalidInput
	}
	f, err := followInTx(ctx, tx, id)
	if err != nil {
		return f, err
	}
	if f.FollowedID != viewer {
		return f, ErrNotFound
	}
	if err := activeFollowParticipants(ctx, tx, f); err != nil {
		return f, err
	}
	if f.State == "accepted" {
		if decision == "accept" {
			return f, nil
		}
		return f, ErrStaleFollow
	}
	if decision == "decline" {
		_, err = tx.ExecContext(ctx, `DELETE FROM follows WHERE id=?`, id)
		return f, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE follows SET state='accepted',accepted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, id); err != nil {
		return f, err
	}
	return followInTx(ctx, tx, id)
}
func DecideFollow(ctx context.Context, database *sql.DB, viewer, id int64, decision string) (Follow, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Follow{}, err
	}
	defer tx.Rollback()
	f, err := DecideFollowTx(ctx, tx, viewer, id, decision)
	if err != nil {
		return f, err
	}
	return f, tx.Commit()
}
func ChangePrivacyTx(ctx context.Context, tx *sql.Tx, viewer int64, visibility string, expected int64) (PrivacyChange, error) {
	result := PrivacyChange{Accepted: []Follow{}}
	if visibility != "public" && visibility != "private" {
		return result, ErrInvalidInput
	}
	var current string
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT profile_visibility,profile_version FROM users WHERE id=? AND is_active=1`, viewer).Scan(&current, &version)
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if expected != version {
		return result, ErrStaleProfile
	}
	if current != visibility {
		if visibility == "public" {
			rows, err := tx.QueryContext(ctx, `SELECT id FROM follows WHERE followed_id=? AND state='pending'`, viewer)
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
			if _, err := tx.ExecContext(ctx, `UPDATE follows SET state='accepted',accepted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE followed_id=? AND state='pending'`, viewer); err != nil {
				return result, err
			}
			for _, id := range ids {
				f, err := followInTx(ctx, tx, id)
				if err != nil {
					return result, err
				}
				result.Accepted = append(result.Accepted, f)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET profile_visibility=?,profile_version=profile_version+1 WHERE id=?`, visibility, viewer); err != nil {
			return result, err
		}
		result.Changed = true
	}
	result.Profile, err = profileInTx(ctx, tx, viewer, viewer)
	return result, err
}
func ChangePrivacy(ctx context.Context, database *sql.DB, viewer int64, visibility string, expected int64) (PrivacyChange, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return PrivacyChange{}, err
	}
	defer tx.Rollback()
	result, err := ChangePrivacyTx(ctx, tx, viewer, visibility, expected)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}
