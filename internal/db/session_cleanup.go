// internal/db/session_cleanup.go
package db

import (
	"context"
	"database/sql"
	"time"
)

func CleanupSessions(
	ctx context.Context,
	db *sql.DB,
) error {

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	social, err := IsSocialSchema(ctx, db)
	if err != nil {
		return err
	}
	if social {
		_, err = db.ExecContext(ctx, `
			DELETE FROM sessions WHERE is_valid = 0 OR revoked_at IS NOT NULL`)
		return err
	}
	_, err = db.ExecContext(ctx, `
		DELETE FROM sessions
		WHERE is_valid = 0
		   OR expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
	`)
	return err
}
