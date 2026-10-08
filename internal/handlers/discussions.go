package handlers

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"forum/internal/db"
)

// DiscussionMethods lists the exact methods of the SN-B16 social routes (comments,
// reactions, activity, navigation and categories); "" means another owner's route.
func DiscussionMethods(path string) string {
	const prefix = "/api/v1/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	switch parts[0] {
	case "posts":
		if len(parts) == 2 && (parts[1] == "liked" || parts[1] == "disliked") {
			return "GET"
		}
		if len(parts) == 3 {
			switch parts[2] {
			case "comments":
				return "GET, POST"
			case "like", "dislike":
				return "POST"
			case "nav":
				return "GET"
			}
		}
	case "comments":
		if len(parts) == 2 && parts[1] != "" {
			return "GET, PATCH, DELETE"
		}
		if len(parts) == 3 && (parts[2] == "like" || parts[2] == "dislike") {
			return "POST"
		}
	case "users":
		if len(parts) == 2 && parts[1] == "activity" || len(parts) == 3 && (parts[2] == "posts" || parts[2] == "comments") {
			return "GET"
		}
	case "categories":
		if len(parts) == 1 || len(parts) == 2 && parts[1] != "" {
			return "GET"
		}
	}
	return ""
}

// discussionQuery strictly parses a query: only the listed keys (plus page and
// per_page when paging), each exactly once. Invalid pagination is rejected.
func discussionQuery(r *http.Request, paging bool, extra ...string) (page, per int, values url.Values, e *APIError) {
	values, e = urlQuery(r)
	if e != nil {
		return
	}
	allowed := map[string]bool{}
	for _, k := range extra {
		allowed[k] = true
	}
	if paging {
		allowed["page"], allowed["per_page"] = true, true
	}
	for k, v := range values {
		if !allowed[k] || len(v) != 1 {
			e = NewError("BAD_REQUEST", "invalid query", 400)
			return
		}
	}
	page, per, e = socialPaging(values)
	return
}

// discussionRequest rejects any query and request body on routes that take none.
func discussionRequest(w http.ResponseWriter, r *http.Request) bool {
	if _, _, _, e := discussionQuery(r, false); e != nil {
		WriteError(w, r, e)
		return false
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return false
	}
	return true
}

func (p *PostsHandler) socialPostRoute(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/posts/"), "/")
	if len(parts) > 2 || parts[0] == "" || len(parts) == 2 && parts[1] == "" {
		notFound(w, r)
		return
	}
	id, e := socialID(parts[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	switch {
	case action == "" && r.Method == http.MethodGet:
		p.publishingDetail(w, r, id)
	case action == "" && r.Method == http.MethodPatch:
		p.publishingWrite(w, r, id, false)
	case action == "" && r.Method == http.MethodDelete:
		p.publishingDelete(w, r, id, false)
	case action == "comments" && r.Method == http.MethodGet:
		p.socialThread(w, r, id)
	case action == "comments" && r.Method == http.MethodPost:
		p.socialWriteComment(w, r, id, 0)
	case action == "like" && r.Method == http.MethodPost:
		p.socialReaction(w, r, id, 1, "post")
	case action == "dislike" && r.Method == http.MethodPost:
		p.socialReaction(w, r, id, -1, "post")
	case action == "nav" && r.Method == http.MethodGet:
		p.socialNavigation(w, r, id)
	case action == "" || action == "comments" || action == "like" || action == "dislike" || action == "nav":
		MethodNotAllowed(w, r)
	default:
		notFound(w, r)
	}
}

func (p *PostsHandler) socialCommentRoute(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/comments/"), "/")
	if len(parts) > 2 || parts[0] == "" || len(parts) == 2 && parts[1] == "" {
		notFound(w, r)
		return
	}
	id, e := socialID(parts[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	switch {
	case action == "" && r.Method == http.MethodGet:
		p.socialCommentDetail(w, r, id)
	case action == "" && r.Method == http.MethodPatch:
		p.socialWriteComment(w, r, 0, id)
	case action == "" && r.Method == http.MethodDelete:
		p.socialDeleteComment(w, r, id)
	case action == "like" && r.Method == http.MethodPost:
		p.socialReaction(w, r, id, 1, "comment")
	case action == "dislike" && r.Method == http.MethodPost:
		p.socialReaction(w, r, id, -1, "comment")
	case action == "" || action == "like" || action == "dislike":
		MethodNotAllowed(w, r)
	default:
		notFound(w, r)
	}
}

func (p *PostsHandler) socialThread(w http.ResponseWriter, r *http.Request, post int64) {
	page, per, _, e := discussionQuery(r, true)
	if e == nil {
		e = socialEmptyBody(r)
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	result, err := db.ListCommentsByPost(r.Context(), p.conn, db.ListCommentsParams{PostID: post, Page: page, PerPage: per}, viewer)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, result.Comments, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func (p *PostsHandler) socialCommentDetail(w http.ResponseWriter, r *http.Request, id int64) {
	if !discussionRequest(w, r) {
		return
	}
	comment, err := db.GetCommentWithAuthor(r.Context(), p.conn, id)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, comment, nil)
}

// parseComment reads a create (post-scoped) or edit (expected_version) request in
// JSON or multipart. Fresh files are validated here and staged only after access.
func parseComment(w http.ResponseWriter, r *http.Request, edit bool) (in db.CommentInput, image imageUpdateRequest, cleanup func(), e *APIError) {
	keys := []string{"body", "image_url", "parent_comment_id"}
	if edit {
		keys = []string{"expected_version", "body", "image_url", "remove_image"}
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
		if in.ExpectedVersion, e = socialID(string(raw)); e != nil {
			return
		}
	}
	for k, raw := range fields {
		switch k {
		case "body":
			in.Body, e = publishingText(raw, k, 10000, false)
		case "parent_comment_id":
			if string(raw) != "null" {
				var id int64
				if id, e = socialID(string(raw)); e == nil {
					in.ParentCommentID = &id
				}
			}
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
		case "remove_image":
			if json.Unmarshal(raw, &image.RemoveImage) != nil {
				e = NewError("BAD_REQUEST", "invalid boolean", 400)
			}
		}
		if e != nil {
			return
		}
	}
	if edit && len(fields) == 1 && !image.HasImageUpload {
		e = NewError("BAD_REQUEST", "a change field is required", 400)
		return
	}
	retained := image.ImageURL != nil && *image.ImageURL != ""
	if image.HasImageUpload && (image.RemoveImage || retained) || image.RemoveImage && retained {
		e = NewError("BAD_REQUEST", "conflicting image fields", 400)
		return
	}
	if image.HasImageUpload {
		file, kind, _, ok := parseImageUpload(w, r)
		if !ok {
			cleanup()
			return in, image, nil, nil
		}
		image.UploadFile, image.UploadMime = file, kind
	}
	if image.ImageURL != nil && *image.ImageURL == "" {
		image.ImageURL = nil
	}
	if image.RemoveImage {
		image.HasImageUpdate, image.ImageURL = true, nil
	}
	return
}

// socialWriteComment creates a comment on post (comment 0) or edits comment.
func (p *PostsHandler) socialWriteComment(w http.ResponseWriter, r *http.Request, post, comment int64) {
	edit := comment != 0
	if _, _, _, e := discussionQuery(r, false); e != nil {
		WriteError(w, r, e)
		return
	}
	in, image, cleanup, e := parseComment(w, r, edit)
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
	if !edit && image.ImageURL != nil && !image.HasImageUpload {
		// A new comment has no current attachment to retain.
		WriteError(w, r, NewError("NOT_FOUND", "not found", 404))
		return
	}
	if !edit && (in.Body == nil || *in.Body == "") && !image.HasImageUpload {
		WriteError(w, r, socialFieldError("body", "CONTENT_REQUIRED"))
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	// Authorization precedes staging bytes; the write transaction repeats it.
	var err error
	if edit {
		err = db.ContentRequestAccess(r.Context(), p.conn, viewer, comment, "comment", true)
	} else {
		err = db.ContentRequestAccess(r.Context(), p.conn, viewer, post, "post", false)
	}
	if err != nil {
		publishingError(w, r, err)
		return
	}
	if image.HasImageUpload {
		url, _, err := saveRequestImage(r, p.conn, image.UploadFile, image.UploadMime)
		if err != nil {
			publishingError(w, r, err)
			return
		}
		image.ImageURL, image.HasImageUpdate = &url, true
		defer cleanupStagedImage(r, p.conn, &url)
	}
	in.UploadedImage, in.HasImage, in.ImageURL = image.HasImageUpload, image.HasImageUpdate, image.ImageURL
	result, err := db.WriteDiscussionComment(r.Context(), p.conn, viewer, post, comment, in)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	if edit {
		WriteOK(w, result, nil)
	} else {
		WriteCreated(w, result)
	}
}

func (p *PostsHandler) socialDeleteComment(w http.ResponseWriter, r *http.Request, id int64) {
	_, _, _, _, _, expected, e := publishingQuery(r, "delete")
	if e == nil {
		e = socialEmptyBody(r)
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	if err := db.DeleteDiscussionComment(r.Context(), p.conn, viewer, id, expected); err != nil {
		publishingError(w, r, err)
		return
	}
	WriteNoContent(w)
}

func (p *PostsHandler) socialReaction(w http.ResponseWriter, r *http.Request, id int64, value int, kind string) {
	if !discussionRequest(w, r) {
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	result, err := db.ToggleDiscussionReaction(r.Context(), p.conn, viewer, id, value, kind)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, map[string]any{kind + "_id": id, "reaction": result.Reaction, "likes_count": result.Likes, "dislikes_count": result.Dislikes}, nil)
}

func (p *PostsHandler) socialNavigation(w http.ResponseWriter, r *http.Request, post int64) {
	_, _, values, e := discussionQuery(r, false, "category_id", "feed")
	if e == nil {
		e = socialEmptyBody(r)
	}
	var category int64
	var categoryID *int64
	if e == nil {
		if raw, ok := values["category_id"]; ok {
			if category, e = socialID(raw[0]); e == nil {
				categoryID = &category
			}
		}
	}
	following := false
	if e == nil {
		if raw, ok := values["feed"]; ok {
			if raw[0] != "all" && raw[0] != "following" {
				e = NewError("BAD_REQUEST", "invalid feed", 400)
			}
			following = raw[0] == "following"
		}
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	nav, err := db.SocialPostNavigation(r.Context(), p.conn, viewer, post, category, following)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, map[string]any{"category_id": categoryID, "prev_id": nav.PrevID, "next_id": nav.NextID}, nil)
}

// socialHistory serves the caller's own liked or disliked posts. A forged owner
// parameter is an unknown query key and fails validation.
func (p *PostsHandler) socialHistory(w http.ResponseWriter, r *http.Request, reaction int) {
	page, per, _, e := discussionQuery(r, true)
	if e == nil {
		e = socialEmptyBody(r)
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, _ := db.SocialViewer(r.Context())
	result, err := db.ListPostsByUserReaction(r.Context(), p.conn, db.ListPostsByUserReactionParams{UserID: viewer, Page: page, PerPage: per, Reaction: reaction}, viewer)
	if err != nil {
		publishingError(w, r, err)
		return
	}
	WriteOK(w, result.Posts, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func (u *UsersHandler) socialProfileContent(w http.ResponseWriter, r *http.Request, subject int64, comments bool) {
	page, per, _, e := discussionQuery(r, true)
	if e == nil {
		e = socialEmptyBody(r)
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if comments {
		thread, err := db.SocialProfileComments(r.Context(), u.conn, viewer, subject, page, per)
		if err != nil {
			socialError(w, r, err)
			return
		}
		WriteOK(w, thread.Comments, &Meta{Pagination: makePaginationMeta(page, per, thread.Total)})
		return
	}
	posts, err := db.SocialProfilePosts(r.Context(), u.conn, viewer, subject, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, posts.Posts, &Meta{Pagination: makePaginationMeta(page, per, posts.Total)})
}

func (u *UsersHandler) socialActivity(w http.ResponseWriter, r *http.Request, viewer int64) {
	page, per, values, e := discussionQuery(r, true, "status")
	var status *string
	if e == nil {
		if raw, ok := values["status"]; ok && raw[0] != "all" {
			if raw[0] != "published" && raw[0] != "draft" {
				e = NewError("BAD_REQUEST", "invalid status", 400)
			}
			status = &raw[0]
		}
	}
	if e == nil {
		e = socialEmptyBody(r)
	}
	if e != nil {
		WriteError(w, r, e)
		return
	}
	result, err := db.SocialActivity(r.Context(), u.conn, viewer, page, per, status)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, userActivityResponse{
		CreatedPosts:  postsActivitySection{Items: result.Created.Posts, Pagination: makePaginationMeta(page, per, result.Created.Total)},
		LikedPosts:    postsActivitySection{Items: result.Liked.Posts, Pagination: makePaginationMeta(page, per, result.Liked.Total)},
		DislikedPosts: postsActivitySection{Items: result.Disliked.Posts, Pagination: makePaginationMeta(page, per, result.Disliked.Total)},
		Comments:      commentsActivitySection{Items: result.Comments.Comments, Pagination: makePaginationMeta(page, per, result.Comments.Total)},
	}, nil)
}
