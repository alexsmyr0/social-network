package db

import (
	"context"
	"database/sql"
)

func socialPostTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Post, error) {
	var p Post
	var first, last string
	var nick, image, title sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT p.id,p.author_id,u.first_name,u.last_name,u.nickname,p.title,p.image_url,p.body,p.status,p.created_at,p.updated_at,p.audience,p.content_version
 FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=?2 AND `+contentPermission, viewer, id).Scan(&p.ID, &p.AuthorID, &first, &last, &nick, &title, &image, &p.Body, &p.Status, &p.CreatedAt, &p.UpdatedAt, &p.Audience, &p.Version)
	if err != nil {
		return p, err
	}
	if title.Valid {
		p.Title = title.String
		p.NullableTitle = &title.String
	}
	if p.AuthorID == viewer {
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
	result := ListPostsResult{Posts: []Post{}}
	page, per = normalizePagination(page, per)
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	values := append([]any{viewer}, args...)
	from := ` FROM posts p JOIN users u ON u.id=p.author_id WHERE ` + contentPermission + extra
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, values...).Scan(&result.Total); err != nil {
		return result, err
	}
	params := append(append([]any{}, values...), per, (page-1)*per)
	rows, err := tx.QueryContext(ctx, `SELECT p.id`+from+` ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`, params...)
	if err != nil {
		return result, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
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
	return result, tx.Commit()
}

func socialCommentTx(ctx context.Context, tx *sql.Tx, viewer, id int64) (Comment, error) {
	var c Comment
	var parent sql.NullInt64
	var image sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT c.id,c.post_id,c.user_id,c.parent_comment_id,c.body,c.image_url,c.created_at,c.updated_at
 FROM comments c JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id
 JOIN users ca ON ca.id=c.user_id AND ca.is_active=1 WHERE c.id=?2 AND `+contentPermission, viewer, id).Scan(&c.ID, &c.PostID, &c.UserID, &parent, &c.Body, &image, &c.CreatedAt, &c.UpdatedAt)
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
func socialCommentPage(ctx context.Context, database *sql.DB, viewer, post, user int64, page, per int) (ListCommentsResult, error) {
	result := ListCommentsResult{Comments: []Comment{}}
	page, per = normalizePagination(page, per)
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if post != 0 {
		if err := requirePostAccess(ctx, tx, viewer, post, false); err != nil {
			return result, err
		}
	}
	where := contentPermission + ` AND ca.is_active=1`
	args := []any{viewer}
	if post != 0 {
		where += ` AND c.post_id=?`
		args = append(args, post)
	}
	if user != 0 {
		where += ` AND c.user_id=?`
		args = append(args, user)
	}
	from := ` FROM comments c JOIN users ca ON ca.id=c.user_id JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id WHERE ` + where
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, args...).Scan(&result.Total); err != nil {
		return result, err
	}
	params := append(append([]any{}, args...), per, (page-1)*per)
	rows, err := tx.QueryContext(ctx, `SELECT c.id`+from+` ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`, params...)
	if err != nil {
		return result, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		c, err := socialCommentTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		result.Comments = append(result.Comments, c)
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
func socialNavigation(ctx context.Context, database *sql.DB, viewer, post, category int64) (*PostNavigation, error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requirePostAccess(ctx, tx, viewer, post, false); err != nil {
		return nil, err
	}
	var nav PostNavigation
	for _, dir := range []struct {
		cmp, order string
		target     **int64
	}{{"<", "DESC", &nav.PrevID}, {">", "ASC", &nav.NextID}} {
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT p.id FROM posts p JOIN users u ON u.id=p.author_id JOIN post_categories pc ON pc.post_id=p.id
 WHERE pc.category_id=?2 AND p.status='published' AND `+contentPermission+` AND (p.created_at,p.id) `+dir.cmp+` (SELECT created_at,id FROM posts WHERE id=?3)
 ORDER BY p.created_at `+dir.order+`,p.id `+dir.order+` LIMIT 1`, viewer, category, post).Scan(&id)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if err == nil {
			*dir.target = &id
		}
	}
	return &nav, tx.Commit()
}

func socialUserComments(ctx context.Context, database *sql.DB, viewer int64, in ListUserCommentsWithPostParams) (ListUserCommentsWithPostResult, error) {
	result := ListUserCommentsWithPostResult{Comments: []UserActivityComment{}}
	if in.UserID != viewer {
		return result, sql.ErrNoRows
	}
	page, per := normalizePagination(in.Page, in.PerPage)
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	from := ` FROM comments c JOIN users ca ON ca.id=c.user_id JOIN posts p ON p.id=c.post_id JOIN users u ON u.id=p.author_id WHERE c.user_id=?1 AND ca.is_active=1 AND ` + contentPermission
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*)`+from, viewer).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT c.id`+from+` ORDER BY c.created_at DESC,c.id DESC LIMIT ?2 OFFSET ?3`, viewer, per, (page-1)*per)
	if err != nil {
		return result, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	for _, id := range ids {
		c, err := socialCommentTx(ctx, tx, viewer, id)
		if err != nil {
			return result, err
		}
		p, err := socialPostTx(ctx, tx, viewer, c.PostID)
		if err != nil {
			return result, err
		}
		result.Comments = append(result.Comments, UserActivityComment{ID: c.ID, PostID: c.PostID, UserID: c.UserID, Username: c.Username, ParentCommentID: c.ParentCommentID, Body: c.Body, ImageURL: c.ImageURL, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt, Likes: c.Likes, Dislikes: c.Dislikes, MyReaction: c.MyReaction, Post: UserActivityCommentPost{ID: p.ID, AuthorID: p.AuthorID, Author: p.Author, Title: p.Title, ImageURL: p.ImageURL, Categories: p.Categories, Likes: p.Likes, Dislikes: p.Dislikes, MyReaction: p.MyReaction}})
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
	if err := tx.QueryRowContext(ctx, `SELECT id FROM posts WHERE author_id=? AND status='draft' ORDER BY updated_at DESC,id DESC LIMIT 1`, viewer).Scan(&id); err != nil {
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
