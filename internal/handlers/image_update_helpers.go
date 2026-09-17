// internal/handlers/image_update_helpers.go
package handlers

import (
	"encoding/json"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
)

type imageUpdateRequest struct {
	ImageURL       *string
	HasImageUpdate bool
	RemoveImage    bool

	UploadFile     multipart.File
	UploadMime     string
	UploadPath     string
	HasImageUpload bool
}

type postUpdateRequest struct {
	Title             *string
	Body              *string
	Status            *string
	CategoryIDs       []int64
	HasCategoryUpdate bool
	Image             imageUpdateRequest
}

type commentUpdateRequest struct {
	Body  *string
	Image imageUpdateRequest
}

func (u *imageUpdateRequest) closeUploadFile() {
	if u == nil || u.UploadFile == nil {
		return
	}
	_ = u.UploadFile.Close()
	u.UploadFile = nil
}

func cleanupUploadedPath(uploadPath string) {
	if uploadPath == "" {
		return
	}
	_ = os.Remove(uploadPath)
}

func applyImageURLField(update *imageUpdateRequest, raw *string) {
	if update == nil || raw == nil {
		return
	}
	trimmed := strings.TrimSpace(*raw)
	if trimmed == "" {
		update.ImageURL = nil
	} else {
		update.ImageURL = &trimmed
	}
	update.HasImageUpdate = true
}

func parseImageUpdateFromMultipart(
	w http.ResponseWriter,
	r *http.Request,
	update *imageUpdateRequest,
) bool {
	if update == nil {
		return false
	}

	if value, exists := multipartFirstTrimmedValue(r.MultipartForm, "image_url"); exists {
		applyImageURLField(update, value)
	}

	removeImage, err := multipartOptionalBool(r.MultipartForm, "remove_image")
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid remove_image flag", http.StatusBadRequest))
		return false
	}
	if removeImage != nil {
		update.RemoveImage = *removeImage
	}

	file, mime, hasUpload, ok := parseImageUpload(w, r)
	if !ok {
		return false
	}
	if hasUpload {
		update.UploadFile = file
		update.UploadMime = mime
		update.HasImageUpload = true
	}

	return true
}

func parsePostUpdateRequest(
	w http.ResponseWriter,
	r *http.Request,
) (postUpdateRequest, func(), bool) {
	updateReq := postUpdateRequest{}
	cleanup := func() {}

	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		cleanupMultipartForm, ok := parseMultipartForm(w, r)
		if !ok {
			return postUpdateRequest{}, nil, false
		}
		cleanup = cleanupMultipartForm

		if value, exists := multipartFirstValue(r.MultipartForm, "title"); exists {
			updateReq.Title = value
		}
		if value, exists := multipartFirstValue(r.MultipartForm, "body"); exists {
			updateReq.Body = value
		}
		if value, exists := multipartFirstValue(r.MultipartForm, "status"); exists {
			updateReq.Status = value
		}
		if values, exists := multipartFieldValues(r.MultipartForm, "category_ids"); exists {
			ids, err := parseCategoryIDs(values)
			if err != nil {
				cleanup()
				WriteError(w, r, NewError("BAD_REQUEST", "invalid category_id", http.StatusBadRequest))
				return postUpdateRequest{}, nil, false
			}
			updateReq.CategoryIDs = ids
			updateReq.HasCategoryUpdate = true
		}
		if !parseImageUpdateFromMultipart(w, r, &updateReq.Image) {
			cleanup()
			return postUpdateRequest{}, nil, false
		}
		return updateReq, cleanup, true
	}

	var req struct {
		Title       *string  `json:"title"`
		Body        *string  `json:"body"`
		Status      *string  `json:"status"`
		CategoryIDs *[]int64 `json:"category_ids"`
		ImageURL    *string  `json:"image_url"`
		RemoveImage *bool    `json:"remove_image"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid json", http.StatusBadRequest))
		return postUpdateRequest{}, nil, false
	}

	updateReq.Title = req.Title
	updateReq.Body = req.Body
	updateReq.Status = req.Status
	if req.CategoryIDs != nil {
		updateReq.CategoryIDs = *req.CategoryIDs
		updateReq.HasCategoryUpdate = true
	}
	applyImageURLField(&updateReq.Image, req.ImageURL)
	if req.RemoveImage != nil {
		updateReq.Image.RemoveImage = *req.RemoveImage
	}

	return updateReq, cleanup, true
}

func parseCommentUpdateRequest(
	w http.ResponseWriter,
	r *http.Request,
) (commentUpdateRequest, func(), bool) {
	updateReq := commentUpdateRequest{}
	cleanup := func() {}

	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(contentType, "multipart/form-data") {
		cleanupMultipartForm, ok := parseMultipartForm(w, r)
		if !ok {
			return commentUpdateRequest{}, nil, false
		}
		cleanup = cleanupMultipartForm

		if value, exists := multipartFirstValue(r.MultipartForm, "body"); exists {
			updateReq.Body = value
		}
		if !parseImageUpdateFromMultipart(w, r, &updateReq.Image) {
			cleanup()
			return commentUpdateRequest{}, nil, false
		}
		return updateReq, cleanup, true
	}

	var req struct {
		Body        *string `json:"body"`
		ImageURL    *string `json:"image_url"`
		RemoveImage *bool   `json:"remove_image"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid json", http.StatusBadRequest))
		return commentUpdateRequest{}, nil, false
	}

	updateReq.Body = req.Body
	applyImageURLField(&updateReq.Image, req.ImageURL)
	if req.RemoveImage != nil {
		updateReq.Image.RemoveImage = *req.RemoveImage
	}

	return updateReq, cleanup, true
}

func resolveImageUpdateRequest(
	w http.ResponseWriter,
	r *http.Request,
	update *imageUpdateRequest,
	saveImageLogMessage string,
) bool {
	if update == nil {
		return false
	}

	if update.RemoveImage && update.HasImageUpload {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"remove_image cannot be combined with image upload",
			http.StatusBadRequest,
		))
		return false
	}

	if update.RemoveImage && update.HasImageUpdate && update.ImageURL != nil {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"remove_image cannot be combined with image_url",
			http.StatusBadRequest,
		))
		return false
	}

	if update.UploadFile != nil {
		savedImageURL, imagePath, err := saveUploadedImage(update.UploadFile, update.UploadMime)
		if err != nil {
			log.Printf("%s: %v", saveImageLogMessage, err)
			WriteError(w, r, NewError(
				"INTERNAL_SERVER_ERROR",
				"error saving image",
				http.StatusInternalServerError,
			))
			return false
		}
		update.ImageURL = &savedImageURL
		update.HasImageUpdate = true
		update.UploadPath = imagePath
	}

	if update.RemoveImage && !update.HasImageUpload {
		update.ImageURL = nil
		update.HasImageUpdate = true
	}

	return true
}
