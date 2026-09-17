// internal/db/db.go
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

/*---------------
  EMBEDED FILES
---------------*/

//go:embed forum_schema.sql
var schemaFS embed.FS

//go:embed bootstrap/default_categories.sql
var categoriesSeed string

//go:embed seeds/*.sql
var qaSeedFS embed.FS

// InitDB opens/creates the SQLite database,
// applies PRAGMA options via DSN,
// loads the embedded schema,
// seeds default categories,
// and returns a ready-to-use *sql.DB.
func InitDB(ctx context.Context, dbPath string) (*sql.DB, error) {

	dsn := fmt.Sprintf(
		"%s?_foreign_keys=on&_journal_mode=WAL&_busy_timeout=5000&_synchronous=NORMAL",
		dbPath,
	)

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, WrapError("open database", err)
	}

	// Ensure the database is reachable
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, WrapError("ping database", err)
	}

	/*----------------------
	  LOAD EMBEDED SCHEMA
	----------------------*/

	schema, err := schemaFS.ReadFile("forum_schema.sql")
	if err != nil {
		db.Close()
		return nil, WrapError("read schema file", err)
	}

	if _, err := db.ExecContext(ctx, string(schema)); err != nil {
		db.Close()
		return nil, WrapError("apply schema", MapSQLError(err))
	}

	/*------------------------------------------------------------
	  MIGRATE LEGACY DATABASES
	  -----------------------
	  forum_schema.sql uses CREATE TABLE IF NOT EXISTS, which is
	  a no-op for tables that pre-date the current schema. Migrate
	  adds any columns missing from existing tables so a database
	  created by an older revision of the app keeps working after
	  upgrade. No-op on fresh databases.
	------------------------------------------------------------*/

	if err := Migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}

	/*-----------------
	  SEED CATEGORIES
	-----------------*/

	if categoriesSeed != "" {
		if _, err := db.ExecContext(ctx, categoriesSeed); err != nil {
			db.Close()
			return nil, WrapError("seed categories", MapSQLError(err))
		}
	}

	return db, nil
}

// ApplyQASeeds resets QA-owned tables and loads deterministic sample data.
// Categories are intentionally excluded because they are bootstrap data.
func ApplyQASeeds(ctx context.Context, db *sql.DB) error {
	seedFiles, err := fs.Glob(qaSeedFS, "seeds/*.sql")
	if err != nil {
		return WrapError("glob qa seed files", err)
	}

	sort.Strings(seedFiles)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return WrapError("begin qa seed transaction", err)
	}
	defer tx.Rollback()

	for _, seedFile := range seedFiles {
		sqlBytes, err := qaSeedFS.ReadFile(seedFile)
		if err != nil {
			return WrapError("read "+seedFile, err)
		}

		sqlText := strings.TrimSpace(string(sqlBytes))
		if sqlText == "" {
			continue
		}

		if _, err := tx.ExecContext(ctx, sqlText); err != nil {
			return WrapError("apply "+seedFile, MapSQLError(err))
		}
	}

	if err := tx.Commit(); err != nil {
		return WrapError("commit qa seed transaction", err)
	}

	return nil
}
