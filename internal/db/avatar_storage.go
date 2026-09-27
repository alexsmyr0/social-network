package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AvatarRoot keeps database and private media together unless MEDIA_ROOT is set.
func AvatarRoot(database *sql.DB) (string, error) {
	if root := os.Getenv("MEDIA_ROOT"); root != "" {
		return root, nil
	}
	rows, err := database.Query(`PRAGMA database_list`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var seq int
		var name, path string
		if err := rows.Scan(&seq, &name, &path); err != nil {
			return "", err
		}
		if name == "main" && path != "" {
			return filepath.Join(filepath.Dir(path), "media"), nil
		}
	}
	return "", fmt.Errorf("database has no persistent path; set MEDIA_ROOT")
}

// PrepareAvatarStorage runs before HTTP readiness. Files without committed
// references, including crash leftovers, are never served and are removed.
func PrepareAvatarStorage(ctx context.Context, database *sql.DB) error {
	root, err := AvatarRoot(database)
	if err != nil {
		return err
	}
	objects := filepath.Join(root, "objects")
	if err := os.MkdirAll(objects, 0700); err != nil {
		return fmt.Errorf("create avatar storage: %w", err)
	}
	if err := os.Chmod(root, 0700); err != nil {
		return err
	}
	if err := os.Chmod(objects, 0700); err != nil {
		return err
	}
	// A write probe catches read-only mounts before the server starts accepting requests.
	probe, err := os.CreateTemp(root, ".probe-")
	if err != nil {
		return fmt.Errorf("avatar storage is not writable: %w", err)
	}
	probe.Close()
	if err := os.Remove(probe.Name()); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tmp-") {
			if err := os.RemoveAll(filepath.Join(root, entry.Name())); err != nil {
				return err
			}
		}
	}
	used := map[string]bool{}
	rows, err := database.QueryContext(ctx, `SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		used[key] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	files, err := os.ReadDir(objects)
	if err != nil {
		return err
	}
	for _, file := range files {
		if !used[file.Name()] {
			if err := os.RemoveAll(filepath.Join(objects, file.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
