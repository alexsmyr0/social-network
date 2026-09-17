// internal/db/sessions.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

const (
	sessionTimeout  = 2 * time.Second
	sessionDuration = 12 * time.Hour
)

type Session struct {
	ID             int64
	UserID         int64
	Token          string
	SessionVersion int
	CreatedAt      time.Time
	ExpiresAt      time.Time
	IP             string
	UserAgent      string
	IsValid        bool
}

type SessionData struct {
	UserID         int64
	SessionVersion int
}

/*------------
  PUBLIC API
------------*/

func CreateSession(
	ctx context.Context,
	db *sql.DB,
	userID int64,
	ip,
	userAgent string,
) (Session, error) {

	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, err
	}
	defer tx.Rollback()

	version, err := bumpSessionVersionTx(ctx, tx, userID)
	if err != nil {
		return Session{}, err
	}

	if err := invalidateUserSessionsTx(ctx, tx, userID); err != nil {
		return Session{}, err
	}

	token := generateSessionToken()
	expiresAt := time.Now().Add(sessionDuration)

	id, err := insertSessionTx(
		ctx,
		tx,
		userID,
		token,
		expiresAt,
		ip,
		userAgent,
	)
	if err != nil {
		return Session{}, err
	}

	if err := tx.Commit(); err != nil {
		return Session{}, err
	}

	return Session{
		ID:             id,
		UserID:         userID,
		Token:          token,
		SessionVersion: version,
		ExpiresAt:      expiresAt,
		IP:             ip,
		UserAgent:      userAgent,
		IsValid:        true,
	}, nil
}

func GetSessionByToken(
	ctx context.Context,
	db *sql.DB,
	token string,
) (Session, error) {

	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()

	return fetchValidSession(ctx, db, token)
}

func InvalidateSessionByToken(
	ctx context.Context,
	db *sql.DB,
	token string,
) error {

	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()

	if _, err := db.ExecContext(ctx,
		`UPDATE sessions SET is_valid = 0 WHERE token = ?`,
		token,
	); err != nil {
		return fmt.Errorf("invalidate session: %w", err)
	}

	return nil
}

/*-------------------
  HELPERS (TX SAFE)
-------------------*/

func invalidateUserSessionsTx(
	ctx context.Context,
	tx *sql.Tx,
	userID int64,
) error {

	if _, err := tx.ExecContext(ctx,
		`UPDATE sessions SET is_valid = 0 WHERE user_id = ? AND is_valid = 1`,
		userID,
	); err != nil {
		return fmt.Errorf("invalidate old sessions: %w", err)
	}

	return nil
}

func insertSessionTx(
	ctx context.Context,
	tx *sql.Tx,
	userID int64,
	token string,
	expiresAt time.Time,
	ip,
	userAgent string,
) (int64, error) {

	result, err := tx.ExecContext(ctx,
		`INSERT INTO sessions (user_id, token, expires_at, ip, user_agent)
		 VALUES (?, ?, ?, ?, ?)`,
		userID,
		token,
		expiresAt.UTC().Format(time.RFC3339),
		ip,
		userAgent,
	)
	if err != nil {
		return 0, fmt.Errorf("create session: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("last insert id: %w", err)
	}

	return id, nil
}

func fetchValidSession(
	ctx context.Context,
	db *sql.DB,
	token string,
) (Session, error) {

	const query = `
		SELECT
			s.id,
			s.user_id,
			s.token,
			s.created_at,
			s.expires_at,
			s.ip,
			s.user_agent,
			u.session_version
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token = ?
		  AND s.is_valid = 1
		  AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')
	`

	var session Session
	var createdRaw, expiresRaw string
	var dbSessionVersion int

	err := db.QueryRowContext(ctx, query, token).Scan(
		&session.ID,
		&session.UserID,
		&session.Token,
		&createdRaw,
		&expiresRaw,
		&session.IP,
		&session.UserAgent,
		&dbSessionVersion,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return Session{}, fmt.Errorf("session not found")
		}
		return Session{}, fmt.Errorf("get session: %w", err)
	}

	// Parse timestamps
	session.CreatedAt, _ = time.Parse(time.RFC3339, createdRaw)
	session.ExpiresAt, _ = time.Parse(time.RFC3339, expiresRaw)

	// enforce single active session
	if session.SessionVersion != 0 && session.SessionVersion != dbSessionVersion {
		return Session{}, fmt.Errorf("session superseded")
	}

	session.SessionVersion = dbSessionVersion
	session.IsValid = true

	return session, nil
}

func generateSessionToken() string {
	return uuid.New().String()
}

func bumpSessionVersionTx(
	ctx context.Context,
	tx *sql.Tx,
	userID int64,
) (int, error) {

	if _, err := tx.ExecContext(ctx,
		`UPDATE users
		 SET session_version = session_version + 1
		 WHERE id = ?`,
		userID,
	); err != nil {
		return 0, err
	}

	var newVersion int
	if err := tx.QueryRowContext(ctx,
		`SELECT session_version FROM users WHERE id = ?`,
		userID,
	).Scan(&newVersion); err != nil {
		return 0, err
	}

	return newVersion, nil
}
