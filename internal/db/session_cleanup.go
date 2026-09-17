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

	_, err := db.ExecContext(ctx, `
		DELETE FROM sessions
		WHERE is_valid = 0
		   OR expires_at <= datetime('now')
	`)
	return err
}
