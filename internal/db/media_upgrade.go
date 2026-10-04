package db

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// LegacyUploadRoots may name every former frontend/backend upload mount (OS path
// list separator). Sources are read-only recovery evidence and are never swept.
func LegacyUploadRoots() []string {
	if value := os.Getenv("LEGACY_UPLOAD_ROOTS"); value != "" {
		return filepath.SplitList(value)
	}
	return []string{filepath.Join("web", "static", "uploads")}
}
func HasMediaSchema(ctx context.Context, q ProfileReader) (bool, error) {
	var exists bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='media_objects' AND type='table')`).Scan(&exists)
	return exists, err
}

// PrepareMediaStorage inventories every owner before recovering copies/sweeping.
// Missing/unmappable assets are reported and retained; I/O/DB faults refuse startup.
func PrepareMediaStorage(ctx context.Context, database *sql.DB, root string) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	type source struct {
		kind, column, raw string
		id                int64
	}
	sources := []source{}
	for _, entry := range []struct{ table, field, kind, column string }{{"users", "avatar_key", "avatar", "avatar_user_id"}, {"posts", "image_url", "post", "post_id"}, {"comments", "image_url", "comment", "comment_id"}, {"private_messages", "image_path", "message", "message_id"}} {
		rows, err := tx.QueryContext(ctx, `SELECT id,`+entry.field+` FROM `+entry.table+` WHERE `+entry.field+` IS NOT NULL`)
		if err != nil {
			return err
		}
		for rows.Next() {
			s := source{kind: entry.kind, column: entry.column}
			if err := rows.Scan(&s.id, &s.raw); err != nil {
				rows.Close()
				return err
			}
			sources = append(sources, s)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	for _, s := range sources {
		var id int64
		if parsed, ok := mediaID(s.raw); ok {
			id = parsed
			if _, err := mediaObjectTx(ctx, tx, id); err != nil {
				return fmt.Errorf("missing media manifest for %s %d: %w", s.kind, s.id, err)
			}
		} else {
			raw := s.raw
			sourceKey := "legacy:" + raw
			var legacy any
			key := uuid.NewString() + ".image"
			if s.kind == "avatar" {
				sourceKey = "avatar:" + raw
				key = raw
				if filepath.Base(raw) != raw || raw == "." || raw == ".." || strings.ContainsAny(raw, "\\\x00") {
					key = uuid.NewString() + ".image"
				}
			} else if normalized, ok := NormalizeLegacyMediaURL(raw); ok {
				sourceKey = "legacy:" + normalized
				legacy = normalized
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO media_objects(source_key,object_key,legacy_url) VALUES(?,?,?) ON CONFLICT(source_key) DO NOTHING`, sourceKey, key, legacy); err != nil {
				return err
			}
			if err := tx.QueryRowContext(ctx, `SELECT id FROM media_objects WHERE source_key=?`, sourceKey).Scan(&id); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO media_links(media_id,`+s.column+`) VALUES(?,?) ON CONFLICT(`+s.column+`) DO UPDATE SET media_id=excluded.media_id`, id, s.id); err != nil {
			return err
		}
	}
	// Only pre-readiness startup may remove abandoned content staging. DM staging
	// has no approved expiry and remains uploader-owned until attachment/recovery.
	if _, err := tx.ExecContext(ctx, `DELETE FROM media_pending WHERE kind='content'`); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	rows, err := database.QueryContext(ctx, `SELECT id FROM media_objects ORDER BY id`)
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := recoverMediaObject(ctx, database, root, id); err != nil {
			return err
		}
	}
	if err := reportLegacyOrphans(ctx, database); err != nil {
		return err
	}
	return CleanupMedia(ctx, database, true)
}
func inspectLegacyImage(reader io.ReadSeeker) (string, int64, error) {
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	header := make([]byte, 512)
	n, err := reader.Read(header)
	if err != nil && err != io.EOF {
		return "", 0, err
	}
	mime := http.DetectContentType(header[:n])
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" {
		return "", 0, ErrInvalidInput
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	config, _, err := image.DecodeConfig(bufio.NewReader(reader))
	if err != nil {
		return "", 0, ErrInvalidInput
	}
	if config.Width > 4096 || config.Height > 4096 {
		log.Printf("media recovery: retained oversized legacy image (%dx%d); review before reuse", config.Width, config.Height)
	}
	size, err := reader.Seek(0, io.SeekEnd)
	if err != nil {
		return "", 0, err
	}
	_, err = reader.Seek(0, io.SeekStart)
	return mime, size, err
}
func recoverMediaObject(ctx context.Context, database *sql.DB, root string, id int64) error {
	var key, source, state string
	var legacy sql.NullString
	if err := database.QueryRowContext(ctx, `SELECT object_key,source_key,state,legacy_url FROM media_objects WHERE id=?`, id).Scan(&key, &source, &state, &legacy); err != nil {
		return err
	}
	// A copied object can survive a crash before its DB state became ready.
	var sourceFile *os.File
	objects, err := os.OpenRoot(filepath.Join(root, "objects"))
	if err != nil {
		return err
	}
	existing, openErr := objects.Open(key)
	objects.Close()
	if openErr == nil {
		info, err := existing.Stat()
		if err != nil {
			existing.Close()
			return err
		}
		if info.Mode().IsRegular() {
			sourceFile = existing
		} else {
			existing.Close()
			return fmt.Errorf("nonregular media object %d", id)
		}
	} else if !os.IsNotExist(openErr) {
		return fmt.Errorf("open media object %d: %w", id, openErr)
	}
	conflicting := false
	if sourceFile == nil && legacy.Valid {
		relative := strings.TrimPrefix(legacy.String, "/static/uploads/")
		for _, base := range LegacyUploadRoots() {
			dir, err := os.OpenRoot(base)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			file, err := dir.Open(relative)
			dir.Close()
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return fmt.Errorf("open legacy media %d: %w", id, err)
			}
			info, err := file.Stat()
			if err != nil {
				file.Close()
				return err
			}
			if !info.Mode().IsRegular() {
				file.Close()
				return fmt.Errorf("nonregular legacy media %d", id)
			}
			if sourceFile == nil {
				sourceFile = file
			} else {
				a, err := fileDigest(sourceFile)
				if err != nil {
					file.Close()
					sourceFile.Close()
					return err
				}
				b, err := fileDigest(file)
				file.Close()
				if err != nil {
					sourceFile.Close()
					return err
				}
				if a != b {
					conflicting = true
				}
			}
		}
	}
	missing := func(reason string) error {
		// Resource IDs aid recovery without exposing filesystem keys in HTTP payloads.
		rows, err := database.QueryContext(ctx, `SELECT COALESCE(avatar_user_id,0),COALESCE(post_id,0),COALESCE(comment_id,0),COALESCE(message_id,0) FROM media_links WHERE media_id=?`, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var avatar, post, comment, message int64
			if err := rows.Scan(&avatar, &post, &comment, &message); err != nil {
				rows.Close()
				return err
			}
			log.Printf("media recovery: missing media_id=%d avatar_user=%d post=%d comment=%d message=%d reason=%s; restore source/private bytes and restart", id, avatar, post, comment, message, reason)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		_, err = database.ExecContext(ctx, `UPDATE media_objects SET state='missing' WHERE id=?`, id)
		return err
	}
	if conflicting {
		sourceFile.Close()
		return missing("conflicting legacy copies; retain all roots, select verified bytes explicitly")
	}
	if sourceFile == nil {
		return missing("source unavailable or unmappable")
	}
	defer sourceFile.Close()
	mime, size, err := inspectLegacyImage(sourceFile)
	if errors.Is(err, ErrInvalidInput) {
		return missing("unsupported/corrupt image; original retained")
	}
	if err != nil {
		return err
	}
	if size > 5<<20 {
		log.Printf("media recovery: retained legacy media_id=%d exceeds new upload byte budget", id)
	}
	if legacy.Valid && openErr != nil {
		if err := writeMediaBytes(root, key, sourceFile); err != nil {
			return fmt.Errorf("copy legacy media %d: %w", id, err)
		}
	}
	// Avatars keep their existing object key and URL. Unknown keys are never copied
	// or served by guessing a source; they remain recoverable missing records.
	if !legacy.Valid && !strings.HasPrefix(source, "avatar:") && openErr != nil {
		return missing("private source missing")
	}
	_, err = database.ExecContext(ctx, `UPDATE media_objects SET state='ready',mime_type=?,byte_count=? WHERE id=?`, mime, size, id)
	return err
}
func reportLegacyOrphans(ctx context.Context, database *sql.DB) error {
	known := map[string]bool{}
	rows, err := database.QueryContext(ctx, `SELECT legacy_url FROM media_objects WHERE legacy_url IS NOT NULL`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		known[strings.TrimPrefix(raw, "/static/uploads/")] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, base := range LegacyUploadRoots() {
		err := filepath.WalkDir(base, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			relative, err := filepath.Rel(base, path)
			if err != nil {
				return err
			}
			if !known[filepath.ToSlash(relative)] {
				log.Printf("media recovery: unowned legacy asset %q quarantined in place (not served/deleted); restore a proven association explicitly", path)
			}
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// CleanupMedia locks out new attachments before deleting unreachable metadata.
// Only managed private bytes are swept; all legacy source mounts stay untouched.
func CleanupMedia(ctx context.Context, database *sql.DB, sweepFiles bool) error {
	root, err := AvatarRoot(database)
	if err != nil {
		return err
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,object_key FROM media_objects m WHERE NOT EXISTS(SELECT 1 FROM media_links l WHERE l.media_id=m.id) AND NOT EXISTS(SELECT 1 FROM media_pending p WHERE p.media_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM users u WHERE u.avatar_key=m.object_key)`)
	if err != nil {
		return err
	}
	keys := []string{}
	ids := []int64{}
	for rows.Next() {
		var id int64
		var key string
		if err := rows.Scan(&id, &key); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `DELETE FROM media_objects WHERE id=?`, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, key := range keys {
		if err := os.Remove(filepath.Join(root, "objects", key)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if !sweepFiles {
		return nil
	}
	// Called only before readiness, after every association and pending row exists.
	used := map[string]bool{}
	rows, err = database.QueryContext(ctx, `SELECT object_key FROM media_objects UNION SELECT avatar_key FROM users WHERE avatar_key IS NOT NULL`)
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
	entries, err := os.ReadDir(filepath.Join(root, "objects"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !used[entry.Name()] {
			if err := os.Remove(filepath.Join(root, "objects", entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func fileDigest(file *os.File) ([32]byte, error) {
	var result [32]byte
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return result, err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return result, err
	}
	copy(result[:], hash.Sum(nil))
	_, err := file.Seek(0, io.SeekStart)
	return result, err
}
