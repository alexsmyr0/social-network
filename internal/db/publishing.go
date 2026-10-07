package db

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"reflect"
	"sort"
	"strings"
)

var ErrStaleContent = errors.New("stale content")

type ContentFieldError struct{ Field, Code string }

func (e *ContentFieldError) Error() string  { return e.Field + ": " + e.Code }
func contentField(field, code string) error { return &ContentFieldError{field, code} }

type PublishingInput struct {
	ExpectedVersion                  int64
	Title                            *string
	HasTitle                         bool
	Body, Status, Audience           *string
	ImageURL                         *string
	HasImage                         bool
	UploadedImage                    bool
	CategoryIDs, SelectedFollowerIDs []int64
	HasCategories, HasSelections     bool
}

func selectedAccountsTx(ctx context.Context, tx *sql.Tx, post int64) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT f.follower_id FROM post_selected_followers sf JOIN follows f ON f.id=sf.follow_id WHERE sf.post_id=? ORDER BY f.follower_id`, post)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func selectionFollowsTx(ctx context.Context, tx *sql.Tx, author int64, ids []int64) ([]int64, error) {
	follows := []int64{}
	for _, id := range ids {
		var follow int64
		err := tx.QueryRowContext(ctx, `SELECT f.id FROM follows f JOIN users v ON v.id=f.follower_id AND v.is_active=1 WHERE f.follower_id=? AND f.followed_id=? AND f.state='accepted' AND f.follower_id<>f.followed_id`, id, author).Scan(&follow)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, contentField("selected_follower_ids", "INVALID_SELECTION")
		}
		if err != nil {
			return nil, err
		}
		follows = append(follows, follow)
	}
	return follows, nil
}
func validatePublishingIDs(ids []int64, max int, field string) error {
	if len(ids) > max {
		return contentField(field, "TOO_MANY")
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id < 1 || id > MaxSocialID || seen[id] {
			return contentField(field, "INVALID_IDS")
		}
		seen[id] = true
	}
	return nil
}
func WritePublishingPost(ctx context.Context, database *sql.DB, viewer, id int64, in PublishingInput, draftOnly bool) (Post, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Post{}, err
	}
	defer tx.Rollback()
	old := Post{AuthorID: viewer, Body: "", Status: "published", Audience: "public", Categories: []PostCategory{}}
	oldIDs := []int64{}
	oldSelections := []int64{}
	if draftOnly {
		old.Status = "draft"
	}
	if id != 0 {
		if err := requirePostAccess(ctx, tx, viewer, id, true); err != nil {
			return Post{}, err
		}
		old, err = socialPostTx(ctx, tx, viewer, id)
		if err != nil {
			return Post{}, err
		}
		if draftOnly && old.Status != "draft" {
			return Post{}, sql.ErrNoRows
		}
		if old.Version != in.ExpectedVersion {
			return Post{}, ErrStaleContent
		}
		for _, c := range old.Categories {
			oldIDs = append(oldIDs, c.ID)
		}
		oldSelections = *old.SelectedFollowerIDs
	} else {
		var active bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND is_active=1)`, viewer).Scan(&active); err != nil {
			return Post{}, err
		}
		if !active {
			return Post{}, sql.ErrNoRows
		}
	}
	title, body, status, audience, image := old.NullableTitle, old.Body, old.Status, old.Audience, old.ImageURL
	if in.HasTitle {
		title = in.Title
	}
	if in.Body != nil {
		body = *in.Body
	}
	if in.Status != nil {
		status = *in.Status
	}
	if in.Audience != nil {
		audience = *in.Audience
	}
	if in.HasImage {
		image = in.ImageURL
	}
	if in.Status != nil && status != "published" && status != "draft" {
		return Post{}, contentField("status", "INVALID_STATUS")
	}
	if audience != "public" && audience != "followers" && audience != "selected" {
		return Post{}, contentField("audience", "INVALID_AUDIENCE")
	}
	cats, selections := append([]int64{}, oldIDs...), append([]int64{}, oldSelections...)
	if in.HasCategories {
		cats = append([]int64{}, in.CategoryIDs...)
	}
	if in.HasSelections {
		selections = append([]int64{}, in.SelectedFollowerIDs...)
	}
	if err := validatePublishingIDs(cats, 50, "category_ids"); err != nil {
		return Post{}, err
	}
	if err := validatePublishingIDs(selections, 500, "selected_follower_ids"); err != nil {
		return Post{}, err
	}
	sort.Slice(cats, func(i, j int) bool { return cats[i] < cats[j] })
	sort.Slice(selections, func(i, j int) bool { return selections[i] < selections[j] })
	if in.HasCategories || id == 0 {
		for _, cat := range cats {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)`, cat).Scan(&exists); err != nil {
				return Post{}, err
			}
			if !exists {
				return Post{}, contentField("category_ids", "INVALID_CATEGORY")
			}
		}
	}
	if audience != "selected" {
		if in.HasSelections && len(in.SelectedFollowerIDs) > 0 {
			return Post{}, contentField("selected_follower_ids", "INVALID_SELECTION")
		}
		selections = []int64{}
	} else if old.Audience != "selected" && !in.HasSelections {
		return Post{}, contentField("selected_follower_ids", "INVALID_SELECTION")
	}
	publishing := status == "published" && (id == 0 || old.Status != "published")
	if audience == "selected" && publishing && len(selections) == 0 {
		return Post{}, contentField("selected_follower_ids", "INVALID_SELECTION")
	}
	followIDs := []int64{}
	if audience == "selected" && (in.HasSelections || publishing) {
		followIDs, err = selectionFollowsTx(ctx, tx, viewer, selections)
		if err != nil {
			return Post{}, err
		}
	}
	if in.HasImage && image != nil && !in.UploadedImage {
		var ownAttachment bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_links ml JOIN media_objects m ON m.id=ml.media_id WHERE ml.post_id=? AND ('/api/v1/media/'||m.id=? OR m.legacy_url=?))`, id, *image, *image).Scan(&ownAttachment); err != nil {
			return Post{}, err
		}
		if !ownAttachment {
			return Post{}, sql.ErrNoRows
		}
	}
	if in.HasImage && image != nil {
		copyURL := *image
		image = &copyURL
		if err := claimMediaTx(ctx, tx, viewer, "post", id, image, 0); err != nil {
			return Post{}, err
		}
	}
	if status != "draft" && strings.TrimSpace(body) == "" {
		ready := false
		if image != nil {
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_objects WHERE state='ready' AND ('/api/v1/media/'||id=? OR legacy_url=?))`, *image, *image).Scan(&ready); err != nil {
				return Post{}, err
			}
		}
		// An unchanged historical missing attachment remains readable/editable. New
		// publication or text/image edits must meet actual content completeness.
		if !ready && (publishing || in.Body != nil || in.HasImage) {
			return Post{}, contentField("body", "CONTENT_REQUIRED")
		}
	}
	unchanged := id != 0 && reflect.DeepEqual(title, old.NullableTitle) && body == old.Body && status == old.Status && audience == old.Audience && reflect.DeepEqual(image, old.ImageURL) && reflect.DeepEqual(cats, oldIDs) && reflect.DeepEqual(selections, oldSelections)
	if unchanged {
		return old, nil
	}
	if id == 0 {
		result, e := tx.ExecContext(ctx, `INSERT INTO posts(author_id,title,body,status,audience,image_url) VALUES(?,?,?,?,?,?)`, viewer, title, body, status, audience, image)
		if e != nil {
			return Post{}, e
		}
		id, err = result.LastInsertId()
		if err == nil && (id < 1 || id > MaxSocialID) {
			return Post{}, ErrInvalidInput
		}
		if err != nil {
			return Post{}, err
		}
	} else {
		if old.Version >= MaxSocialID {
			return Post{}, ErrStaleContent
		}
		if in.HasSelections || audience != old.Audience {
			if _, err := tx.ExecContext(ctx, `DELETE FROM post_selected_followers WHERE post_id=?`, id); err != nil {
				return Post{}, err
			}
		}
		query := `UPDATE posts SET title=?,body=?,status=?,audience=?,content_version=content_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`
		args := []any{title, body, status, audience}
		if in.HasImage {
			query += `,image_url=?`
			args = append(args, image)
		}
		query += ` WHERE id=?`
		args = append(args, id)
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return Post{}, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM post_categories WHERE post_id=?`, id); err != nil {
			return Post{}, err
		}
	}
	if err := insertPostCategoriesTx(ctx, tx, id, cats); err != nil {
		return Post{}, err
	}
	if audience == "selected" && (old.Version == 0 || in.HasSelections || audience != old.Audience) {
		if !in.HasSelections && !publishing {
			followIDs, err = selectionFollowsTx(ctx, tx, viewer, selections)
			if err != nil {
				return Post{}, err
			}
		}
		for _, follow := range followIDs {
			if _, err := tx.ExecContext(ctx, `INSERT INTO post_selected_followers(post_id,follow_id) VALUES(?,?)`, id, follow); err != nil {
				return Post{}, err
			}
		}
	}
	if in.HasImage && image != nil {
		if err := finishMediaClaimTx(ctx, tx, image); err != nil {
			return Post{}, err
		}
	}
	p, err := socialPostTx(ctx, tx, viewer, id)
	if err != nil {
		return Post{}, err
	}
	if err := tx.Commit(); err != nil {
		return Post{}, err
	}
	fireSocialInvalidation()
	cleanupPublishingMedia(ctx, database)
	return p, nil
}
func cleanupPublishingMedia(ctx context.Context, database *sql.DB) {
	if err := CleanupMedia(ctx, database, false); err != nil {
		log.Printf("media cleanup deferred to restart: %v", err)
	}
}
func DeletePublishingPost(ctx context.Context, database *sql.DB, viewer, id, expected int64, draftOnly bool) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requirePostAccess(ctx, tx, viewer, id, true); err != nil {
		return err
	}
	var version int64
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT content_version,status FROM posts WHERE id=?`, id).Scan(&version, &status); err != nil {
		return err
	}
	if draftOnly && status != "draft" {
		return sql.ErrNoRows
	}
	if expected != version {
		return ErrStaleContent
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM posts WHERE id=?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation()
	cleanupPublishingMedia(ctx, database)
	return nil
}
func PublishingFeed(ctx context.Context, database *sql.DB, viewer int64, page, per int, feed, status string, category int64, mine bool) (ListPostsResult, error) {
	extra := ` AND p.status='published'`
	args := []any{}
	if mine {
		extra = ` AND p.author_id=?1`
		if status != "all" {
			extra += ` AND p.status=?`
			args = append(args, status)
		}
	}
	if feed == "following" {
		extra += ` AND EXISTS(SELECT 1 FROM follows ff WHERE ff.follower_id=?1 AND ff.followed_id=p.author_id AND ff.state='accepted')`
	}
	if category != 0 {
		extra += ` AND EXISTS(SELECT 1 FROM post_categories pc WHERE pc.post_id=p.id AND pc.category_id=?)`
		args = append(args, category)
	}
	return socialPostPage(ctx, database, viewer, page, per, extra, args...)
}

type PublishingDraft struct {
	ID                  int64   `json:"id"`
	Title               *string `json:"title"`
	Body                string  `json:"body"`
	ImageURL            *string `json:"image_url"`
	CategoryIDs         []int64 `json:"category_ids"`
	UpdatedAt           string  `json:"updated_at"`
	Audience            string  `json:"audience"`
	Version             int64   `json:"version"`
	SelectedFollowerIDs []int64 `json:"selected_follower_ids"`
}

func LatestPublishingDraft(ctx context.Context, database *sql.DB, viewer int64) (*PublishingDraft, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM posts WHERE author_id=? AND status='draft' ORDER BY updated_at DESC,id DESC LIMIT 1`, viewer).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p, err := socialPostTx(ctx, tx, viewer, id)
	if err != nil {
		return nil, err
	}
	cats := []int64{}
	for _, c := range p.Categories {
		cats = append(cats, c.ID)
	}
	d := &PublishingDraft{p.ID, p.NullableTitle, p.Body, p.ImageURL, cats, p.UpdatedAt, p.Audience, p.Version, *p.SelectedFollowerIDs}
	return d, tx.Commit()
}
