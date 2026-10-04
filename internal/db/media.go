package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type MediaObject struct {
	ID               int64
	Key, MIME, State string
	Bytes            int64
}

func MediaURL(id int64) string { return fmt.Sprintf("/api/v1/media/%d", id) }
func mediaID(raw string) (int64, bool) {
	if !strings.HasPrefix(raw, "/api/v1/media/") {
		return 0, false
	}
	s := strings.TrimPrefix(raw, "/api/v1/media/")
	if s == "" {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	id, e := strconv.ParseInt(s, 10, 64)
	return id, e == nil && id > 0 && id <= MaxSocialID
}
func mediaLinkColumn(kind string) (string, error) {
	switch kind {
	case "avatar":
		return "avatar_user_id", nil
	case "post":
		return "post_id", nil
	case "comment":
		return "comment_id", nil
	case "message":
		return "message_id", nil
	}
	return "", ErrInvalidInput
}
func resourceMediaURLTx(ctx context.Context, tx *sql.Tx, kind string, id int64, original sql.NullString) (*string, error) {
	if !original.Valid {
		return nil, nil
	}
	column, err := mediaLinkColumn(kind)
	if err != nil {
		return nil, err
	}
	var media int64
	err = tx.QueryRowContext(ctx, `SELECT media_id FROM media_links WHERE `+column+`=?`, id).Scan(&media)
	if errors.Is(err, sql.ErrNoRows) {
		// Trusted legacy references inserted outside runtime writes may await restart.
		// Only a protected compatibility route is allowed; never serialize a raw URL.
		if normalized, ok := NormalizeLegacyMediaURL(original.String); ok {
			return &normalized, nil
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value := MediaURL(media)
	return &value, nil
}

// NormalizeLegacyMediaURL accepts only canonical, contained upload references.
// Encoded separators/dot segments/backslashes and external URLs are rejected.
func NormalizeLegacyMediaURL(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "web/static/uploads/") {
		raw = "/" + strings.TrimPrefix(raw, "web/")
	}
	if strings.HasPrefix(raw, "static/uploads/") {
		raw = "/" + raw
	}
	if strings.ContainsAny(raw, "\\%?#\x00") || !strings.HasPrefix(raw, "/static/uploads/") {
		return "", false
	}
	suffix := strings.TrimPrefix(raw, "/static/uploads/")
	parts := strings.Split(suffix, "/")
	if len(parts) == 2 && parts[0] == "dm" {
		parts = parts[1:]
	} else if len(parts) != 1 {
		return "", false
	}
	name := parts[0]
	if name == "" || name == "." || name == ".." || strings.Contains(name, "..") {
		return "", false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r)) {
			return "", false
		}
	}
	return raw, true
}

func mediaObjectTx(ctx context.Context, tx *sql.Tx, id int64) (MediaObject, error) {
	var m MediaObject
	err := tx.QueryRowContext(ctx, `SELECT id,object_key,COALESCE(mime_type,''),state,COALESCE(byte_count,0) FROM media_objects WHERE id=?`, id).Scan(&m.ID, &m.Key, &m.MIME, &m.State, &m.Bytes)
	return m, err
}
func AuthorizedMedia(ctx context.Context, database *sql.DB, viewer int64, raw string) (MediaObject, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return MediaObject{}, err
	}
	defer tx.Rollback()
	id, ok := mediaID(raw)
	if !ok {
		canonical, valid := NormalizeLegacyMediaURL(raw)
		if !valid {
			return MediaObject{}, sql.ErrNoRows
		}
		if err := tx.QueryRowContext(ctx, `SELECT id FROM media_objects WHERE legacy_url=?`, canonical).Scan(&id); err != nil {
			return MediaObject{}, err
		}
	}
	m, err := mediaObjectTx(ctx, tx, id)
	if err != nil {
		return m, err
	}
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer).Scan(&active); err != nil {
		return m, err
	}
	if !active {
		return m, sql.ErrNoRows
	}
	rows, err := tx.QueryContext(ctx, `SELECT avatar_user_id,post_id,comment_id,message_id FROM media_links WHERE media_id=?`, id)
	if err != nil {
		return m, err
	}
	type link struct{ avatar, post, comment, message sql.NullInt64 }
	links := []link{}
	for rows.Next() {
		var l link
		if err := rows.Scan(&l.avatar, &l.post, &l.comment, &l.message); err != nil {
			rows.Close()
			return m, err
		}
		links = append(links, l)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return m, err
	}
	allowed := false
	for _, l := range links {
		switch {
		case l.avatar.Valid:
			allowed, err = CanViewProfile(ctx, tx, viewer, l.avatar.Int64)
		case l.post.Valid:
			allowed, err = CanViewPost(ctx, tx, viewer, l.post.Int64)
		case l.comment.Valid:
			var post int64
			err = tx.QueryRowContext(ctx, `SELECT c.post_id FROM comments c JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 WHERE c.id=?`, l.comment.Int64).Scan(&post)
			if err == nil {
				allowed, err = CanViewPost(ctx, tx, viewer, post)
			}
		case l.message.Valid:
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM private_messages WHERE id=? AND (sender_id=? OR recipient_id=?))`, l.message.Int64, viewer, viewer).Scan(&allowed)
		}
		if errors.Is(err, sql.ErrNoRows) {
			err = nil
			allowed = false
		}
		if err != nil {
			return m, err
		}
		if allowed {
			break
		}
	}
	if !allowed {
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_pending WHERE media_id=? AND uploader_id=?)`, id, viewer).Scan(&allowed); err != nil {
			return m, err
		}
	}
	if !allowed || m.State != "ready" {
		return m, sql.ErrNoRows
	}
	return m, tx.Commit()
}

// Attach only a fresh upload owned by this writer or the same resource's current
// attachment. Read permission alone can never create a new ownership association.
func claimMediaTx(ctx context.Context, tx *sql.Tx, viewer int64, kind string, resource int64, raw *string, recipient int64) error {
	if raw == nil {
		return nil
	}
	column, err := mediaLinkColumn(kind)
	if err != nil {
		return err
	}
	id, ok := mediaID(*raw)
	if !ok {
		canonical, valid := NormalizeLegacyMediaURL(*raw)
		if !valid {
			return ErrNotFound
		}
		if err := tx.QueryRowContext(ctx, `SELECT id FROM media_objects WHERE legacy_url=?`, canonical).Scan(&id); err != nil {
			return err
		}
	}
	var allowed bool
	if resource != 0 {
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_links WHERE media_id=? AND `+column+`=?)`, id, resource).Scan(&allowed); err != nil {
			return err
		}
	}
	if !allowed {
		uploadKind := "content"
		if kind == "message" {
			uploadKind = "dm"
		}
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_pending mp JOIN media_objects m ON m.id=mp.media_id
 WHERE mp.media_id=? AND mp.uploader_id=? AND mp.kind=? AND m.state='ready' AND (?='content' OR mp.recipient_id=?))`, id, viewer, uploadKind, uploadKind, recipient).Scan(&allowed)
		if err != nil {
			return err
		}
	}
	if !allowed {
		return sql.ErrNoRows
	}
	*raw = MediaURL(id)
	return nil
}
func finishMediaClaimTx(ctx context.Context, tx *sql.Tx, raw *string) error {
	if raw == nil {
		return nil
	}
	id, ok := mediaID(*raw)
	if !ok {
		return ErrInvalidInput
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM media_pending WHERE media_id=?`, id)
	return err
}

// StageMedia syncs bytes before exposing a DB reference. The durable pending row
// binds uploader/DM recipient. DM pending uploads have no automatic expiry.
func StageMedia(ctx context.Context, database *sql.DB, viewer, recipient int64, kind string, data []byte, mime string) (string, string, error) {
	if kind != "content" && kind != "dm" {
		return "", "", ErrInvalidInput
	}
	root, err := AvatarRoot(database)
	if err != nil {
		return "", "", err
	}
	key := uuid.NewString() + map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif"}[mime]
	if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" {
		return "", "", ErrInvalidInput
	}
	path := filepath.Join(root, "objects", key)
	if err := writeMediaBytes(root, key, bytes.NewReader(data)); err != nil {
		_ = os.Remove(path)
		return "", "", err
	}
	remove := true
	defer func() {
		if remove {
			_ = os.Remove(path)
		}
	}()
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_active=1 AND (id=? OR (?='dm' AND id=?))`, viewer, kind, recipient).Scan(&count); err != nil {
		return "", "", err
	}
	if count != 1 && kind == "content" || count != 2 && kind == "dm" {
		return "", "", sql.ErrNoRows
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO media_objects(source_key,object_key,mime_type,byte_count,state) VALUES(?,?,?,?,'ready')`, "new:"+key, key, mime, len(data))
	if err != nil {
		return "", "", err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return "", "", err
	}
	var to any
	if kind == "dm" {
		to = recipient
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO media_pending(media_id,uploader_id,recipient_id,kind) VALUES(?,?,?,?)`, id, viewer, to, kind); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	remove = false
	return MediaURL(id), path, nil
}
func writeMediaBytes(root, key string, source io.Reader) error {
	tmp, err := os.CreateTemp(root, ".tmp-media-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, source); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(root, "objects", key)); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Join(root, "objects"))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func OpenMediaFile(database *sql.DB, m MediaObject) (*os.File, error) {
	root, err := AvatarRoot(database)
	if err != nil {
		return nil, err
	}
	objects, err := os.OpenRoot(filepath.Join(root, "objects"))
	if err != nil {
		return nil, err
	}
	defer objects.Close()
	if filepath.Base(m.Key) != m.Key {
		return nil, ErrInvalidInput
	}
	file, err := objects.Open(m.Key)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, ErrInvalidInput
	}
	if info.Size() != m.Bytes {
		file.Close()
		return nil, fmt.Errorf("media size changed")
	}
	return file, nil
}
func ReadMediaFile(database *sql.DB, m MediaObject) ([]byte, error) {
	file, err := OpenMediaFile(database, m)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(file)
}

func DiscardStagedMedia(ctx context.Context, database *sql.DB, raw string, viewer int64) error {
	id, ok := mediaID(raw)
	if !ok {
		return nil
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var key string
	err = tx.QueryRowContext(ctx, `SELECT m.object_key FROM media_objects m JOIN media_pending p ON p.media_id=m.id WHERE m.id=? AND p.uploader_id=? AND p.kind='content' AND NOT EXISTS(SELECT 1 FROM media_links l WHERE l.media_id=m.id)`, id, viewer).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM media_objects WHERE id=?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	root, err := AvatarRoot(database)
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(root, "objects", key))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// URL parsing is deliberately stricter than path cleaning: an alias must never
// be redirected into an unprotected static mount by ServeMux canonicalization.
func IsMediaRequestPath(raw string) bool {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		decoded = raw
	}
	decoded = strings.ReplaceAll(decoded, "\\", "/")
	cleaned := "/" + strings.TrimPrefix(filepath.ToSlash(filepath.Clean(decoded)), "/")
	return strings.HasPrefix(cleaned, "/static/uploads") || strings.HasPrefix(cleaned, "/api/v1/media") || strings.Contains(decoded, "/static/uploads") || strings.Contains(decoded, "/api/v1/media")
}

func IsPrivateMediaURL(raw string) bool { _, ok := mediaID(raw); return ok }

func registerAvatarMediaTx(ctx context.Context, tx *sql.Tx, database *sql.DB, key string) error {
	exists, err := HasMediaSchema(ctx, tx)
	if err != nil || !exists {
		return err
	}
	root, err := AvatarRoot(database)
	if err != nil {
		return err
	}
	objects, err := os.OpenRoot(filepath.Join(root, "objects"))
	if err != nil {
		return err
	}
	defer objects.Close()
	file, err := objects.Open(key)
	if err != nil {
		return err
	}
	defer file.Close()
	mime, size, err := inspectLegacyImage(file)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO media_objects(source_key,object_key,mime_type,byte_count,state) VALUES(?,?,?,?,'ready')`, "avatar:"+key, key, mime, size)
	return err
}
func AvatarMedia(ctx context.Context, database *sql.DB, viewer, user int64) (MediaObject, error) {
	var id int64
	if err := database.QueryRowContext(ctx, `SELECT media_id FROM media_links WHERE avatar_user_id=?`, user).Scan(&id); err != nil {
		return MediaObject{}, err
	}
	return AuthorizedMedia(ctx, database, viewer, MediaURL(id))
}
