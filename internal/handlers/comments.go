// Internal/handlers/comments.go
package handlers

import (
	"database/sql"
	"errors"
	repository "forum/internal/db"
	"log"
	"net/http"
	"strings"
)

/*-------------------------------------
  HandleComment: /api/v1/comment/{id}
-------------------------------------*/

func (p *PostsHandler) HandleComment(w http.ResponseWriter, r *http.Request) {
	commentID, action, ok := resolveCommentRoute(w, r)
	if !ok {
		return
	}

	switch action {

	case "":
		switch r.Method {
		case http.MethodGet:
			p.getComment(w, r, commentID)
		case http.MethodPatch:
			p.updateComment(w, r, commentID)
		case http.MethodDelete:
			p.deleteComment(w, r, commentID)
		default:
			MethodNotAllowed(w, r)
		}
	case "like":
		if r.Method == http.MethodPost {
			p.handleReaction(w, r, commentID, 1, "comment")
			return
		}
		MethodNotAllowed(w, r)

	case "dislike":
		if r.Method == http.MethodPost {
			p.handleReaction(w, r, commentID, -1, "comment")
			return
		}
		MethodNotAllowed(w, r)

	default:
		notFound(w, r)
	}
}

func (p *PostsHandler) getComment(w http.ResponseWriter, r *http.Request, commentID int64) {
	comment, err := repository.GetCommentWithAuthor(r.Context(), p.conn, commentID)
	if err != nil {
		log.Printf("failed to load comment: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		WriteError(
			w,
			r,
			NewError("INTERNAL_SERVER_ERROR", "error loading comment", http.StatusInternalServerError),
		)
		return
	}

	WriteOK(w, comment, nil)
}

func (p *PostsHandler) updateComment(w http.ResponseWriter, r *http.Request, commentID int64) {
	userID, ok := requireUserID(w, r)

	if !ok {
		return
	}

	//fetching comment to check ownership
	comment, err := repository.GetCommentWithAuthor(r.Context(), p.conn, commentID)
	if err != nil {
		log.Printf("failed to load comment for update: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading comment", http.StatusInternalServerError))
		return
	}

	if comment.UserID != userID {
		WriteError(w, r, NewError("FORBIDDEN", "you are not allowed to update this comment", http.StatusForbidden))
		return
	}

	updateReq, cleanupMultipartForm, ok := parseCommentUpdateRequest(w, r)
	if !ok {
		return
	}
	if cleanupMultipartForm != nil {
		defer cleanupMultipartForm()
	}
	defer updateReq.Image.closeUploadFile()

	if !resolveImageUpdateRequest(w, r, &updateReq.Image, "failed to save updated comment image") {
		return
	}

	if updateReq.Body == nil && !updateReq.Image.HasImageUpdate {
		WriteError(w, r, NewError("BAD_REQUEST", "nothing to update", http.StatusBadRequest))
		return
	}

	finalBody := comment.Body
	if updateReq.Body != nil {
		finalBody = *updateReq.Body
	}

	finalImageURL := comment.ImageURL
	if updateReq.Image.HasImageUpdate {
		finalImageURL = updateReq.Image.ImageURL
	}

	if strings.TrimSpace(finalBody) == "" && finalImageURL == nil {
		cleanupUploadedPath(updateReq.Image.UploadPath)
		WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
		return
	}

	if err := repository.UpdateComment(
		r.Context(),
		p.conn,
		commentID,
		repository.UpdateCommentInput{
			Body:           updateReq.Body,
			ImageURL:       updateReq.Image.ImageURL,
			HasImageUpdate: updateReq.Image.HasImageUpdate,
		},
	); err != nil {
		cleanupUploadedPath(updateReq.Image.UploadPath)
		log.Printf("failed to update comment: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error updating comment", http.StatusInternalServerError))
		return
	}

	if imageURLToCleanup, shouldCleanup := replacedOrRemovedImageURL(comment.ImageURL, finalImageURL); shouldCleanup {
		if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, imageURLToCleanup); err != nil {
			log.Printf("failed to cleanup replaced comment image (comment_id=%d, image_url=%q): %v", commentID, imageURLToCleanup, err)
		}
	}

	updatedComment, err := repository.GetCommentWithAuthor(r.Context(), p.conn, commentID)
	if err != nil {
		log.Printf("failed to load updated comment: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "comment updated but failed to load", http.StatusInternalServerError))
	}
	WriteOK(w, updatedComment, nil)
}

func (p *PostsHandler) deleteComment(w http.ResponseWriter, r *http.Request, commentID int64) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	// Fetching comment to check ownership
	comment, err := repository.GetCommentWithAuthor(r.Context(), p.conn, commentID)
	if err != nil {
		log.Printf("failed to load comment for deletion: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading comment", http.StatusInternalServerError))
		return
	}
	if comment.UserID != userID {
		WriteError(w, r, NewError("FORBIDDEN", "you are not allowed to delete this comment", http.StatusForbidden))
		return
	}

	if err := repository.DeleteComment(r.Context(), p.conn, commentID); err != nil {
		log.Printf("failed to delete comment: %v", err)
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error deleting comment", http.StatusInternalServerError))
		return
	}

	if comment.ImageURL != nil {
		if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, *comment.ImageURL); err != nil {
			log.Printf("failed to cleanup comment image after delete (comment_id=%d, image_url=%q): %v", commentID, *comment.ImageURL, err)
		}
	}
	WriteNoContent(w)
}
