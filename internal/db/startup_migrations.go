package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"

	"github.com/golang-migrate/migrate/v4"
	migratesqlite "github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

// applyStartupMigrations refuses an unversioned application database. The
// forum's procedural migration remains available only to legacy test fixtures.
func applyStartupMigrations(ctx context.Context, database *sql.DB, files fs.FS) error {
	var count int
	err := database.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		  AND name <> 'schema_migrations'
	`).Scan(&count)
	if err != nil {
		return fmt.Errorf("inspect database before migration: %w", err)
	}

	var versioned int
	err = database.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'schema_migrations'
	`).Scan(&versioned)
	if err != nil {
		return fmt.Errorf("inspect migration version: %w", err)
	}
	if count > 0 && versioned == 0 {
		return errors.New("unversioned database contains application tables; back it up and select a fresh DB_PATH (existing data was not changed)")
	}

	source, err := iofs.New(files, "migrations/sqlite")
	if err != nil {
		return fmt.Errorf("load embedded migrations: %w", err)
	}
	driver, err := migratesqlite.WithInstance(database, &migratesqlite.Config{})
	if err != nil {
		return fmt.Errorf("initialize SQLite migrations: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", source, "sqlite3", &contentMigrationDriver{Driver: driver, db: database, ctx: ctx})
	if err != nil {
		return fmt.Errorf("initialize migrations: %w", err)
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w; restore a backup or repair the recorded failed version explicitly", err)
	}
	return nil
}
