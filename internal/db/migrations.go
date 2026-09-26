package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"

	"github.com/golang-migrate/migrate/v4"
	migratesqlite "github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed migrations/sqlite/*.sql
var migrationFiles embed.FS

var ErrLegacyDatabase = errors.New("unversioned database contains existing tables")

// rejectLegacyDatabase keeps the approved fresh-start policy explicit. A failed
// or completed numbered migration already has schema_migrations and is left to
// golang-migrate's version/dirty-state handling.
func rejectLegacyDatabase(ctx context.Context, conn *sql.DB) error {
	var versioned int
	if err := conn.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'schema_migrations'
	`).Scan(&versioned); err != nil {
		return fmt.Errorf("check migration version table: %w", err)
	}
	if versioned != 0 {
		return nil
	}

	var existing string
	err := conn.QueryRowContext(ctx, `
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		LIMIT 1
	`).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect existing database: %w", err)
	}
	return fmt.Errorf("%w (%s): back up the old database and choose a fresh DB_PATH; no data was deleted", ErrLegacyDatabase, existing)
}

func applyStartupMigrations(conn *sql.DB) error {
	return applyMigrationsFromFS(conn, migrationFiles)
}

func applyMigrationsFromFS(conn *sql.DB, files fs.FS) error {
	source, err := iofs.New(files, "migrations/sqlite")
	if err != nil {
		return fmt.Errorf("open embedded migrations: %w", err)
	}

	driver, err := migratesqlite.WithInstance(conn, &migratesqlite.Config{})
	if err != nil {
		return fmt.Errorf("open SQLite migration driver: %w", err)
	}

	runner, err := migrate.NewWithInstance("iofs", source, "sqlite3", driver)
	if err != nil {
		return fmt.Errorf("create migration runner: %w", err)
	}

	// runner.Close would close conn, which InitDB returns to the server. The
	// embedded source owns no OS handles; Up releases the SQLite migration lock.
	if err := runner.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply database migrations: %w", err)
	}
	return nil
}
