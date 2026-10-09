package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"forum/internal/db"
)

func socialFieldError(field, code string) *APIError {
	e := NewError("VALIDATION_ERROR", "Check the highlighted fields", http.StatusBadRequest)
	e.Fields = map[string]string{field: code}
	return e
}
func socialID(raw string) (int64, *APIError) {
	if raw == "" {
		return 0, NewError("BAD_REQUEST", "invalid ID", 400)
	}
	for _, r := range raw {
		if r < '0' || r > '9' {
			return 0, NewError("BAD_REQUEST", "invalid ID", 400)
		}
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 || n > db.MaxSocialID {
		return 0, NewError("BAD_REQUEST", "invalid ID", 400)
	}
	return n, nil
}
func socialJSONInteger(raw json.RawMessage, field, invalid string) (int64, *APIError) {
	if len(raw) == 0 {
		return 0, socialFieldError(field, "REQUIRED")
	}
	value := string(raw)
	if value == "0" {
		return 0, socialFieldError(field, invalid)
	}
	return socialID(value)
}
func socialEmptyBody(r *http.Request) *APIError {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(b) > 0 {
		return NewError("BAD_REQUEST", "body must be empty", 400)
	}
	return nil
}
func socialQuery(r *http.Request, pagination, search bool) (int, int, string, *APIError) {
	values, err := urlQuery(r)
	if err != nil {
		return 0, 0, "", err
	}
	return socialQueryValues(values, pagination, search)
}

// socialQueryValues validates an already parsed query: every key appears once
// and only allowed keys are accepted. Routes with extra keys remove them first.
func socialQueryValues(values url.Values, pagination, search bool) (int, int, string, *APIError) {
	for k, v := range values {
		if len(v) != 1 || !(pagination && (k == "page" || k == "per_page") || search && k == "q") {
			return 0, 0, "", NewError("BAD_REQUEST", "invalid query", 400)
		}
	}
	page, per, e := socialPaging(values)
	if e != nil {
		return 0, 0, "", e
	}
	q := strings.TrimSpace(values.Get("q"))
	if !utf8.ValidString(q) {
		return 0, 0, "", NewError("BAD_REQUEST", "invalid UTF-8", 400)
	}
	if utf8.RuneCountInString(q) > 100 {
		return 0, 0, "", socialFieldError("q", "TOO_LONG")
	}
	for _, r := range q {
		if unicode.IsControl(r) {
			return 0, 0, "", socialFieldError("q", "INVALID_TEXT")
		}
	}
	return page, per, q, nil
}

// socialPaging reads page (1–1,000,000, default 1) and per_page (1–50, default 20)
// from an already validated query; invalid values are rejected, never clamped.
func socialPaging(values url.Values) (int, int, *APIError) {
	page, per := 1, 20
	for _, v := range []struct {
		key    string
		target *int
		max    int
	}{{"page", &page, 1000000}, {"per_page", &per, 50}} {
		if raw, ok := values[v.key]; ok {
			n, e := socialID(raw[0])
			if e != nil || n > int64(v.max) {
				return 0, 0, NewError("BAD_REQUEST", "invalid pagination", 400)
			}
			*v.target = int(n)
		}
	}
	return page, per, nil
}
func urlQuery(r *http.Request) (url.Values, *APIError) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, NewError("BAD_REQUEST", "invalid query", 400)
	}
	return values, nil
}
func socialJSON(w http.ResponseWriter, r *http.Request, target any, keys ...string) *APIError {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return NewError("UNSUPPORTED_MEDIA_TYPE", "expected JSON", 415)
	}
	return decodeStrictAuthObject(w, r, target, keys...)
}
func socialError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	e := NewError("INTERNAL_SERVER_ERROR", "failed to access profiles", 500)
	switch {
	case errors.Is(err, db.ErrNotFound), errors.Is(err, sql.ErrNoRows):
		e = NewError("NOT_FOUND", "not found", 404)
	case errors.Is(err, db.ErrSelfFollow):
		e = NewError("SELF_FOLLOW", "cannot follow yourself", 400)
		e.Fields = map[string]string{"user_id": "SELF_FOLLOW"}
	case errors.Is(err, db.ErrStaleFollow):
		e = NewError("STALE_FOLLOW", "Relationship changed; refresh before acting", 409)
	case errors.Is(err, db.ErrStaleProfile):
		e = NewError("STALE_PROFILE", "Profile changed; refresh before acting", 409)
	case errors.Is(err, db.ErrStaleInvitation):
		e = NewError("STALE_INVITATION", "Invitation changed; refresh before acting", 409)
	case errors.Is(err, db.ErrStaleJoinRequest):
		e = NewError("STALE_JOIN_REQUEST", "Request changed; refresh before acting", 409)
	case errors.Is(err, db.ErrStaleMembership):
		e = NewError("STALE_MEMBERSHIP", "Membership changed; refresh before acting", 409)
	case errors.Is(err, db.ErrAlreadyMember):
		e = NewError("ALREADY_MEMBER", "Already a member", 409)
	case errors.Is(err, db.ErrCreatorCannotLeave):
		e = NewError("CREATOR_CANNOT_LEAVE", "The creator cannot leave the group", 409)
	case errors.Is(err, db.ErrSelfInvite):
		e = NewError("SELF_INVITE", "Cannot invite yourself", 400)
		e.Fields = map[string]string{"user_id": "SELF_INVITE"}
	case db.IsTemporaryDatabaseError(err):
		e = NewError("SERVICE_UNAVAILABLE", "database is busy; retry", 503)
	}
	WriteError(w, r, e)
}
func (u *UsersHandler) People(w http.ResponseWriter, r *http.Request) {
	page, per, q, e := socialQuery(r, true, true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	result, err := db.ListPeople(r.Context(), u.conn, viewer, 0, "", q, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}
func (u *UsersHandler) socialProfile(w http.ResponseWriter, r *http.Request, subject int64, kind string) {
	page, per, _, e := socialQuery(r, kind == "followers" || kind == "following", false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if kind == "avatar" {
		u.avatar(w, r, subject)
		return
	}
	if kind == "profile" {
		profile, err := db.GetProfile(r.Context(), u.conn, viewer, subject)
		if err != nil {
			socialError(w, r, err)
			return
		}
		WriteOK(w, profile, nil)
		return
	}
	result, err := db.ListPeople(r.Context(), u.conn, viewer, subject, kind, "", page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}
func (u *UsersHandler) IncomingFollowRequests(w http.ResponseWriter, r *http.Request) {
	page, per, _, e := socialQuery(r, true, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	result, err := db.ListFollowRequests(r.Context(), u.conn, viewer, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}
func (u *UsersHandler) Privacy(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input struct {
		Visibility *string         `json:"visibility"`
		Expected   json.RawMessage `json:"expected_version"`
	}
	if e := socialJSON(w, r, &input, "visibility", "expected_version"); e != nil {
		WriteError(w, r, e)
		return
	}
	if input.Visibility == nil {
		WriteError(w, r, socialFieldError("visibility", "REQUIRED"))
		return
	}
	if *input.Visibility != "public" && *input.Visibility != "private" {
		WriteError(w, r, socialFieldError("visibility", "INVALID_CHOICE"))
		return
	}
	version, e := socialJSONInteger(input.Expected, "expected_version", "INVALID_VERSION")
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	change, err := db.ChangePrivacy(r.Context(), u.conn, viewer, *input.Visibility, version)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, change.Profile, nil)
}
func (u *UsersHandler) Follow(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input struct {
		UserID json.RawMessage `json:"user_id"`
	}
	if e := socialJSON(w, r, &input, "user_id"); e != nil {
		WriteError(w, r, e)
		return
	}
	target, e := socialJSONInteger(input.UserID, "user_id", "INVALID_ID")
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	follow, created, err := db.CreateFollow(r.Context(), u.conn, viewer, target)
	if err != nil {
		socialError(w, r, err)
		return
	}
	if created {
		WriteCreated(w, follow)
	} else {
		WriteOK(w, follow, nil)
	}
}
func (u *UsersHandler) RemoveFollow(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	id, e := socialID(strings.TrimPrefix(r.URL.Path, "/api/v1/follows/"))
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if _, err := db.RemoveFollow(r.Context(), u.conn, viewer, id); err != nil {
		socialError(w, r, err)
		return
	}
	WriteNoContent(w)
}
func (u *UsersHandler) DecideFollow(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	id, e := socialID(strings.TrimPrefix(r.URL.Path, "/api/v1/follow-requests/"))
	if e != nil {
		WriteError(w, r, e)
		return
	}
	var input struct {
		Decision *string `json:"decision"`
	}
	if e := socialJSON(w, r, &input, "decision"); e != nil {
		WriteError(w, r, e)
		return
	}
	if input.Decision == nil {
		WriteError(w, r, socialFieldError("decision", "REQUIRED"))
		return
	}
	if *input.Decision != "accept" && *input.Decision != "decline" {
		WriteError(w, r, socialFieldError("decision", "INVALID_CHOICE"))
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	follow, err := db.DecideFollow(r.Context(), u.conn, viewer, id, *input.Decision)
	if err != nil {
		socialError(w, r, err)
		return
	}
	if *input.Decision == "decline" {
		WriteNoContent(w)
	} else {
		WriteOK(w, follow, nil)
	}
}
