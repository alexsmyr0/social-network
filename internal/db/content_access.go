package db

import (
	"context"
	"database/sql"
)

type socialViewerKey struct{}

// WithSocialViewer marks authenticated social requests. Retained repository entry
// points use the viewer to apply current policy, while historical forum fixtures
// keep their separate schema behavior. Only the authentication boundary sets it.
func WithSocialViewer(ctx context.Context, viewer int64) context.Context {
	return context.WithValue(ctx, socialViewerKey{}, viewer)
}
func SocialViewer(ctx context.Context) (int64, bool) {
	id, ok := ctx.Value(socialViewerKey{}).(int64)
	return id, ok && id > 0
}

// Aliases p (post) and u (author); ?1 is the authenticated viewer. Owners keep
// draft/archive access; non-owners need a published post and profile permission.
const contentPermission = `u.is_active=1 AND EXISTS(SELECT 1 FROM users v WHERE v.id=?1 AND v.is_active=1)
 AND (p.author_id=?1 OR (p.status='published' AND
 (u.profile_visibility='public' OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followed_id=u.id AND f.state='accepted'))
 AND (p.audience='public' OR (p.audience='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followed_id=p.author_id AND f.state='accepted'))
 OR (p.audience='selected' AND EXISTS(SELECT 1 FROM post_selected_followers sf JOIN follows f ON f.id=sf.follow_id WHERE sf.post_id=p.id AND f.follower_id=?1 AND f.followed_id=p.author_id AND f.state='accepted')))))`

func CanViewPost(ctx context.Context, q ProfileReader, viewer, post int64) (bool, error) {
	var allowed bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?2 AND `+contentPermission+`)`, viewer, post).Scan(&allowed)
	return allowed, err
}
func requirePostAccess(ctx context.Context, tx *sql.Tx, viewer, post int64, owner bool) error {
	allowed, err := CanViewPost(ctx, tx, viewer, post)
	if err != nil {
		return err
	}
	if !allowed {
		return sql.ErrNoRows
	}
	if owner {
		var author int64
		if err := tx.QueryRowContext(ctx, `SELECT author_id FROM posts WHERE id=?`, post).Scan(&author); err != nil {
			return err
		}
		if author != viewer {
			return sql.ErrNoRows
		}
	}
	return nil
}
func requireCommentAccess(ctx context.Context, tx *sql.Tx, viewer, comment int64, owner bool) (int64, error) {
	var post, user int64
	if err := tx.QueryRowContext(ctx, `SELECT c.post_id,c.user_id FROM comments c JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 WHERE c.id=?`, comment).Scan(&post, &user); err != nil {
		return 0, err
	}
	if owner && user != viewer {
		return 0, sql.ErrNoRows
	}
	return post, requirePostAccess(ctx, tx, viewer, post, false)
}
