// internal/db/users_activity.go
package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type UserActivityCommentPost struct {
	ID         int64          `json:"id"`
	AuthorID   int64          `json:"author_id"`
	Author     string         `json:"author"`
	Title      string         `json:"title"`
	ImageURL   *string        `json:"image_url"`
	Categories []PostCategory `json:"categories"`
	Likes      int            `json:"likes"`
	Dislikes   int            `json:"dislikes"`
	MyReaction int            `json:"my_reaction"`
}

type UserActivityComment struct {
	ID              int64                   `json:"id"`
	PostID          int64                   `json:"post_id"`
	UserID          int64                   `json:"user_id"`
	Username        string                  `json:"username"`
	ParentCommentID *int64                  `json:"parent_comment_id,omitempty"`
	Body            string                  `json:"body"`
	ImageURL        *string                 `json:"image_url"`
	CreatedAt       string                  `json:"created_at"`
	UpdatedAt       string                  `json:"updated_at,omitempty"`
	Likes           int                     `json:"likes"`
	Dislikes        int                     `json:"dislikes"`
	MyReaction      int                     `json:"my_reaction"`
	Post            UserActivityCommentPost `json:"post"`
}

type ListUserCommentsWithPostParams struct {
	UserID  int64
	Page    int
	PerPage int
}

type ListUserCommentsWithPostResult struct {
	Comments []UserActivityComment
	Total    int
}

func ListUserCommentsWithPost(
	ctx context.Context,
	db *sql.DB,
	p ListUserCommentsWithPostParams,
) (ListUserCommentsWithPostResult, error) {
	p.Page, p.PerPage = normalizePagination(p.Page, p.PerPage)

	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	total, err := countUserComments(ctx, db, p.UserID)
	if err != nil {
		return ListUserCommentsWithPostResult{}, err
	}

	comments, err := fetchUserCommentsWithPost(ctx, db, p)
	if err != nil {
		return ListUserCommentsWithPostResult{}, err
	}
	if err := attachUserActivityCommentPostCategories(ctx, db, comments); err != nil {
		return ListUserCommentsWithPostResult{}, err
	}
	if err := attachUserActivityCommentPostReactions(ctx, db, comments, p.UserID); err != nil {
		return ListUserCommentsWithPostResult{}, err
	}
	if err := attachUserActivityCommentMyReactions(ctx, db, comments, p.UserID); err != nil {
		return ListUserCommentsWithPostResult{}, err
	}

	return ListUserCommentsWithPostResult{
		Comments: comments,
		Total:    total,
	}, nil
}

func attachUserActivityCommentPostCategories(
	ctx context.Context,
	db *sql.DB,
	comments []UserActivityComment,
) error {
	for i := range comments {
		categories, err := getCategoriesByPostID(ctx, db, comments[i].Post.ID)
		if err != nil {
			return err
		}
		comments[i].Post.Categories = categories
	}
	return nil
}

func attachUserActivityCommentPostReactions(
	ctx context.Context,
	db *sql.DB,
	comments []UserActivityComment,
	viewerID int64,
) error {
	if len(comments) == 0 {
		return nil
	}

	for i := range comments {
		likes, dislikes, err := CountReactionsForPost(ctx, db, comments[i].Post.ID)
		if err != nil {
			return err
		}
		comments[i].Post.Likes = likes
		comments[i].Post.Dislikes = dislikes
		comments[i].Post.MyReaction = 0
	}

	if viewerID <= 0 {
		return nil
	}

	postIDs := make([]int64, 0, len(comments))
	seen := make(map[int64]struct{}, len(comments))
	for _, comment := range comments {
		if _, ok := seen[comment.Post.ID]; ok {
			continue
		}
		seen[comment.Post.ID] = struct{}{}
		postIDs = append(postIDs, comment.Post.ID)
	}
	if len(postIDs) == 0 {
		return nil
	}

	query := `
		SELECT post_id, value
		FROM reactions
		WHERE user_id = ?
		  AND post_id IS NOT NULL
		  AND post_id IN (` + placeholders(len(postIDs)) + `)
	`

	args := make([]any, 0, len(postIDs)+1)
	args = append(args, viewerID)
	for _, id := range postIDs {
		args = append(args, id)
	}

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	reactionMap := make(map[int64]int, len(postIDs))
	for rows.Next() {
		var postID int64
		var reaction int
		if err := rows.Scan(&postID, &reaction); err != nil {
			return err
		}
		reactionMap[postID] = reaction
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for i := range comments {
		if reaction, ok := reactionMap[comments[i].Post.ID]; ok {
			comments[i].Post.MyReaction = reaction
		}
	}

	return nil
}

func attachUserActivityCommentMyReactions(
	ctx context.Context,
	db *sql.DB,
	comments []UserActivityComment,
	viewerID int64,
) error {
	if viewerID <= 0 || len(comments) == 0 {
		return nil
	}

	commentIDs := make([]int64, 0, len(comments))
	seen := make(map[int64]struct{}, len(comments))

	for _, comment := range comments {
		if _, ok := seen[comment.ID]; ok {
			continue
		}
		seen[comment.ID] = struct{}{}
		commentIDs = append(commentIDs, comment.ID)
	}

	query := `
		SELECT comment_id, value
		FROM reactions
		WHERE user_id = ?
		  AND comment_id IS NOT NULL
		  AND comment_id IN (` + placeholders(len(commentIDs)) + `)
	`

	args := make([]any, 0, len(commentIDs)+1)
	args = append(args, viewerID)
	for _, id := range commentIDs {
		args = append(args, id)
	}

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	reactionMap := make(map[int64]int, len(commentIDs))
	for rows.Next() {
		var commentID int64
		var reaction int
		if err := rows.Scan(&commentID, &reaction); err != nil {
			return err
		}
		reactionMap[commentID] = reaction
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for i := range comments {
		comments[i].MyReaction = reactionMap[comments[i].ID]
	}

	return nil
}

func countUserComments(ctx context.Context, db *sql.DB, userID int64) (int, error) {
	var total int
	if err := db.QueryRowContext(
		ctx,
		`SELECT COUNT(*) FROM comments WHERE user_id = ?`,
		userID,
	).Scan(&total); err != nil {
		return 0, fmt.Errorf("count user comments: %w", err)
	}
	return total, nil
}

func fetchUserCommentsWithPost(
	ctx context.Context,
	db *sql.DB,
	p ListUserCommentsWithPostParams,
) ([]UserActivityComment, error) {
	offset := (p.Page - 1) * p.PerPage

	rows, err := db.QueryContext(ctx, `
		SELECT
			c.id,
			c.post_id,
			c.user_id,
			cu.username,
			c.parent_comment_id,
			c.body,
			c.image_url,
			c.created_at,
			c.updated_at,
			post.id,
			post.author_id,
			pu.username,
			post.title,
			post.image_url,
			IFNULL(rc.likes, 0) AS likes,
			IFNULL(rc.dislikes, 0) AS dislikes
		FROM comments c
		JOIN users cu ON cu.id = c.user_id
		JOIN posts post ON post.id = c.post_id
		JOIN users pu ON pu.id = post.author_id
		LEFT JOIN (
			SELECT
				comment_id,
				SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
				SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
			FROM reactions
			WHERE comment_id IS NOT NULL
			GROUP BY comment_id
		) rc ON rc.comment_id = c.id
		WHERE c.user_id = ?
		ORDER BY c.created_at DESC
		LIMIT ? OFFSET ?
	`, p.UserID, p.PerPage, offset)
	if err != nil {
		return nil, fmt.Errorf("query user comments: %w", err)
	}
	defer rows.Close()

	comments := make([]UserActivityComment, 0)

	for rows.Next() {
		var comment UserActivityComment
		var parentID sql.NullInt64
		var commentImageURL sql.NullString
		var postImageURL sql.NullString

		if err := rows.Scan(
			&comment.ID,
			&comment.PostID,
			&comment.UserID,
			&comment.Username,
			&parentID,
			&comment.Body,
			&commentImageURL,
			&comment.CreatedAt,
			&comment.UpdatedAt,
			&comment.Post.ID,
			&comment.Post.AuthorID,
			&comment.Post.Author,
			&comment.Post.Title,
			&postImageURL,
			&comment.Likes,
			&comment.Dislikes,
		); err != nil {
			return nil, fmt.Errorf("scan user comment: %w", err)
		}

		if parentID.Valid {
			id := parentID.Int64
			comment.ParentCommentID = &id
		}
		if commentImageURL.Valid {
			comment.ImageURL = &commentImageURL.String
		}
		if postImageURL.Valid {
			comment.Post.ImageURL = &postImageURL.String
		}

		comments = append(comments, comment)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows user comments: %w", err)
	}

	return comments, nil
}
