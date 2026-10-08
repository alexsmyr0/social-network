package handlers

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"forum/internal/db"
)

func publishingError(w http.ResponseWriter, r *http.Request, err error) {
	var field *db.ContentFieldError
	switch {
	case errors.As(err, &field):
		WriteError(w, r, socialFieldError(field.Field, field.Code))
	case errors.Is(err, db.ErrStaleContent):
		WriteError(w, r, NewError("STALE_CONTENT", "Content changed; refresh and retry", 409))
	default:
		socialError(w, r, err)
	}
}
func publishingQuery(r *http.Request, kind string) (page, per int, feed, status string, category, expected int64, e *APIError) {
	values, e := urlQuery(r)
	if e != nil {
		return
	}
	page, per, feed, status = 1, 20, "all", "all"
	for k, v := range values {
		allowed := kind == "feed" && (k == "page" || k == "per_page" || k == "feed" || k == "category_id") || kind == "mine" && (k == "page" || k == "per_page" || k == "status") || kind == "delete" && k == "expected_version"
		if !allowed || len(v) != 1 {
			e = NewError("BAD_REQUEST", "invalid query", 400)
			return
		}
		switch k {
		case "page", "per_page", "category_id", "expected_version":
			n, err := socialID(v[0])
			if err != nil {
				e = err
				return
			}
			switch k {
			case "page":
				if n > 1000000 {
					e = NewError("BAD_REQUEST", "invalid pagination", 400)
					return
				}
				page = int(n)
			case "per_page":
				if n > 50 {
					e = NewError("BAD_REQUEST", "invalid pagination", 400)
					return
				}
				per = int(n)
			case "category_id":
				category = n
			case "expected_version":
				expected = n
			}
		case "feed":
			if v[0] != "all" && v[0] != "following" {
				e = NewError("BAD_REQUEST", "invalid feed", 400)
				return
			}
			feed = v[0]
		case "status":
			if v[0] != "all" && v[0] != "published" && v[0] != "draft" {
				e = NewError("BAD_REQUEST", "invalid status", 400)
				return
			}
			status = v[0]
		}
	}
	if kind == "delete" && expected == 0 {
		e = NewError("BAD_REQUEST", "expected_version required", 400)
	}
	return
}
func publishingText(raw json.RawMessage, field string, max int, nullable bool) (*string, *APIError) {
	if string(raw) == "null" {
		if nullable {
			return nil, nil
		}
		return nil, NewError("BAD_REQUEST", "invalid text field", 400)
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil, NewError("BAD_REQUEST", "invalid text field", 400)
	}
	if !utf8.ValidString(text) {
		return nil, NewError("BAD_REQUEST", "invalid UTF-8", 400)
	}
	if field == "body" {
		text = strings.ReplaceAll(text, "\r\n", "\n")
	}
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) > max {
		return nil, socialFieldError(field, "TOO_LONG")
	}
	for _, r := range text {
		if unicode.IsControl(r) && !(field == "body" && (r == '\n' || r == '\t')) {
			return nil, socialFieldError(field, "INVALID_TEXT")
		}
	}
	if nullable && text == "" {
		return nil, nil
	}
	return &text, nil
}
func publishingIDs(raw json.RawMessage, field string, max int) ([]int64, *APIError) {
	var values []json.RawMessage
	if len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &values) != nil {
		return nil, socialFieldError(field, "INVALID_IDS")
	}
	if len(values) > max {
		return nil, socialFieldError(field, "TOO_MANY")
	}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, v := range values {
		n, e := socialID(string(v))
		if e != nil || seen[n] {
			return nil, socialFieldError(field, "INVALID_IDS")
		}
		seen[n] = true
		ids = append(ids, n)
	}
	return ids, nil
}

// Multipart text fields keep their typed meaning without parsing structured JSON:
// arrays repeat, IDs/versions are decimal strings and flags are exactly true/false.
var (
	contentArrayFields = map[string]bool{"category_ids": true, "selected_follower_ids": true}
	contentIDFields    = map[string]bool{"expected_version": true, "parent_comment_id": true}
	contentBoolFields  = map[string]bool{"manual": true, "remove_image": true}
)

// readContentFields collects strict JSON or multipart text into raw JSON values.
// A nil cleanup with a nil error means the response was already written.
func readContentFields(w http.ResponseWriter, r *http.Request, keys []string) (fields map[string]json.RawMessage, upload bool, cleanup func(), e *APIError) {
	cleanup = func() {}
	allowed := map[string]bool{}
	for _, k := range keys {
		allowed[k] = true
	}
	fields = map[string]json.RawMessage{}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		e = NewError("UNSUPPORTED_MEDIA_TYPE", "expected JSON or multipart", 415)
		return
	}
	if mediaType == "multipart/form-data" {
		var ok bool
		cleanup, ok = parseMultipartForm(w, r)
		if !ok {
			return nil, false, nil, nil
		}
		for k, values := range r.MultipartForm.Value {
			if !allowed[k] {
				e = NewError("BAD_REQUEST", "unknown multipart field", 400)
				return
			}
			if contentArrayFields[k] {
				vals := []json.RawMessage{}
				for _, v := range values {
					if v == "" {
						if len(values) != 1 {
							e = NewError("BAD_REQUEST", "invalid array field", 400)
							return
						}
						break
					}
					n, err := socialID(v)
					if err != nil {
						e = socialFieldError(k, "INVALID_IDS")
						return
					}
					vals = append(vals, json.RawMessage(strconv.FormatInt(n, 10)))
				}
				fields[k], _ = json.Marshal(vals)
				continue
			}
			if len(values) != 1 || !utf8.ValidString(values[0]) {
				e = NewError("BAD_REQUEST", "invalid multipart scalar", 400)
				return
			}
			switch {
			case contentIDFields[k]:
				if _, err := socialID(values[0]); err != nil {
					e = err
					return
				}
				fields[k] = json.RawMessage(values[0])
			case contentBoolFields[k]:
				if values[0] != "true" && values[0] != "false" {
					e = NewError("BAD_REQUEST", "invalid boolean", 400)
					return
				}
				fields[k] = json.RawMessage(values[0])
			default:
				fields[k], _ = json.Marshal(values[0])
			}
		}
		for k, files := range r.MultipartForm.File {
			if k != "image" || len(files) != 1 {
				e = NewError("BAD_REQUEST", "invalid multipart file", 400)
				return
			}
		}
		upload = len(r.MultipartForm.File["image"]) == 1
		return
	}
	if mediaType != "application/json" {
		e = NewError("UNSUPPORTED_MEDIA_TYPE", "expected JSON or multipart", 415)
		return
	}
	e = decodeStrictObject(w, r, &fields, 64<<10, keys...)
	return
}

// Parse both encodings into the same presence-aware fields. Fresh files are
// validated here but staged only after resource ownership has been checked.
func parsePublishing(w http.ResponseWriter, r *http.Request, edit, draft bool) (in db.PublishingInput, image imageUpdateRequest, cleanup func(), e *APIError) {
	cleanup = func() {}
	keys := []string{"title", "body", "category_ids", "image_url", "remove_image", "audience", "selected_follower_ids"}
	if edit {
		keys = append(keys, "expected_version")
	}
	if !draft {
		keys = append(keys, "status")
	}
	if draft && !edit {
		keys = append(keys, "manual")
	}
	fields, upload, cleanup, e := readContentFields(w, r, keys)
	if cleanup == nil && e == nil {
		return in, image, nil, nil
	}
	image.HasImageUpload = upload
	if e != nil {
		return
	}
	if edit {
		raw, ok := fields["expected_version"]
		if !ok {
			e = NewError("BAD_REQUEST", "expected_version required", 400)
			return
		}
		in.ExpectedVersion, e = socialID(string(raw))
		if e != nil {
			return
		}
	}
	for k, raw := range fields {
		switch k {
		case "title", "image_url":
			if string(raw) == "null" {
				continue
			}
			fallthrough
		case "body", "status", "audience":
			var value string
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				e = NewError("BAD_REQUEST", "invalid field type", 400)
				return
			}
		case "remove_image", "manual":
			var value bool
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				e = NewError("BAD_REQUEST", "invalid field type", 400)
				return
			}
		}
	}
	for k, raw := range fields {
		switch k {
		case "title":
			in.HasTitle = true
			in.Title, e = publishingText(raw, k, 200, true)
		case "body":
			in.Body, e = publishingText(raw, k, 10000, false)
		case "status", "audience":
			var value string
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				e = NewError("BAD_REQUEST", "invalid enum field", 400)
				break
			}
			if k == "status" {
				if value != "published" && value != "draft" {
					e = socialFieldError(k, "INVALID_STATUS")
				}
				in.Status = &value
			} else {
				if value != "public" && value != "followers" && value != "selected" {
					e = socialFieldError(k, "INVALID_AUDIENCE")
				}
				in.Audience = &value
			}
		case "category_ids":
			in.HasCategories = true
			in.CategoryIDs, e = publishingIDs(raw, k, 50)
		case "selected_follower_ids":
			in.HasSelections = true
			in.SelectedFollowerIDs, e = publishingIDs(raw, k, 500)
		case "expected_version":
			in.ExpectedVersion, e = socialID(string(raw))
		case "image_url":
			image.HasImageUpdate = true
			if string(raw) != "null" {
				var value string
				if json.Unmarshal(raw, &value) != nil {
					e = NewError("BAD_REQUEST", "invalid image_url", 400)
					break
				}
				image.ImageURL = &value
			}
		case "remove_image", "manual":
			var value bool
			if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				e = NewError("BAD_REQUEST", "invalid boolean", 400)
				break
			}
			if k == "remove_image" {
				image.RemoveImage = value
			}
		}
		if e != nil {
			return
		}
	}
	if edit && in.ExpectedVersion == 0 {
		e = NewError("BAD_REQUEST", "expected_version required", 400)
		return
	}
	if edit && len(fields) == 1 && !image.HasImageUpload {
		e = NewError("BAD_REQUEST", "a change field is required", 400)
		return
	}
	if image.HasImageUpload && (image.RemoveImage || image.HasImageUpdate && image.ImageURL != nil && *image.ImageURL != "") || image.RemoveImage && image.ImageURL != nil && *image.ImageURL != "" {
		e = NewError("BAD_REQUEST", "conflicting image fields", 400)
		return
	}
	if image.HasImageUpload {
		file, kind, _, ok := parseImageUpload(w, r)
		if !ok {
			cleanup()
			cleanup = nil
			return
		}
		image.UploadFile = file
		image.UploadMime = kind
	}
	if image.HasImageUpload && image.ImageURL != nil && *image.ImageURL == "" {
		image.ImageURL = nil
	}
	if image.RemoveImage {
		image.HasImageUpdate = true
		image.ImageURL = nil
	}
	return
}
func (p *PostsHandler) publishingList(w http.ResponseWriter, r *http.Request, mine bool) {
	kind := "feed"
	if mine {
		kind = "mine"
	}
	page, per, feed, status, cat, _, e := publishingQuery(r, kind)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	result, err := db.PublishingFeed(r.Context(), p.conn, viewer, page, per, feed, status, cat, mine)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, result.Posts, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}
func (p *PostsHandler) publishingDetail(w http.ResponseWriter, r *http.Request, id int64) {
	if _, _, _, _, _, _, e := publishingQuery(r, ""); e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	post, err := db.GetPost(r.Context(), p.conn, id)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, post, nil)
}
func (p *PostsHandler) publishingWrite(w http.ResponseWriter, r *http.Request, id int64, draft bool) {
	if _, _, _, _, _, _, e := publishingQuery(r, ""); e != nil {
		WriteError(w, r, e)
		return
	}
	in, image, cleanup, e := parsePublishing(w, r, id != 0, draft)
	if cleanup != nil {
		defer cleanup()
	}
	defer image.closeUploadFile()
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if cleanup == nil {
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	// A nonnull submitted URL can only retain this exact resource's URL. Pending
	// uploads cannot be claimed through JSON by guessing their media ID.
	if id != 0 || image.ImageURL != nil {
		if id == 0 {
			WriteError(w, r, NewError("NOT_FOUND", "not found", 404))
			return
		}
		current, err := db.GetPost(r.Context(), p.conn, id)
		if err != nil {
			publishingError(w, r, err)
			return
		}
		if current.AuthorID != viewer || draft && current.Status != "draft" {
			WriteError(w, r, NewError("NOT_FOUND", "not found", 404))
			return
		}

	}
	if image.HasImageUpload {
		url, _, err := saveRequestImage(r, p.conn, image.UploadFile, image.UploadMime)
		if err != nil {
			publishingError(w, r, err)
			return
		}
		image.ImageURL = &url
		image.HasImageUpdate = true
		defer cleanupStagedImage(r, p.conn, &url)
	}
	in.UploadedImage = image.HasImageUpload
	in.HasImage = image.HasImageUpdate
	in.ImageURL = image.ImageURL
	post, err := db.WritePublishingPost(r.Context(), p.conn, viewer, id, in, draft)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	if id == 0 && draft {
		WriteOK(w, map[string]int64{"id": post.ID, "version": post.Version}, nil)
	} else if id == 0 {
		WriteCreated(w, post)
	} else if draft {
		WriteNoContent(w)
	} else {
		WriteOK(w, post, nil)
	}
}
func (p *PostsHandler) publishingDelete(w http.ResponseWriter, r *http.Request, id int64, draft bool) {
	_, _, _, _, _, expected, e := publishingQuery(r, "delete")
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	if err := db.DeletePublishingPost(r.Context(), p.conn, viewer, id, expected, draft); err != nil {
		publishingError(w, r, err)
		return
	}
	WriteNoContent(w)
}
func (p *PostsHandler) publishingDraft(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		p.publishingWrite(w, r, 0, true)
		return
	}
	if _, _, _, _, _, _, e := publishingQuery(r, ""); e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	draft, err := db.LatestPublishingDraft(r.Context(), p.conn, viewer)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, draft, nil)
}
func (p *PostsHandler) publishingDraftByID(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/v1/posts/draft/")
	id, e := socialID(raw)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if r.Method == http.MethodPut {
		p.publishingWrite(w, r, id, true)
	} else {
		p.publishingDelete(w, r, id, true)
	}
}

// Kept local to content routing, so inherited discussion adapters stay with B16.
func PublishingMethods(path string) string {
	switch path {
	case "/api/v1/posts":
		return "GET, POST"
	case "/api/v1/posts/mine":
		return "GET"
	case "/api/v1/posts/draft":
		return "GET, POST"
	}
	if strings.HasPrefix(path, "/api/v1/posts/draft/") {
		return "PUT, DELETE"
	}
	if strings.HasPrefix(path, "/api/v1/posts/") {
		raw := strings.TrimPrefix(path, "/api/v1/posts/")
		if !strings.Contains(raw, "/") {
			return "GET, PATCH, DELETE"
		}
	}
	return ""
}
