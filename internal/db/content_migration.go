package db

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"

	"github.com/golang-migrate/migrate/v4/database"
)

// Only the approved rebuild opts out of the ordinary driver's transaction.
// Startup has no application writers. Conn pins PRAGMA state to this connection;
// SetVersion still uses the driver, retaining dirty-version recovery semantics.
type contentMigrationDriver struct {
	database.Driver
	db  *sql.DB
	ctx context.Context
}

func (d *contentMigrationDriver) Run(r io.Reader) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	s := string(b)
	if !strings.HasPrefix(s, "-- B15: connection-pinned rebuild;") {
		return d.Driver.Run(strings.NewReader(s))
	}
	return rebuildContent(d.ctx, d.db, s)
}

// Context-scoped failure seam lets upgrade tests exercise boundaries without
// global hooks or changing SQL shipped to production.
type contentMigrationFaultKey struct{}

func contentMigrationCheckpoint(ctx context.Context, stage string) error {
	if fault, ok := ctx.Value(contentMigrationFaultKey{}).(func(string) error); ok {
		return fault(stage)
	}
	return nil
}
func rebuildContent(ctx context.Context, db *sql.DB, script string) (err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer func() {
		// Restoration must run even if startup's context was cancelled.
		_, restore := conn.ExecContext(context.Background(), `PRAGMA foreign_keys=ON`)
		var enabled int
		if restore == nil {
			restore = conn.QueryRowContext(context.Background(), `PRAGMA foreign_keys`).Scan(&enabled)
		}
		if restore != nil || enabled != 1 {
			err = fmt.Errorf("restore migration foreign keys: enabled=%d error=%v (migration error=%v)", enabled, restore, err)
		}
	}()
	var enabled int
	if err = conn.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&enabled); err != nil || enabled != 0 {
		return fmt.Errorf("disable migration foreign keys: %d %v", enabled, err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var sequence int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name='posts'`).Scan(&sequence); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT sql FROM sqlite_master WHERE tbl_name='posts' AND type IN('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
	if err != nil {
		return err
	}
	objects := []string{}
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			rows.Close()
			return err
		}
		objects = append(objects, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	parts := strings.Split(script, "-- B15 SWAP")
	if len(parts) != 2 {
		return fmt.Errorf("invalid content rebuild phases")
	}
	if err = contentMigrationCheckpoint(ctx, "before-copy"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, parts[0]); err != nil {
		return err
	}
	var sameCount bool
	if err = tx.QueryRowContext(ctx, `SELECT (SELECT COUNT(*) FROM posts)=(SELECT COUNT(*) FROM posts_b15)`).Scan(&sameCount); err != nil {
		return err
	}
	if !sameCount {
		return fmt.Errorf("content rebuild row count mismatch")
	}
	const cols = `id,author_id,title,image_url,body,status,created_at,updated_at`
	for _, pair := range [][2]string{{"posts", "posts_b15"}, {"posts_b15", "posts"}} {
		var differences int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM(SELECT `+cols+` FROM `+pair[0]+` EXCEPT SELECT `+cols+` FROM `+pair[1]+`)`).Scan(&differences); err != nil {
			return err
		}
		if differences != 0 {
			return fmt.Errorf("content rebuild lost %d rows", differences)
		}
	}
	if err = contentMigrationCheckpoint(ctx, "before-swap"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, parts[1]); err != nil {
		return err
	}
	for _, s := range objects {
		if _, err = tx.ExecContext(ctx, s); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='posts'`, sequence); err != nil {
		return err
	}
	if err = contentMigrationCheckpoint(ctx, "before-check"); err != nil {
		return err
	}
	rows, err = tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	violations := rows.Next()
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if violations {
		return fmt.Errorf("content rebuild foreign key violation")
	}
	if err = contentMigrationCheckpoint(ctx, "before-commit"); err != nil {
		return err
	}
	return tx.Commit()
}
