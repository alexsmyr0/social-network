// internal/handlers/drafts.go
package handlers

import (
	"database/sql"
	"encoding/json"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"strings"

	repository "forum/internal/db"
)

func (p *PostsHandler) HandleDraft(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	switch r.Method {

	case http.MethodGet:
		post, err := repository.DraftGet(r.Context(), p.conn, userID)
		if err == sql.ErrNoRows {
			WriteOK(w, nil, nil)
			return
		}
		if err != nil {
			WriteError(w, r, NewError("INTERNAL", "load draft failed", 500))
			return
		}
		WriteOK(w, post, nil)

	case http.MethodPost:
		var req struct {
			Title       string  `json:"title"`
			ImageURL    *string `json:"image_url"`
			Body        string  `json:"body"`
			CategoryIDs []int64 `json:"category_ids"`
			Manual      bool    `json:"manual"`
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
			if raw := strings.TrimSpace(r.FormValue("image_url")); raw != "" {
				req.ImageURL = &raw
			}
			if raw := strings.TrimSpace(r.FormValue("manual")); raw != "" {
				manual, err := strconv.ParseBool(raw)
				if err != nil {
					WriteError(w, r, NewError("BAD_REQUEST", "invalid manual flag", http.StatusBadRequest))
					return
				}
				req.Manual = manual
			}

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
		if req.ImageURL != nil && strings.TrimSpace(*req.ImageURL) == "" {
			req.ImageURL = nil
		}

		// Validation ONLY for manual "Save Draft"
		if req.Manual {
			if strings.TrimSpace(req.Title) == "" {
				WriteError(w, r, NewError("BAD_REQUEST", "title required", http.StatusBadRequest))
				return
			}
			if strings.TrimSpace(req.Body) == "" && !hasImageUpload && req.ImageURL == nil {
				WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
				return
			}
			if len(req.CategoryIDs) == 0 {
				WriteError(w, r, NewError("BAD_REQUEST", "at least one category required", http.StatusBadRequest))
				return
			}
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

		id, err := repository.DraftCreate(
			r.Context(),
			p.conn,
			userID,
			req.Title,
			req.Body,
			req.CategoryIDs,
			req.ImageURL,
		)
		if err != nil {
			if uploadPath != "" {
				_ = os.Remove(uploadPath)
			}
			log.Printf("draft save failed: %v", err)
			WriteError(w, r, NewError(
				"INTERNAL_SERVER_ERROR",
				"save failed",
				http.StatusInternalServerError,
			))
			return
		}

		WriteOK(w, map[string]int64{"id": id}, nil)

	default:
		MethodNotAllowed(w, r)
	}
}

func (p *PostsHandler) HandleDraftByID(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) == 0 {
		WriteError(w, r, NewError("BAD_REQUEST", "missing draft id", http.StatusBadRequest))
		return
	}
	idStr := parts[len(parts)-1]

	draftID, err := parsePositiveID(idStr)
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid draft id", http.StatusBadRequest))
		return
	}

	switch r.Method {

	case http.MethodPut:
		var req struct {
			Title       string  `json:"title"`
			ImageURL    *string `json:"image_url"`
			Body        string  `json:"body"`
			CategoryIDs []int64 `json:"category_ids"`
			Manual      bool    `json:"manual"`
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
			if raw := strings.TrimSpace(r.FormValue("image_url")); raw != "" {
				req.ImageURL = &raw
			}
			if raw := strings.TrimSpace(r.FormValue("manual")); raw != "" {
				manual, err := strconv.ParseBool(raw)
				if err != nil {
					WriteError(w, r, NewError("BAD_REQUEST", "invalid manual flag", http.StatusBadRequest))
					return
				}
				req.Manual = manual
			}

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
		if req.ImageURL != nil && strings.TrimSpace(*req.ImageURL) == "" {
			req.ImageURL = nil
		}

		previousImageURL, err := repository.DraftGetImageURLByID(r.Context(), p.conn, userID, draftID)
		if err == sql.ErrNoRows {
			WriteError(w, r, NewError("NOT_FOUND", "draft not found", http.StatusNotFound))
			return
		}
		if err != nil {
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading draft", http.StatusInternalServerError))
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

		// Validation ONLY for manual update
		if req.Manual {
			if strings.TrimSpace(req.Title) == "" {
				WriteError(w, r, NewError("BAD_REQUEST", "title required", http.StatusBadRequest))
				return
			}
			hasImageURL := req.ImageURL != nil && strings.TrimSpace(*req.ImageURL) != ""
			if strings.TrimSpace(req.Body) == "" && !hasImageUpload && !hasImageURL {
				WriteError(w, r, NewError("BAD_REQUEST", "body required", http.StatusBadRequest))
				return
			}
			if len(req.CategoryIDs) == 0 {
				WriteError(w, r, NewError("BAD_REQUEST", "at least one category required", http.StatusBadRequest))
				return
			}
		}

		err = repository.DraftUpdate(
			r.Context(),
			p.conn,
			userID,
			draftID,
			req.Title,
			req.Body,
			req.CategoryIDs,
			req.ImageURL,
		)
		if err == sql.ErrNoRows {
			WriteError(w, r, NewError("NOT_FOUND", "draft not found", http.StatusNotFound))
			return
		}
		if err != nil {
			if uploadPath != "" {
				_ = os.Remove(uploadPath)
			}
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "update failed", http.StatusInternalServerError))
			return
		}

		if imageURLToCleanup, shouldCleanup := replacedOrRemovedImageURL(previousImageURL, req.ImageURL); shouldCleanup {
			if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, imageURLToCleanup); err != nil {
				log.Printf("failed to cleanup replaced draft image (draft_id=%d, image_url=%q): %v", draftID, imageURLToCleanup, err)
			}
		}

		WriteNoContent(w)
		return

	case http.MethodDelete:
		existingImageURL, err := repository.DraftGetImageURLByID(r.Context(), p.conn, userID, draftID)
		if err == sql.ErrNoRows {
			WriteError(w, r, NewError("NOT_FOUND", "draft not found", http.StatusNotFound))
			return
		}
		if err != nil {
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "error loading draft", http.StatusInternalServerError))
			return
		}

		err = repository.DraftDelete(r.Context(), p.conn, userID, draftID)
		if err == sql.ErrNoRows {
			WriteError(w, r, NewError("NOT_FOUND", "draft not found", http.StatusNotFound))
			return
		}
		if err != nil {
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "delete failed", http.StatusInternalServerError))
			return
		}

		if existingImageURL != nil {
			if err := maybeDeleteUploadedImageByURL(r.Context(), p.conn, *existingImageURL); err != nil {
				log.Printf("failed to cleanup draft image after delete (draft_id=%d, image_url=%q): %v", draftID, *existingImageURL, err)
			}
		}

		WriteNoContent(w)
		return

	default:
		MethodNotAllowed(w, r)
	}
}

func replacedOrRemovedImageURL(previous, next *string) (string, bool) {
	if previous == nil {
		return "", false
	}
	prev, ok := repository.NormalizeUploadedImageURL(*previous)
	if !ok {
		return "", false
	}
	if next == nil {
		return prev, true
	}
	nextNorm, ok := repository.NormalizeUploadedImageURL(*next)
	if !ok {
		return prev, true
	}
	if prev == nextNorm {
		return "", false
	}
	return prev, true
}
