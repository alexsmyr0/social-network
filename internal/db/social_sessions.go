package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// IsSocialSchema keeps the versioned account policy separate from inherited
// forum fixtures, which still exercise the forum's single-session rules.
func IsSocialSchema(ctx context.Context, database *sql.DB) (bool, error) {
	var present bool
	err := database.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'schema_migrations')`).Scan(&present)
	return present, err
}

// CreateSessionForLogin replaces only the presented cookie after a successful
// social-account login. Both writes commit together; other devices stay signed in.
func CreateSessionForLogin(ctx context.Context, database *sql.DB, userID int64, priorToken, ip, userAgent string) (Session, error) {
	return createSocialSession(ctx, database, userID, priorToken, ip, userAgent)
}

func createSocialSession(ctx context.Context, database *sql.DB, userID int64, priorToken, ip, userAgent string) (Session, error) {
	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, fmt.Errorf("begin session: %w", err)
	}
	defer tx.Rollback()

	token := generateSessionToken()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO sessions (user_id, token, ip, user_agent)
		VALUES (?, ?, ?, ?)`, userID, token, ip, userAgent)
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	if priorToken != "" {
		if _, err := tx.ExecContext(ctx, `
			UPDATE sessions
			SET is_valid = 0, revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
			WHERE token = ? AND is_valid = 1 AND revoked_at IS NULL`, priorToken); err != nil {
			return Session{}, fmt.Errorf("replace presented session: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Session{}, fmt.Errorf("commit session: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Session{}, fmt.Errorf("session id: %w", err)
	}
	return Session{ID: id, UserID: userID, Token: token, IP: ip, UserAgent: userAgent, IsValid: true}, nil
}

func getSocialSession(ctx context.Context, database *sql.DB, token string) (Session, error) {
	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()
	var session Session
	var created string
	err := database.QueryRowContext(ctx, `
		SELECT s.id, s.user_id, s.token, s.created_at, s.ip, s.user_agent
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token = ? AND s.is_valid = 1 AND s.revoked_at IS NULL
		AND u.is_active = 1`, token).Scan(
		&session.ID, &session.UserID, &session.Token, &created, &session.IP, &session.UserAgent)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, fmt.Errorf("session not found: %w", ErrNotFound)
	}
	if err != nil {
		return Session{}, fmt.Errorf("get session: %w", err)
	}
	session.CreatedAt, err = time.Parse(time.RFC3339, created)
	if err != nil {
		return Session{}, fmt.Errorf("parse session time: %w", err)
	}
	session.IsValid = true
	return session, nil
}

func revokeSocialSession(ctx context.Context, database *sql.DB, token string) error {
	ctx, cancel := context.WithTimeout(ctx, sessionTimeout)
	defer cancel()
	_, err := database.ExecContext(ctx, `
		UPDATE sessions SET is_valid = 0,
			revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
		WHERE token = ? AND is_valid = 1 AND revoked_at IS NULL`, token)
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}
