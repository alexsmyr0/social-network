package db

import (
	"context"
	"database/sql"
	"reflect"
	"strings"
)

// CommentInput carries presence-aware social comment fields. Omitted fields keep
// their stored value; ExpectedVersion is required for edits and ignored on create.
type CommentInput struct {
	ExpectedVersion int64
	Body            *string
	ParentCommentID *int64
	ImageURL        *string
	HasImage        bool
	UploadedImage   bool
}

// WriteDiscussionComment creates (id 0) or edits one comment. Post access,
// ownership, version and parent validation all run after SQLite's social write
// lock, so a concurrent unfollow, audience edit or unpublish cannot be raced.
func WriteDiscussionComment(ctx context.Context, database *sql.DB, viewer, post, id int64, in CommentInput) (Comment, error) {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return Comment{}, err
	}
	defer tx.Rollback()
	var old Comment
	if id != 0 {
		if post, err = requireCommentAccess(ctx, tx, viewer, id, true); err != nil {
			return Comment{}, err
		}
		if old, err = socialCommentTx(ctx, tx, viewer, id); err != nil {
			return Comment{}, err
		}
		if old.Version != in.ExpectedVersion {
			return Comment{}, ErrStaleContent
		}
	} else {
		if err := requirePostAccess(ctx, tx, viewer, post, false); err != nil {
			return Comment{}, err
		}
		if in.ParentCommentID != nil {
			// The parent must be a live comment of an active user on this same post.
			var valid bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM comments c JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 WHERE c.id=? AND c.post_id=?)`, *in.ParentCommentID, post).Scan(&valid); err != nil {
				return Comment{}, err
			}
			if !valid {
				return Comment{}, sql.ErrNoRows
			}
		}
	}
	body, image := old.Body, old.ImageURL
	if in.Body != nil {
		body = *in.Body
	}
	if in.HasImage {
		image = nil
		if in.ImageURL != nil {
			copyURL := *in.ImageURL
			image = &copyURL
		}
	}
	if in.HasImage && image != nil {
		if id != 0 && !in.UploadedImage {
			var own bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_links ml JOIN media_objects m ON m.id=ml.media_id WHERE ml.comment_id=? AND ('/api/v1/media/'||m.id=? OR m.legacy_url=?))`, id, *image, *image).Scan(&own); err != nil {
				return Comment{}, err
			}
			if !own {
				return Comment{}, sql.ErrNoRows
			}
		}
		if err := claimMediaTx(ctx, tx, viewer, "comment", id, image, 0); err != nil {
			return Comment{}, err
		}
	}
	if strings.TrimSpace(body) == "" {
		ready := false
		if image != nil {
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM media_objects WHERE state='ready' AND ('/api/v1/media/'||id=? OR legacy_url=?))`, *image, *image).Scan(&ready); err != nil {
				return Comment{}, err
			}
		}
		// A historical missing attachment stays readable until its text or image is edited.
		if !ready && (id == 0 || in.Body != nil || in.HasImage) {
			return Comment{}, contentField("body", "CONTENT_REQUIRED")
		}
	}
	var announced bool
	var owner int64
	if id != 0 {
		if body == old.Body && reflect.DeepEqual(image, old.ImageURL) {
			return old, nil
		}
		if old.Version >= MaxSocialID {
			return Comment{}, ErrStaleContent
		}
		query, args := `UPDATE comments SET body=?,content_version=content_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`, []any{body}
		if in.HasImage {
			query += `,image_url=?`
			args = append(args, image)
		}
		if _, err := tx.ExecContext(ctx, query+` WHERE id=?`, append(args, id)...); err != nil {
			return Comment{}, err
		}
	} else {
		result, err := tx.ExecContext(ctx, `INSERT INTO comments(post_id,user_id,parent_comment_id,body,image_url) VALUES(?,?,?,?,?)`, post, viewer, in.ParentCommentID, body, image)
		if err != nil {
			return Comment{}, err
		}
		if id, err = result.LastInsertId(); err != nil {
			return Comment{}, err
		}
		if id < 1 || id > MaxSocialID {
			return Comment{}, ErrInvalidInput
		}
		if err := tx.QueryRowContext(ctx, `SELECT author_id FROM posts WHERE id=?`, post).Scan(&owner); err != nil {
			return Comment{}, err
		}
		if owner != viewer {
			// Notice insert and dedup share the comment's transaction.
			result, err := tx.ExecContext(ctx, `INSERT INTO notifications(recipient_id,actor_id,type,post_id,comment_id) VALUES(?,?,'comment',?,NULL) ON CONFLICT DO NOTHING`, owner, viewer, post)
			if err != nil {
				return Comment{}, err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return Comment{}, err
			}
			announced = n > 0
		}
	}
	if in.HasImage && image != nil {
		if err := finishMediaClaimTx(ctx, tx, image); err != nil {
			return Comment{}, err
		}
	}
	comment, err := socialCommentTx(ctx, tx, viewer, id)
	if err != nil {
		return Comment{}, err
	}
	if err := tx.Commit(); err != nil {
		return Comment{}, err
	}
	fireSocialInvalidation()
	if announced {
		fireNotificationHook(owner)
	}
	cleanupPublishingMedia(ctx, database)
	return comment, nil
}

// DeleteDiscussionComment removes the author's comment, its descendants,
// reactions, notices and media links after current parent access and version pass.
func DeleteDiscussionComment(ctx context.Context, database *sql.DB, viewer, id, expected int64) error {
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := requireCommentAccess(ctx, tx, viewer, id, true); err != nil {
		return err
	}
	var version int64
	if err := tx.QueryRowContext(ctx, `SELECT content_version FROM comments WHERE id=?`, id).Scan(&version); err != nil {
		return err
	}
	if version != expected {
		return ErrStaleContent
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM comments WHERE id=?`, id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fireSocialInvalidation()
	cleanupPublishingMedia(ctx, database)
	return nil
}

type ReactionResult struct {
	Reaction, Likes, Dislikes int
}

// ToggleDiscussionReaction applies one like/dislike toggle. Authorization, the
// reaction row, its notice and the returned counts share one serialized
// transaction; signals are sent only after commit.
func ToggleDiscussionReaction(ctx context.Context, database *sql.DB, viewer, id int64, value int, kind string) (ReactionResult, error) {
	var result ReactionResult
	if value != 1 && value != -1 || kind != "post" && kind != "comment" {
		return result, ErrInvalidInput
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if kind == "post" {
		err = requirePostAccess(ctx, tx, viewer, id, false)
	} else {
		_, err = requireCommentAccess(ctx, tx, viewer, id, false)
	}
	if err != nil {
		return result, err
	}
	owner, err := getReactionTargetOwnerTx(ctx, tx, id, kind)
	if err != nil {
		return result, err
	}
	current, err := getReactionValueTx(ctx, tx, viewer, id, kind)
	if err != nil {
		return result, err
	}
	if result.Reaction, err = applyReactionToggleTx(ctx, tx, viewer, id, current, value, kind); err != nil {
		return result, err
	}
	var notified int64
	if result.Reaction != 0 {
		if notified, err = handleReactionNotificationTx(ctx, tx, owner, viewer, id, result.Reaction, kind); err != nil {
			return result, err
		}
	}
	column := "post_id"
	if kind == "comment" {
		column = "comment_id"
	}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(value=1),0),COALESCE(SUM(value=-1),0) FROM reactions WHERE `+column+`=?`, id).Scan(&result.Likes, &result.Dislikes); err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	fireSocialInvalidation()
	if notified != 0 {
		fireNotificationHook(notified)
	}
	return result, nil
}
