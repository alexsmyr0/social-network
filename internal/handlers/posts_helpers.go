// Internal/handlers/posts_helpers.go
package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	repository "forum/internal/db"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const maxUploadSize int64 = 20 << 20

type imageTypeValidationError struct {
	message string
}

func (e *imageTypeValidationError) Error() string {
	return e.message
}

func resolvePostRoute(w http.ResponseWriter, r *http.Request) (postID int64, action string, ok bool) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/posts/")
	parts := strings.Split(strings.Trim(path, "/"), "/")

	if len(parts) > 2 {
		notFound(w, r)
		return 0, "", false
	}
	if len(parts) == 0 || parts[0] == "" {
		notFound(w, r)
		return 0, "", false
	}

	id, err := parsePositiveID(parts[0])
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid post id", http.StatusBadRequest))
		return 0, "", false
	}

	if len(parts) > 1 {
		action = strings.Split(parts[1], "?")[0]
	}

	return id, action, true
}

func parsePostStatusFilter(r *http.Request) (*string, error) {
	status := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))

	switch status {
	case "", "all":
		return nil, nil
	case "draft", "published":
		return &status, nil
	default:
		return nil, errors.New("invalid status filter")
	}
}

func (p *PostsHandler) requirePostAuthor(w http.ResponseWriter, r *http.Request, postID int64, userID int64) bool {
	authorID, err := repository.GetPostAuthorID(r.Context(), p.conn, postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return false
		}
		log.Printf("failed to load post author: %v", err)
		WriteError(w, r, NewError(
			"INTERNAL_SERVER_ERROR",
			"error loading post",
			http.StatusInternalServerError,
		))
		return false
	}

	if authorID != userID {
		WriteError(w, r, NewError(
			"FORBIDDEN",
			"not allowed",
			http.StatusForbidden,
		))
		return false
	}

	return true
}

func parseCategoryIDs(values []string) ([]int64, error) {
	if len(values) == 0 {
		return nil, nil
	}
	ids := make([]int64, 0, len(values))
	for _, raw := range values {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return nil, errors.New("invalid category_id")
		}
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			return nil, errors.New("invalid category_id")
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func multipartFieldValues(form *multipart.Form, key string) ([]string, bool) {
	if form == nil {
		return nil, false
	}
	values, exists := form.Value[key]
	if !exists {
		return nil, false
	}
	return values, true
}

func multipartFirstValue(form *multipart.Form, key string) (*string, bool) {
	values, exists := multipartFieldValues(form, key)
	if !exists {
		return nil, false
	}

	value := ""
	if len(values) > 0 {
		value = values[0]
	}
	return &value, true
}

func multipartFirstTrimmedValue(form *multipart.Form, key string) (*string, bool) {
	value, exists := multipartFirstValue(form, key)
	if !exists {
		return nil, false
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed, true
}

func multipartOptionalBool(form *multipart.Form, key string) (*bool, error) {
	raw, exists := multipartFirstTrimmedValue(form, key)
	if !exists || raw == nil || *raw == "" {
		return nil, nil
	}

	parsed, err := strconv.ParseBool(*raw)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func parseMultipartForm(w http.ResponseWriter, r *http.Request) (func(), bool) {
	limit := maxUploadSize
	if _, ok := repository.SocialViewer(r.Context()); ok {
		limit = 10 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(limit); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			WriteError(w, r, NewError("PAYLOAD_TOO_LARGE", "upload too large", http.StatusRequestEntityTooLarge))
			return nil, false
		}
		WriteError(w, r, NewError("BAD_REQUEST", "invalid multipart form", http.StatusBadRequest))
		return nil, false
	}

	cleanup := func() {}
	if r.MultipartForm != nil {
		cleanup = func() {
			_ = r.MultipartForm.RemoveAll()
		}
	}
	return cleanup, true
}

func parseImageUpload(w http.ResponseWriter, r *http.Request) (file multipart.File, mime string, hasUpload bool, ok bool) {
	file, fileHeader, err := r.FormFile("image")
	if err == nil {
		if _, social := repository.SocialViewer(r.Context()); social {
			_ = file.Close()
			data, kind, apiErr := readAvatar(fileHeader)
			if apiErr != nil {
				if apiErr.Code == "INVALID_AVATAR" {
					apiErr = NewError("INVALID_IMAGE", "invalid image", http.StatusUnprocessableEntity)
					apiErr.Fields = map[string]string{"image": "INVALID_IMAGE"}
				}
				WriteError(w, r, apiErr)
				return nil, "", false, false
			}
			return memoryImage{bytes.NewReader(data)}, kind, true, true
		}
		mime, err = validateImageType(file, fileHeader.Filename)
		if err != nil {
			_ = file.Close()
			var typeErr *imageTypeValidationError
			if errors.As(err, &typeErr) {
				WriteError(w, r, NewError("BAD_REQUEST", typeErr.Error(), http.StatusBadRequest))
				return nil, "", false, false
			}
			WriteError(w, r, NewError("BAD_REQUEST", "invalid image upload", http.StatusBadRequest))
			return nil, "", false, false
		}
		return file, mime, true, true
	}
	if errors.Is(err, http.ErrMissingFile) {
		return nil, "", false, true
	}

	WriteError(w, r, NewError("BAD_REQUEST", "invalid image upload", http.StatusBadRequest))
	return nil, "", false, false
}

func validateImageType(file io.ReadSeeker, filename string) (string, error) {
	buf := make([]byte, 512)
	n, err := file.Read(buf)
	if err != nil && err != io.EOF {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}

	mime := http.DetectContentType(buf[:n])
	switch mime {
	case "image/jpeg", "image/png", "image/gif":
		return mime, nil
	default:
		ext := strings.ToLower(filepath.Ext(filename))
		if ext != "" {
			return "", &imageTypeValidationError{
				message: fmt.Sprintf(
					"unsupported image type: detected %s from file content (filename extension is %s). Supported formats: JPEG, PNG, GIF",
					mime,
					ext,
				),
			}
		}
		return "", &imageTypeValidationError{
			message: fmt.Sprintf(
				"unsupported image type: detected %s from file content. Supported formats: JPEG, PNG, GIF",
				mime,
			),
		}
	}
}

func saveUploadedImage(file io.Reader, mime string) (string, string, error) {
	return saveUploadedImageToSubdir(file, mime, "")
}

// saveUploadedImageToSubdir writes the upload under web/static/uploads[/subdir]
// and returns the public URL and on-disk path. subdir is a single, hardcoded
// path segment (e.g. "dm"); pass "" for the uploads root. It exists so DM image
// uploads can live under uploads/dm/ while sharing the type→extension mapping
// and copy logic with the post/comment path.
func saveUploadedImageToSubdir(file io.Reader, mime, subdir string) (string, string, error) {
	var ext string
	switch mime {
	case "image/jpeg":
		ext = ".jpg"
	case "image/png":
		ext = ".png"
	case "image/gif":
		ext = ".gif"
	default:
		return "", "", errors.New("unsupported image type")
	}

	dir := filepath.Join("web", "static", "uploads")
	urlPrefix := "/static/uploads/"
	if subdir != "" {
		dir = filepath.Join(dir, subdir)
		urlPrefix += subdir + "/"
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", "", err
	}

	filename := uuid.New().String() + ext
	diskPath := filepath.Join(dir, filename)

	dst, err := os.OpenFile(diskPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return "", "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		_ = os.Remove(diskPath)
		return "", "", err
	}

	return urlPrefix + filename, diskPath, nil
}

// Collects all related Image urls of a post for deletion
func collectPostRelatedImageURLs(ctx context.Context, dbConn *sql.DB, postID int64) ([]string, error) {
	rawURLs, err := repository.GetPostRelatedImageURLs(ctx, dbConn, postID)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]struct{})
	var urls []string
	for _, raw := range rawURLs {
		if normalized, ok := repository.NormalizeUploadedImageURL(raw); ok {
			if _, exists := seen[normalized]; exists {
				continue
			}
			seen[normalized] = struct{}{}
			urls = append(urls, normalized)
		}
	}

	return urls, nil
}

func maybeDeleteUploadedImageByURL(ctx context.Context, dbConn *sql.DB, imageURL string) error {
	if _, social := repository.SocialViewer(ctx); social {
		return repository.CleanupMedia(ctx, dbConn, false)
	}
	normalizedURL, ok := repository.NormalizeUploadedImageURL(imageURL)
	if !ok {
		return nil
	}

	refs, err := repository.GetImageUsageCount(ctx, dbConn, normalizedURL)
	if err != nil {
		return err
	}
	if refs > 0 {
		return nil
	}

	diskPath, ok := repository.GetUploadedImageDiskPath(normalizedURL)
	if !ok {
		return nil
	}
	if err := os.Remove(diskPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

type memoryImage struct{ *bytes.Reader }

func (memoryImage) Close() error { return nil }
func saveRequestImage(r *http.Request, database *sql.DB, file io.Reader, mime string) (string, string, error) {
	if viewer, ok := repository.SocialViewer(r.Context()); ok {
		data, err := io.ReadAll(io.LimitReader(file, avatarMaxBytes+1))
		if err != nil {
			return "", "", err
		}
		if len(data) > avatarMaxBytes {
			return "", "", repository.ErrInvalidInput
		}
		return repository.StageMedia(r.Context(), database, viewer, 0, "content", data, mime)
	}
	return saveUploadedImage(file, mime)
}
func cleanupStagedImage(r *http.Request, database *sql.DB, image *string) {
	if viewer, ok := repository.SocialViewer(r.Context()); ok && image != nil {
		if err := repository.DiscardStagedMedia(context.Background(), database, *image, viewer); err != nil {
			log.Printf("discard staged image: %v", err)
		}
	}
}
func (p *PostsHandler) guardContent(w http.ResponseWriter, r *http.Request, id int64, kind string, owner bool) bool {
	viewer, social := repository.SocialViewer(r.Context())
	if !social {
		return true
	}
	if err := repository.ContentRequestAccess(r.Context(), p.conn, viewer, id, kind, owner); err != nil {
		writeHandlerError(w, r, err, "failed to load content")
		return false
	}
	return true
}
