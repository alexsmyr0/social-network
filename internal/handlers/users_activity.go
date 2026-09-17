// internal/handlers/users_activity.go
package handlers

import (
	"log"
	"net/http"

	repository "forum/internal/db"
	"forum/internal/middleware"
)

/* -------------------------
   RESPONSE STRUCTURES
--------------------------*/

type postsActivitySection struct {
	Items      []repository.Post `json:"items"`
	Pagination *PaginationMeta   `json:"pagination"`
}

type commentsActivitySection struct {
	Items      []repository.UserActivityComment `json:"items"`
	Pagination *PaginationMeta                  `json:"pagination"`
}

type userActivityResponse struct {
	CreatedPosts  postsActivitySection    `json:"created_posts"`
	LikedPosts    postsActivitySection    `json:"liked_posts"`
	DislikedPosts postsActivitySection    `json:"disliked_posts"`
	Comments      commentsActivitySection `json:"comments"`
}

/* -------------------------
   HANDLER
--------------------------*/

func (u *UsersHandler) GetUserActivity(w http.ResponseWriter, r *http.Request) {
	userID, err := middleware.GetUserID(r.Context())
	if err != nil {
		WriteError(w, r, NewError(
			"UNAUTHORIZED",
			"login required",
			http.StatusUnauthorized,
		))
		return
	}

	page, perPage := sanitizePagination(r)

	statusPtr, err := parsePostStatusFilter(r)
	if err != nil {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"invalid status",
			http.StatusBadRequest,
		))
		return
	}

	/* -------------------------
	   CREATED POSTS
	--------------------------*/
	createdResult, err := repository.ListPostsByAuthor(
		r.Context(),
		u.conn,
		repository.ListPostsByAuthorParams{
			AuthorID: userID,
			Page:     page,
			PerPage:  perPage,
			Status:   statusPtr,
		},
		userID,
	)
	if err != nil {
		log.Printf("user activity - created posts error: %v", err)
		internalActivityError(w, r)
		return
	}

	/* -------------------------
	   LIKED POSTS
	--------------------------*/
	likedResult, err := repository.ListPostsByUserReaction(
		r.Context(),
		u.conn,
		repository.ListPostsByUserReactionParams{
			UserID:   userID,
			Page:     page,
			PerPage:  perPage,
			Reaction: repository.ReactionLike,
		},
		userID,
	)
	if err != nil {
		log.Printf("user activity - liked posts error: %v", err)
		internalActivityError(w, r)
		return
	}

	/* -------------------------
	   DISLIKED POSTS
	--------------------------*/
	dislikedResult, err := repository.ListPostsByUserReaction(
		r.Context(),
		u.conn,
		repository.ListPostsByUserReactionParams{
			UserID:   userID,
			Page:     page,
			PerPage:  perPage,
			Reaction: repository.ReactionDislike,
		},
		userID,
	)
	if err != nil {
		log.Printf("user activity - disliked posts error: %v", err)
		internalActivityError(w, r)
		return
	}

	/* -------------------------
	   COMMENTS
	--------------------------*/
	commentsResult, err := repository.ListUserCommentsWithPost(
		r.Context(),
		u.conn,
		repository.ListUserCommentsWithPostParams{
			UserID:  userID,
			Page:    page,
			PerPage: perPage,
		},
	)
	if err != nil {
		log.Printf("user activity - comments error: %v", err)
		internalActivityError(w, r)
		return
	}

	resp := userActivityResponse{
		CreatedPosts: postsActivitySection{
			Items:      createdResult.Posts,
			Pagination: makePaginationMeta(page, perPage, createdResult.Total),
		},
		LikedPosts: postsActivitySection{
			Items:      likedResult.Posts,
			Pagination: makePaginationMeta(page, perPage, likedResult.Total),
		},
		DislikedPosts: postsActivitySection{
			Items:      dislikedResult.Posts,
			Pagination: makePaginationMeta(page, perPage, dislikedResult.Total),
		},
		Comments: commentsActivitySection{
			Items:      commentsResult.Comments,
			Pagination: makePaginationMeta(page, perPage, commentsResult.Total),
		},
	}

	WriteOK(w, resp, nil)
}

/* -------------------------
   HELPERS
--------------------------*/

func internalActivityError(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError(
		"INTERNAL_SERVER_ERROR",
		"error loading user activity",
		http.StatusInternalServerError,
	))
}

func makePaginationMeta(page, perPage, total int) *PaginationMeta {
	if perPage <= 0 {
		perPage = 1
	}

	totalPages := 0
	if total > 0 {
		totalPages = (total + perPage - 1) / perPage
	}

	return &PaginationMeta{
		Page:       page,
		PerPage:    perPage,
		Total:      total,
		TotalPages: totalPages,
	}
}
