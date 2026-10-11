package db

import (
	"context"
	"database/sql"
)

// requireGroupMember reports a missing, unknown or non-member group scope as an
// absent resource.
func requireGroupMember(ctx context.Context, q groupQuerier, viewer, group int64) error {
	member, err := IsGroupMember(ctx, q, viewer, group)
	if err != nil {
		return err
	}
	if !member {
		return sql.ErrNoRows
	}
	return nil
}

func socialPostTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Post, error) {
	var p Post
	var first, last string
	var nick, image, title, groupTitle sql.NullString
	var group sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT p.id,p.author_id,u.first_name,u.last_name,u.nickname,p.title,p.image_url,p.body,p.status,p.created_at,p.updated_at,p.audience,p.content_version,p.group_id,g.title
 FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN groups g ON g.id=p.group_id WHERE p.id=?2 AND `+contentPermission, viewer, id).Scan(&p.ID, &p.AuthorID, &first, &last, &nick, &title, &image, &p.Body, &p.Status, &p.CreatedAt, &p.UpdatedAt, &p.Audience, &p.Version, &group, &groupTitle)
	if err != nil {
		return p, err
	}
	if group.Valid {
		// The stored audience of a group post is inert: report the group scope and
		// never expose follower selections.
		p.Group = &PostGroup{ID: group.Int64, Title: groupTitle.String}
		p.Audience = "group"
	}
	if title.Valid {
		p.Title = title.String
		p.NullableTitle = &title.String
	}
	if p.AuthorID == viewer && p.Group == nil {
		ids, e := selectedAccountsTx(ctx, tx, id)
		if e != nil {
			return p, e
		}
		p.SelectedFollowerIDs = &ids
	}
	var nickname *string
	if nick.Valid {
		nickname = &nick.String
	}
	p.Author = displayName(first, last, nickname)
	p.ImageURL, err = resourceMediaURLTx(ctx, tx, "post", p.ID, image)
	if err != nil {
		return p, err
	}
	p.Categories = []PostCategory{}
	rows, err := tx.QueryContext(ctx, `SELECT c.id,c.name FROM categories c JOIN post_categories pc ON pc.category_id=c.id WHERE pc.post_id=? ORDER BY c.id`, id)
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var c PostCategory
		if err := rows.Scan(&c.ID, &c.Name); err != nil {
			rows.Close()
			return p, err
		}
		p.Categories = append(p.Categories, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return p, err
	}
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(value=1),0),COALESCE(SUM(value=-1),0),COALESCE(MAX(CASE WHEN user_id=? THEN value END),0) FROM reactions WHERE post_id=?`, viewer, id).Scan(&p.Likes, &p.Dislikes, &p.MyReaction)
	return p, err
}
func socialGetPost(ctx context.Context, database *sql.DB, viewer, id int64) (Post, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Post{}, err
	}
	defer tx.Rollback()
	p, err := socialPostTx(ctx, tx, viewer, id)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func socialPostPage(ctx context.Context, database *sql.DB, viewer int64, page, per int, extra string, args ...any) (ListPostsResult, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return ListPostsResult{Posts: []Post{}}, err
	}
	defer tx.Rollback()
	result, err := socialPostPageTx(ctx, tx, viewer, page, per, extra, args...)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// Count, paging and projections share the caller's snapshot. Plain ? placeholders
// in extra must follow the numbered viewer placeholder used by contentPermission.
func socialPostPageTx(ctx context.Context, tx *sql.Tx, viewer int64, page, per int, extra string, args ...any) (ListPostsResult, error) {
	result := ListPostsResult{Posts: []Post{}}
	page, per = normalizePagination(page, per)
	values := append([]any{viewer}, args...)
	from := ` FROM posts p JOIN users u ON u.id=p.author_id WHERE ` + contentPermission + extra
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, values...).Scan(&result.Total); err != nil {
		return result, err
	}
	params := append(append([]any{}, values...), per, (page-1)*per)
	ids, err := queryIDs(ctx, tx, `SELECT p.id`+from+` ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`, params...)
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		p, err := socialPostTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Posts = append(result.Posts, p)
	}
	return result, nil
}
func queryIDs(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
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

func socialCommentTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Comment, error) {
	var c Comment
	var parent sql.NullInt64
	var image sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT c.id,c.post_id,c.user_id,c.parent_comment_id,c.body,c.image_url,c.created_at,c.updated_at,c.content_version
 FROM comments c JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id
 JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 WHERE c.id=?2 AND `+contentPermission, viewer, id).Scan(&c.ID, &c.PostID, &c.UserID, &parent, &c.Body, &image, &c.CreatedAt, &c.UpdatedAt, &c.Version)
	if err != nil {
		return c, err
	}
	if parent.Valid {
		c.ParentCommentID = &parent.Int64
	}
	actor, err := personInTx(ctx, tx, viewer, c.UserID)
	if err != nil {
		return c, err
	}
	c.Username = actor.DisplayName
	c.ImageURL, err = resourceMediaURLTx(ctx, tx, "comment", c.ID, image)
	if err != nil {
		return c, err
	}
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(value=1),0),COALESCE(SUM(value=-1),0),COALESCE(MAX(CASE WHEN user_id=? THEN value END),0) FROM reactions WHERE comment_id=?`, viewer, id).Scan(&c.Likes, &c.Dislikes, &c.MyReaction)
	return c, err
}
func socialGetComment(ctx context.Context, database *sql.DB, viewer, id int64) (Comment, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Comment{}, err
	}
	defer tx.Rollback()
	c, err := socialCommentTx(ctx, tx, viewer, id)
	if err != nil {
		return c, err
	}
	return c, tx.Commit()
}

// Thread reads are oldest first; profile and activity histories are newest first.
// Every list gates on the parent post (and an active commenter) before counting.
func socialCommentListTx(ctx context.Context, tx *sql.Tx, viewer int64, where string, args []any, oldest bool, page, per int) ([]Comment, int, error) {
	page, per = normalizePagination(page, per)
	values := append([]any{viewer}, args...)
	from := ` FROM comments c JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id WHERE ` + contentPermission + where
	var total int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, values...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := "DESC"
	if oldest {
		order = "ASC"
	}
	params := append(append([]any{}, values...), per, (page-1)*per)
	ids, err := queryIDs(ctx, tx, `SELECT c.id`+from+` ORDER BY c.created_at `+order+`,c.id `+order+` LIMIT ? OFFSET ?`, params...)
	if err != nil {
		return nil, 0, err
	}
	comments := []Comment{}
	for _, id := range ids {
		c, err := socialCommentTx(ctx, tx, viewer, id)
		if err != nil {
			return nil, 0, err
		}
		comments = append(comments, c)
	}
	return comments, total, nil
}
func socialCommentPage(ctx context.Context, database *sql.DB, viewer, post int64, page, per int) (ListCommentsResult, error) {
	result := ListCommentsResult{Comments: []Comment{}}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := requirePostAccess(ctx, tx, viewer, post, false); err != nil {
		return result, err
	}
	result.Comments, result.Total, err = socialCommentListTx(ctx, tx, viewer, ` AND c.post_id=?`, []any{post}, true, page, per)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// beginProfileRead opens a read snapshot for a profile's content. A teaser,
// inactive or unknown subject is indistinguishable from a missing resource.
func beginProfileRead(ctx context.Context, database *sql.DB, viewer, subject int64) (*sql.Tx, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	allowed, err := CanViewProfile(ctx, tx, viewer, subject)
	if err == nil && !allowed {
		err = sql.ErrNoRows
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

// SocialProfilePosts lists the subject's published posts the viewer may read.
func SocialProfilePosts(ctx context.Context, database *sql.DB, viewer, subject int64, page, per int) (ListPostsResult, error) {
	tx, err := beginProfileRead(ctx, database, viewer, subject)
	if err != nil {
		return ListPostsResult{Posts: []Post{}}, err
	}
	defer tx.Rollback()
	result, err := socialPostPageTx(ctx, tx, viewer, page, per, ` AND p.status='published' AND p.author_id=?`, subject)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// SocialProfileComments lists the subject's comments on published, readable posts.
func SocialProfileComments(ctx context.Context, database *sql.DB, viewer, subject int64, page, per int) (ListCommentsResult, error) {
	result := ListCommentsResult{Comments: []Comment{}}
	tx, err := beginProfileRead(ctx, database, viewer, subject)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	result.Comments, result.Total, err = socialCommentListTx(ctx, tx, viewer, ` AND p.status='published' AND c.user_id=?`, []any{subject}, false, page, per)
	if err != nil {
		return result, err
	}
	for i, c := range result.Comments {
		post, err := socialPostTx(ctx, tx, viewer, c.PostID)
		if err != nil {
			return result, err
		}
		if post.Group != nil {
			result.Comments[i].Post = &CommentParent{ID: post.ID, AuthorID: post.AuthorID, Author: post.Author, Title: post.NullableTitle, ImageURL: post.ImageURL, Categories: post.Categories, Likes: post.Likes, Dislikes: post.Dislikes, MyReaction: post.MyReaction, Group: post.Group}
		}
	}
	return result, tx.Commit()
}

func socialCategoriesWithPosts(ctx context.Context, database *sql.DB, viewer int64) ([]CategoryWithPosts, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,name FROM categories ORDER BY name,id`)
	if err != nil {
		return nil, err
	}
	result := []CategoryWithPosts{}
	for rows.Next() {
		var c CategoryWithPosts
		c.Posts = []Post{}
		if err := rows.Scan(&c.ID, &c.Name); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		rows, err := tx.QueryContext(ctx, `SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id JOIN post_categories pc ON pc.post_id=p.id WHERE pc.category_id=?2 AND p.status='published' AND `+contentPermission+` ORDER BY p.created_at DESC,p.id DESC`, viewer, result[i].ID)
		if err != nil {
			return nil, err
		}
		ids := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			p, err := socialPostTx(ctx, tx, viewer, id)
			if err != nil {
				return nil, err
			}
			result[i].Posts = append(result[i].Posts, p)
		}
	}
	return result, tx.Commit()
}

// PostNavigation neighbours are the older/newer published posts the viewer may
// read that satisfy the same category and Following filters as the source.
func socialNavigation(ctx context.Context, database *sql.DB, viewer, post, category, group int64, following bool) (*PostNavigation, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	filter := ` AND p.status='published'`
	args := []any{}
	if category != 0 {
		filter += ` AND EXISTS(SELECT 1 FROM post_categories pc WHERE pc.post_id=p.id AND pc.category_id=?)`
		args = append(args, category)
	}
	if group != 0 {
		// A group scope is members-only: anyone else cannot tell the group exists.
		if err := requireGroupMember(ctx, tx, viewer, group); err != nil {
			return nil, err
		}
		filter += ` AND p.group_id=?`
		args = append(args, group)
	}
	if following {
		filter += ` AND EXISTS(SELECT 1 FROM follows ff WHERE ff.follower_id=?1 AND ff.followed_id=p.author_id AND ff.state='accepted')`
	}
	var source int64
	err = tx.QueryRowContext(ctx, `SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id WHERE `+contentPermission+filter+` AND p.id=?`, append(append([]any{viewer}, args...), post)...).Scan(&source)
	if err != nil {
		return nil, err
	}
	var nav PostNavigation
	for _, dir := range []struct {
		cmp, order string
		target     **int64
	}{{"<", "DESC", &nav.PrevID}, {">", "ASC", &nav.NextID}} {
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id
 WHERE `+contentPermission+filter+` AND (p.created_at,p.id) `+dir.cmp+` (SELECT created_at,id FROM posts WHERE id=?)
 ORDER BY p.created_at `+dir.order+`,p.id `+dir.order+` LIMIT 1`, append(append([]any{viewer}, args...), post)...).Scan(&id)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if err == nil {
			*dir.target = &id
		}
	}
	return &nav, tx.Commit()
}

func activityComment(ctx context.Context, tx *sql.Tx, viewer int64, c Comment) (UserActivityComment, error) {
	p, err := socialPostTx(ctx, tx, viewer, c.PostID)
	if err != nil {
		return UserActivityComment{}, err
	}
	return UserActivityComment{ID: c.ID, PostID: c.PostID, UserID: c.UserID, Username: c.Username, ParentCommentID: c.ParentCommentID, Body: c.Body, ImageURL: c.ImageURL, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt, Likes: c.Likes, Dislikes: c.Dislikes, MyReaction: c.MyReaction, Version: c.Version,
		Post: UserActivityCommentPost{ID: p.ID, AuthorID: p.AuthorID, Author: p.Author, Title: p.Title, NullableTitle: p.NullableTitle, ImageURL: p.ImageURL, Categories: p.Categories, Likes: p.Likes, Dislikes: p.Dislikes, MyReaction: p.MyReaction, Group: p.Group}}, nil
}

// SocialActivityResult is the owner's private history, read from one snapshot.
// Every section counts and pages only content whose parent is readable now.
type SocialActivityResult struct {
	Created, Liked, Disliked ListPostsResult
	Comments                 ListUserCommentsWithPostResult
}

func SocialActivity(ctx context.Context, database *sql.DB, viewer int64, page, per int, status *string) (SocialActivityResult, error) {
	var result SocialActivityResult
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	created, args := ` AND p.author_id=?`, []any{viewer}
	if status != nil {
		created += ` AND p.status=?`
		args = append(args, *status)
	}
	if result.Created, err = socialPostPageTx(ctx, tx, viewer, page, per, created, args...); err != nil {
		return result, err
	}
	for _, section := range []struct {
		target *ListPostsResult
		value  int
	}{{&result.Liked, ReactionLike}, {&result.Disliked, ReactionDislike}} {
		*section.target, err = socialPostPageTx(ctx, tx, viewer, page, per, ` AND EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.user_id=? AND r.value=?)`, viewer, section.value)
		if err != nil {
			return result, err
		}
	}
	comments, total, err := socialCommentListTx(ctx, tx, viewer, ` AND c.user_id=?`, []any{viewer}, false, page, per)
	if err != nil {
		return result, err
	}
	result.Comments = ListUserCommentsWithPostResult{Comments: []UserActivityComment{}, Total: total}
	for _, c := range comments {
		item, err := activityComment(ctx, tx, viewer, c)
		if err != nil {
			return result, err
		}
		result.Comments.Comments = append(result.Comments.Comments, item)
	}
	return result, tx.Commit()
}

func socialUserComments(ctx context.Context, database *sql.DB, viewer int64, in ListUserCommentsWithPostParams) (ListUserCommentsWithPostResult, error) {
	result := ListUserCommentsWithPostResult{Comments: []UserActivityComment{}}
	if in.UserID != viewer {
		return result, sql.ErrNoRows
	}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	comments, total, err := socialCommentListTx(ctx, tx, viewer, ` AND c.user_id=?`, []any{viewer}, false, in.Page, in.PerPage)
	if err != nil {
		return result, err
	}
	result.Total = total
	for _, c := range comments {
		item, err := activityComment(ctx, tx, viewer, c)
		if err != nil {
			return result, err
		}
		result.Comments = append(result.Comments, item)
	}
	return result, tx.Commit()
}
func socialDraft(ctx context.Context, database *sql.DB, viewer, user int64) (*Draft, error) {
	if viewer != user {
		return nil, sql.ErrNoRows
	}
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM posts WHERE author_id=? AND status='draft' AND group_id IS NULL ORDER BY updated_at DESC,id DESC LIMIT 1`, viewer).Scan(&id); err != nil {
		return nil, err
	}
	p, err := socialPostTx(ctx, tx, viewer, id)
	if err != nil {
		return nil, err
	}
	d := &Draft{ID: p.ID, Title: p.Title, Body: p.Body, ImageURL: p.ImageURL, UpdatedAt: p.UpdatedAt, CategoryIDs: []int64{}}
	for _, c := range p.Categories {
		d.CategoryIDs = append(d.CategoryIDs, c.ID)
	}
	return d, tx.Commit()
}

func socialReactionCounts(ctx context.Context, database *sql.DB, viewer, id int64, kind string) (int, int, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	column := "post_id"
	if kind == "comment" {
		column = "comment_id"
		_, err = requireCommentAccess(ctx, tx, viewer, id, false)
	} else {
		err = requirePostAccess(ctx, tx, viewer, id, false)
	}
	if err != nil {
		return 0, 0, err
	}
	var likes, dislikes int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(value=1),0),COALESCE(SUM(value=-1),0) FROM reactions WHERE `+column+`=?`, id).Scan(&likes, &dislikes); err != nil {
		return 0, 0, err
	}
	return likes, dislikes, tx.Commit()
}
