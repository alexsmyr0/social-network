package db

import (
	"context"
	"database/sql"
	"errors"
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

// Personal posts (group_id NULL): owners keep draft/archive access; non-owners
// need a published post, profile permission and the post's audience.
const personalPostPermission = `(p.author_id=?1 OR (p.status='published' AND
 (u.profile_visibility='public' OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followed_id=u.id AND f.state='accepted'))
 AND (p.audience='public' OR (p.audience='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=?1 AND f.followed_id=p.author_id AND f.state='accepted'))
 OR (p.audience='selected' AND EXISTS(SELECT 1 FROM post_selected_followers sf JOIN follows f ON f.id=sf.follow_id WHERE sf.post_id=p.id AND f.follower_id=?1 AND f.followed_id=p.author_id AND f.state='accepted')))))`

// Group posts: current membership of the viewer decides, regardless of the
// author's profile visibility, the viewer's follows or any stored audience.
// Only the author reads a draft, and only while still a member.
var groupPostPermission = `(` + GroupMemberSQL("p.group_id", "?1") + ` AND (p.status='published' OR p.author_id=?1))`

// contentPermission is the one shared post decision, used by detail, comments,
// reactions, media, feeds, activity, categories, navigation and notices. Aliases
// p (post) and u (author); ?1 is the viewer. Post scope picks exactly one rule
// set; the personal and group rules are never combined, so neither can widen the
// other.
var contentPermission = `u.is_active=1 AND EXISTS(SELECT 1 FROM users v WHERE v.id=?1 AND v.is_active=1)
 AND CASE WHEN p.group_id IS NULL THEN ` + personalPostPermission + ` ELSE ` + groupPostPermission + ` END`

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

// canReceiveContentNotice reports whether a notice about the post or comment may
// be created for the recipient. Personal content keeps its existing behavior;
// group content only notifies current members, so a departed author is never
// told about activity on content they can no longer read.
func canReceiveContentNotice(ctx context.Context, tx *sql.Tx, recipient int64, kind string, id int64) (bool, error) {
	from, where := `posts p`, `p.id=?2`
	if kind == "comment" {
		from, where = `comments c JOIN posts p ON p.id=c.post_id`, `c.id=?2`
	}
	var allowed bool
	err := tx.QueryRowContext(ctx, `SELECT p.group_id IS NULL OR `+GroupMemberSQL("p.group_id", "?1")+` FROM `+from+` WHERE `+where, recipient, id).Scan(&allowed)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return allowed, err
}
