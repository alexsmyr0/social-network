// internal/handlers/posts.go
package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"

	repository "forum/internal/db"
	"forum/internal/middleware"
)

type PostsHandler struct {
	conn *sql.DB
}

func NewPostsHandler(database *sql.DB) *PostsHandler {
	return &PostsHandler{conn: database}
}

const (
	ReactionTargetPost    = "post"
	ReactionTargetComment = "comment"
)

/*----------------------------
  HandlePosts: /api/v1/posts
----------------------------*/

func (p *PostsHandler) HandlePosts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		p.listPosts(w, r)
	case http.MethodPost:
		p.createPost(w, r)
	default:
		MethodNotAllowed(w, r)
	}
}

/*------------
  LIST POSTS
------------*/

func (p *PostsHandler) listPosts(w http.ResponseWriter, r *http.Request) {
	page, perPage := sanitizePagination(r)

	// Get logged-in user ID (0 if guest)
	userID, _ := middleware.GetUserID(r.Context())

	// Filter by category (optional)
	if categoryIDStr := r.URL.Query().Get("category_id"); categoryIDStr != "" {
		categoryID, err := strconv.ParseInt(categoryIDStr, 10, 64)
		if err != nil || categoryID <= 0 {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid category_id", http.StatusBadRequest))
			return
		}

		result, err := repository.ListPostsByCategory(
			r.Context(),
			p.conn,
			repository.ListPostsByCategoryParams{
				CategoryID: categoryID,
				Page:       page,
				PerPage:    perPage,
			},
			userID,
		)
		if err != nil {
			log.Printf("failed to list posts by category: %v", err)
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing posts", http.StatusInternalServerError))
			return
		}

		totalPages := (result.Total + perPage - 1) / perPage

		meta := &Meta{
			Pagination: &PaginationMeta{
				Page:       page,
				PerPage:    perPage,
				Total:      result.Total,
				TotalPages: totalPages,
			},
		}

		WriteOK(w, result.Posts, meta)
		return
	}

	// Default: list all posts
	result, err := repository.ListPosts(
		r.Context(),
		p.conn,
		repository.ListPostsParams{
			Page:    page,
			PerPage: perPage,
		},
		userID,
	)
	if err != nil {
		log.Printf("failed to list posts: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing posts", http.StatusInternalServerError))
		return
	}

	totalPages := (result.Total + perPage - 1) / perPage

	meta := &Meta{
		Pagination: &PaginationMeta{
			Page:       page,
			PerPage:    perPage,
			Total:      result.Total,
			TotalPages: totalPages,
		},
	}

	WriteOK(w, result.Posts, meta)
}

func (p *PostsHandler) createPost(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req struct {
		Title       string  `json:"title"`
		ImageURL    *string `json:"image_url"`
		Body        string  `json:"body"`
		Status      string  `json:"status"`
		CategoryIDs []int64 `json:"category_ids"`
	}

	var (
		uploadFile     multipart.File
		uploadMime     string
		uploadPath     string
		hasImageUpload bool
	)

	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		cleanupMultipartForm, ok := parseMultipartForm(w, r)
		if !ok {
			return
		}
		defer cleanupMultipartForm()

		req.Title = r.FormValue("title")
		req.Body = r.FormValue("body")
		req.Status = r.FormValue("status")

		categoryIDs, err := parseCategoryIDs(r.Form["category_ids"])
		if err != nil {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid category_id", http.StatusBadRequest))
			return
		}
		req.CategoryIDs = categoryIDs

		file, mime, hasUpload, ok := parseImageUpload(w, r)
		if !ok {
			return
		}
		if hasUpload {
			uploadFile = file
			defer uploadFile.Close()
			uploadMime = mime
			hasImageUpload = true
		}
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid json", http.StatusBadRequest))
			return
		}
	}

	if strings.TrimSpace(req.Title) == "" {
		WriteError(w, r, NewError("BAD_REQUEST", "title required", http.StatusBadRequest))
		return
	}

	if strings.TrimSpace(req.Body) == "" && !hasImageUpload && req.ImageURL == nil {
		WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
		return
	}

	for _, cid := range req.CategoryIDs {
		if cid <= 0 {
			WriteError(w, r, NewError(
				"BAD_REQUEST",
				"at least one valid category is required",
				http.StatusBadRequest,
			))
			return
		}
	}

	status := "published"
	if strings.ToLower(req.Status) == "draft" {
		status = "draft"
	}

	if status == "published" && len(req.CategoryIDs) == 0 {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"at least one category is required",
			http.StatusBadRequest,
		))
		return
	}

	if uploadFile != nil {
		imageURL, imagePath, err := saveUploadedImage(uploadFile, uploadMime)
		if err != nil {
			log.Printf("failed to save image: %v", err)
			WriteError(w, r, NewError(
				"INTERNAL_SERVER_ERROR",
				"error saving image",
				http.StatusInternalServerError,
			))
			return
		}
		req.ImageURL = &imageURL
		uploadPath = imagePath
	}

	postID, err := repository.CreatePostWithCategories(
		r.Context(),
		p.conn,
		userID,
		req.Title,
		req.Body,
		status,
		req.CategoryIDs,
		req.ImageURL,
	)
	if err != nil {
		if uploadPath != "" {
			_ = os.Remove(uploadPath)
		}
		log.Printf("failed to create post: %v", err)
		WriteError(w, r, NewError(
			"INTERNAL_SERVER_ERROR",
			"error creating post",
			http.StatusInternalServerError,
		))
		return
	}

	post, err := repository.GetPost(r.Context(), p.conn, postID)
	if err != nil {
		log.Printf("failed to load post after creation: %v", err)
		WriteError(w, r, NewError(
			"INTERNAL_SERVER_ERROR",
			"post created but failed to load",
			http.StatusInternalServerError,
		))
		return
	}

	WriteCreated(w, post)
}

/*--------------------------------
  HandlePost: /api/v1/posts/{id}
--------------------------------*/

func (p *PostsHandler) HandlePost(w http.ResponseWriter, r *http.Request) {
	postID, action, ok := resolvePostRoute(w, r)
	if !ok {
		return
	}

	switch action {

	case "":
		switch r.Method {
		case http.MethodGet:
			p.getPost(w, r, postID)
		case http.MethodPatch:
			p.updatePost(w, r, postID)
		case http.MethodDelete:
			p.deletePost(w, r, postID)
		default:
			MethodNotAllowed(w, r)
		}

	case "like":
		if r.Method == http.MethodPost {
			p.handleReaction(w, r, postID, 1, ReactionTargetPost)
			return
		}
		MethodNotAllowed(w, r)

	case "dislike":
		if r.Method == http.MethodPost {
			p.handleReaction(w, r, postID, -1, ReactionTargetPost)
			return
		}
		MethodNotAllowed(w, r)

	case "comments":
		switch r.Method {
		case http.MethodGet:
			p.listComments(w, r, postID)
		case http.MethodPost:
			p.createComment(w, r, postID)
		default:
			MethodNotAllowed(w, r)
		}

	case "nav":
		if r.Method == http.MethodGet {
			p.getPostNavigation(w, r, postID)
			return
		}
		MethodNotAllowed(w, r)

	default:
		notFound(w, r)
	}
}

/*-------------
 POST ACTIONS
-------------*/

func (p *PostsHandler) getPost(w http.ResponseWriter, r *http.Request, postID int64) {
	post, err := repository.GetPost(r.Context(), p.conn, postID)
	if err != nil {
		log.Printf("failed to load post: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading post", http.StatusInternalServerError))
		return
	}

	viewerID, _ := middleware.GetUserID(r.Context())
	if viewerID > 0 {
		reaction, err := repository.GetUserReactionForPost(r.Context(), p.conn, viewerID, postID)
		if err != nil {
			log.Printf("failed to load viewer reaction for post %d: %v", postID, err)
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading post", http.StatusInternalServerError))
			return
		}
		post.MyReaction = reaction
	}

	WriteOK(w, post, nil)
}

func (p *PostsHandler) updatePost(w http.ResponseWriter, r *http.Request, postID int64) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	existingPost, err := repository.GetPost(r.Context(), p.conn, postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		log.Printf("failed to load post for update: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading post", http.StatusInternalServerError))
		return
	}
	if existingPost.AuthorID != userID {
		WriteError(w, r, NewError(
			"FORBIDDEN",
			"not allowed",
			http.StatusForbidden,
		))
		return
	}

	updateReq, cleanupMultipartForm, ok := parsePostUpdateRequest(w, r)
	if !ok {
		return
	}
	if cleanupMultipartForm != nil {
		defer cleanupMultipartForm()
	}
	defer updateReq.Image.closeUploadFile()

	if updateReq.Title != nil && strings.TrimSpace(*updateReq.Title) == "" {
		WriteError(w, r, NewError("BAD_REQUEST", "title required", http.StatusBadRequest))
		return
	}

	normalizedStatus := ""
	if updateReq.Status != nil {
		normalizedStatus = strings.ToLower(strings.TrimSpace(*updateReq.Status))
		if normalizedStatus != "draft" && normalizedStatus != "published" {
			WriteError(w, r, NewError(
				"BAD_REQUEST",
				"invalid status",
				http.StatusBadRequest,
			))
			return
		}
	}

	if updateReq.HasCategoryUpdate {
		for _, cid := range updateReq.CategoryIDs {
			if cid <= 0 {
				WriteError(w, r, NewError("BAD_REQUEST", "invalid category_id", http.StatusBadRequest))
				return
			}
		}
	}

	if !resolveImageUpdateRequest(w, r, &updateReq.Image, "failed to save updated image") {
		return
	}

	hasContentUpdate := updateReq.Title != nil || updateReq.Body != nil || updateReq.Image.HasImageUpdate || updateReq.HasCategoryUpdate
	if !hasContentUpdate && updateReq.Status == nil {
		WriteError(w, r, NewError("BAD_REQUEST", "nothing to update", http.StatusBadRequest))
		return
	}

	finalBody := strings.TrimSpace(existingPost.Body)
	if updateReq.Body != nil {
		finalBody = strings.TrimSpace(*updateReq.Body)
	}

	finalImageURL := existingPost.ImageURL
	if updateReq.Image.HasImageUpdate {
		finalImageURL = updateReq.Image.ImageURL
	}

	if finalBody == "" && finalImageURL == nil {
		cleanupUploadedPath(updateReq.Image.UploadPath)
		WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
		return
	}

	finalStatus := strings.ToLower(strings.TrimSpace(existingPost.Status))
	if finalStatus == "" {
		finalStatus = "published"
	}
	if updateReq.Status != nil {
		finalStatus = normalizedStatus
	}

	finalCategoryCount := len(existingPost.Categories)
	if updateReq.HasCategoryUpdate {
		seen := make(map[int64]struct{}, len(updateReq.CategoryIDs))
		for _, cid := range updateReq.CategoryIDs {
			if cid <= 0 {
				continue
			}
			seen[cid] = struct{}{}
		}
		finalCategoryCount = len(seen)
	}
	// Check if categories are ment to be updates but categoriescount == 0
	if finalStatus == "published" && finalCategoryCount == 0 && updateReq.HasCategoryUpdate {
		cleanupUploadedPath(updateReq.Image.UploadPath)
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"at least one category is required",
			http.StatusBadRequest,
		))
		return
	}

	if hasContentUpdate {
		if err := repository.UpdatePostContent(
			r.Context(),
			p.conn,
			postID,
			repository.UpdatePostInput{
				Title:             updateReq.Title,
				Body:              updateReq.Body,
				ImageURL:          updateReq.Image.ImageURL,
				HasImageUpdate:    updateReq.Image.HasImageUpdate,
				CategoryIDs:       updateReq.CategoryIDs,
				HasCategoryUpdate: updateReq.HasCategoryUpdate,
			},
		); err != nil {
			cleanupUploadedPath(updateReq.Image.UploadPath)
			if errors.Is(err, sql.ErrNoRows) {
				WriteError(w, r, NewError("NOT_FOUND", "error updating post", http.StatusNotFound))
				return
			}
			if errors.Is(err, repository.ErrInvalidPostCategoryUpdate) {
				WriteError(w, r, NewError("BAD_REQUEST", "invalid category_id", http.StatusBadRequest))
				return
			}
			log.Printf("failed to update post content: %v", err)
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error updating post", http.StatusInternalServerError))
			return
		}
	}

	if updateReq.Status != nil {
		if err := repository.UpdatePostStatus(
			r.Context(),
			p.conn,
			postID,
			userID,
			normalizedStatus,
		); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				WriteError(w, r, NewError("NOT_FOUND", "error updating post", http.StatusNotFound))
				return
			}
			log.Printf("failed to update post status: %v", err)
			WriteError(w, r, NewError(
				"INTERNAL_SERVER_ERROR",
				"error updating post status",
				http.StatusInternalServerError,
			))
			return
		}
	}

	if imageURLToCleanup, shouldCleanup := replacedOrRemovedImageURL(existingPost.ImageURL, finalImageURL); shouldCleanup {
		if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, imageURLToCleanup); err != nil {
			log.Printf("failed to cleanup replaced post image (post_id=%d, image_url=%q): %v", postID, imageURLToCleanup, err)
		}
	}

	WriteOK(w, map[string]string{"status": "updated"}, nil)
}

func (p *PostsHandler) deletePost(w http.ResponseWriter, r *http.Request, postID int64) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	if !p.requirePostAuthor(w, r, postID, userID) {
		return
	}

	imageURLs, err := collectPostRelatedImageURLs(r.Context(), p.conn, postID)
	if err != nil {
		log.Printf("failed to collect post image URLs before deletion (post_id=%d): %v", postID, err)
		imageURLs = nil
	}

	if err := repository.DeletePost(r.Context(), p.conn, postID); err != nil {
		log.Printf("failed to delete post: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error deleting post", http.StatusInternalServerError))
		return
	}

	for _, imageURL := range imageURLs {
		if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, imageURL); err != nil {
			log.Printf("failed to cleanup post-related image after post deletion (post_id=%d, image_url=%q): %v", postID, imageURL, err)
		}
	}

	WriteNoContent(w)
}

/*----------
  MY POSTS
----------*/

func (p *PostsHandler) ListMyPosts(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	page, perPage := sanitizePagination(r)

	statusPtr, err := parsePostStatusFilter(r)
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid status", http.StatusBadRequest))
		return
	}

	result, err := repository.ListPostsByAuthor(
		r.Context(),
		p.conn,
		repository.ListPostsByAuthorParams{
			AuthorID: userID,
			Page:     page,
			PerPage:  perPage,
			Status:   statusPtr,
		},
		userID,
	)
	if err != nil {
		log.Printf("failed to list posts by author: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing user posts", http.StatusInternalServerError))
		return
	}

	totalPages := (result.Total + perPage - 1) / perPage

	meta := &Meta{
		Pagination: &PaginationMeta{
			Page:       page,
			PerPage:    perPage,
			Total:      result.Total,
			TotalPages: totalPages,
		},
	}

	WriteOK(w, result.Posts, meta)
}

func (p *PostsHandler) ListLikedPosts(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	page, perPage := sanitizePagination(r)

	result, err := repository.ListPostsByUserReaction(
		r.Context(),
		p.conn,
		repository.ListPostsByUserReactionParams{
			UserID:   userID,
			Page:     page,
			PerPage:  perPage,
			Reaction: repository.ReactionLike,
		},
		userID,
	)
	if err != nil {
		log.Printf("failed to list liked posts: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing liked posts", http.StatusInternalServerError))
		return
	}

	totalPages := (result.Total + perPage - 1) / perPage

	meta := &Meta{
		Pagination: &PaginationMeta{
			Page:       page,
			PerPage:    perPage,
			Total:      result.Total,
			TotalPages: totalPages,
		},
	}

	WriteOK(w, result.Posts, meta)
}

func (p *PostsHandler) ListDislikedPosts(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	page, perPage := sanitizePagination(r)

	result, err := repository.ListPostsByUserReaction(
		r.Context(),
		p.conn,
		repository.ListPostsByUserReactionParams{
			UserID:   userID,
			Page:     page,
			PerPage:  perPage,
			Reaction: repository.ReactionDislike,
		},
		userID,
	)
	if err != nil {
		log.Printf("failed to list disliked posts: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing disliked posts", http.StatusInternalServerError))
		return
	}

	totalPages := (result.Total + perPage - 1) / perPage

	meta := &Meta{
		Pagination: &PaginationMeta{
			Page:       page,
			PerPage:    perPage,
			Total:      result.Total,
			TotalPages: totalPages,
		},
	}

	WriteOK(w, result.Posts, meta)
}

/*----------------------------------
  POST NAVIGATION (CATEGORY AWARE)
----------------------------------*/

// GET /api/v1/posts/{id}/nav?category_id=3
func (p *PostsHandler) getPostNavigation(
	w http.ResponseWriter,
	r *http.Request,
	postID int64,
) {
	categoryIDStr := r.URL.Query().Get("category_id")
	if categoryIDStr == "" {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"category_id is required for post navigation",
			http.StatusBadRequest,
		))
		return
	}

	categoryID, err := strconv.ParseInt(categoryIDStr, 10, 64)
	if err != nil || categoryID <= 0 {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"invalid category_id",
			http.StatusBadRequest,
		))
		return
	}

	result, err := repository.GetPostNavigationByCategory(
		r.Context(),
		p.conn,
		postID,
		categoryID,
	)
	if err != nil {
		log.Printf("failed to get post navigation: %v", err)
		WriteError(w, r, NewError(
			"INTERNAL_SERVER_ERROR",
			"failed to load post navigation",
			http.StatusInternalServerError,
		))
		return
	}

	WriteOK(w, map[string]any{
		"category_id": categoryID,
		"prev_id":     result.PrevID,
		"next_id":     result.NextID,
	}, nil)
}

/*------------
  REACTIONS
------------*/

func (p *PostsHandler) handleReaction(
	w http.ResponseWriter,
	r *http.Request,
	objectID int64,
	targetReaction int,
	targetType string,
) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	reaction, err := repository.ToggleReaction(
		r.Context(),
		p.conn,
		userID,
		objectID,
		targetReaction,
		targetType,
	)
	if errors.Is(err, repository.ErrNotFound) {
		WriteError(w, r, NewError("NOT_FOUND", "target not found", http.StatusNotFound))
		return
	}
	if err != nil {
		log.Printf("ToggleReaction failed: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error toggling reaction", http.StatusInternalServerError))
		return
	}

	var likesCount, dislikesCount int

	switch targetType {
	case ReactionTargetPost:
		likesCount, dislikesCount, err = repository.CountReactionsForPost(r.Context(), p.conn, objectID)
	case ReactionTargetComment:
		likesCount, dislikesCount, err = repository.CountReactionsForComment(r.Context(), p.conn, objectID)
	default:
		WriteError(w, r, NewError("BAD_REQUEST", "invalid target type", http.StatusBadRequest))
		return
	}

	if err != nil {
		log.Printf("failed to count reactions: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error counting reactions", http.StatusInternalServerError))
		return
	}

	idKey := "post_id"
	if targetType == ReactionTargetComment {
		idKey = "comment_id"
	}

	WriteOK(w, map[string]any{
		idKey:            objectID,
		"reaction":       reaction,
		"likes_count":    likesCount,
		"dislikes_count": dislikesCount,
	}, nil)
}

/*----------
  COMMENTS
----------*/

func (p *PostsHandler) listComments(w http.ResponseWriter, r *http.Request, postID int64) {
	page, perPage := sanitizePagination(r)

	viewerID, _ := middleware.GetUserID(r.Context())

	listResult, err := repository.ListCommentsByPost(
		r.Context(),
		p.conn,
		repository.ListCommentsParams{
			PostID:  postID,
			Page:    page,
			PerPage: perPage,
		},
		viewerID,
	)
	if err != nil {
		log.Printf("failed to list comments: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error listing comments", http.StatusInternalServerError))
		return
	}

	totalPages := (listResult.Total + perPage - 1) / perPage

	meta := &Meta{
		Pagination: &PaginationMeta{
			Page:       page,
			PerPage:    perPage,
			Total:      listResult.Total,
			TotalPages: totalPages,
		},
	}

	WriteOK(w, listResult.Comments, meta)
}

func (p *PostsHandler) createComment(w http.ResponseWriter, r *http.Request, postID int64) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req struct {
		Body            string  `json:"body"`
		ImageURL        *string `json:"image_url"`
		ParentCommentID *int64  `json:"parent_comment_id"`
	}

	var (
		uploadFile     multipart.File
		uploadMime     string
		uploadPath     string
		hasImageUpload bool
	)

	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		cleanupMultipartForm, ok := parseMultipartForm(w, r)
		if !ok {
			return
		}
		defer cleanupMultipartForm()

		req.Body = r.FormValue("body")

		if raw := strings.TrimSpace(r.FormValue("image_url")); raw != "" {
			req.ImageURL = &raw
		}

		if rawParent := strings.TrimSpace(r.FormValue("parent_comment_id")); rawParent != "" {
			parentID, err := strconv.ParseInt(rawParent, 10, 64)
			if err != nil || parentID <= 0 {
				WriteError(w, r, NewError("BAD_REQUEST", "invalid parent_comment_id", http.StatusBadRequest))
				return
			}
			req.ParentCommentID = &parentID
		}

		file, mime, hasUpload, ok := parseImageUpload(w, r)
		if !ok {
			return
		}
		if hasUpload {
			uploadFile = file
			defer uploadFile.Close()
			uploadMime = mime
			hasImageUpload = true
		}
	} else {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid json", http.StatusBadRequest))
			return
		}
	}

	if req.ParentCommentID != nil && *req.ParentCommentID <= 0 {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid parent_comment_id", http.StatusBadRequest))
		return
	}

	if strings.TrimSpace(req.Body) == "" && !hasImageUpload && req.ImageURL == nil {
		WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
		return
	}

	if uploadFile != nil {
		imageURL, imagePath, err := saveUploadedImage(uploadFile, uploadMime)
		if err != nil {
			log.Printf("failed to save comment image: %v", err)
			WriteError(w, r, NewError(
				"INTERNAL_SERVER_ERROR",
				"error saving image",
				http.StatusInternalServerError,
			))
			return
		}
		req.ImageURL = &imageURL
		uploadPath = imagePath
	}

	// Create comment
	commentID, err := repository.CreateComment(
		r.Context(),
		p.conn,
		repository.CreateCommentInput{
			PostID:          postID,
			UserID:          userID,
			ParentCommentID: req.ParentCommentID,
			Body:            req.Body,
			ImageURL:        req.ImageURL,
		},
	)
	if err != nil {
		if uploadPath != "" {
			_ = os.Remove(uploadPath)
		}
		log.Printf("failed to create comment: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error creating comment", http.StatusInternalServerError))
		return
	}

	// Reload comment WITH author
	comment, err := repository.GetCommentWithAuthor(
		r.Context(),
		p.conn,
		commentID,
	)
	if err != nil {
		log.Printf("comment created but failed to load hydrated comment: %v", err)
		WriteError(w, r, NewError(
			"INTERNAL_SERVER_ERROR",
			"comment created but failed to load",
			http.StatusInternalServerError,
		))
		return
	}

	// Return hydrated comment
	WriteCreated(w, comment)
}

// GET /api/v1/posts/{id}/comments
func (p *PostsHandler) ListPostComments(w http.ResponseWriter, r *http.Request) {
	postID, ok := getPostIDFromURL(w, r)
	if !ok {
		return
	}
	p.listComments(w, r, postID)
}

// POST /api/v1/posts/{id}/comments
func (p *PostsHandler) CreateComment(w http.ResponseWriter, r *http.Request) {
	postID, ok := getPostIDFromURL(w, r)
	if !ok {
		return
	}
	p.createComment(w, r, postID)
}
