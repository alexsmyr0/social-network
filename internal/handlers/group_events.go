package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"forum/internal/db"
)

// EventMethods owns exact event paths, including immutable resources' Allow.
func EventMethods(path string) string {
	p := strings.Split(strings.TrimPrefix(path, "/api/v1/groups/"), "/")
	if !strings.HasPrefix(path, "/api/v1/groups/") || len(p) < 2 || p[0] == "" || p[1] != "events" {
		return ""
	}
	if len(p) == 2 {
		return "GET, POST"
	}
	if p[2] == "" {
		return ""
	}
	if len(p) == 3 {
		return "GET"
	}
	if len(p) == 4 {
		switch p[3] {
		case "responses":
			return "GET"
		case "response":
			return "PUT"
		}
	}
	return ""
}

type GroupEventsHandler struct{ conn *sql.DB }

func NewGroupEventsHandler(conn *sql.DB) *GroupEventsHandler { return &GroupEventsHandler{conn: conn} }
func eventValidation(fields map[string]string) *APIError {
	e := NewError("VALIDATION_ERROR", "Validation failed", 400)
	e.Fields = fields
	return e
}
func eventError(w http.ResponseWriter, r *http.Request, err error) {
	var field *db.ContentFieldError
	switch {
	case errors.As(err, &field):
		WriteError(w, r, eventValidation(map[string]string{field.Field: field.Code}))
	case errors.Is(err, db.ErrNotFound):
		WriteError(w, r, NewError("NOT_FOUND", "Not found", 404))
	case errors.Is(err, db.ErrStaleEventResponse):
		WriteError(w, r, NewError("STALE_EVENT_RESPONSE", "Event response changed; refresh and retry", 409))
	default:
		socialError(w, r, err)
	}
}

// JSON permits unpaired UTF-16 escapes, which encoding/json replaces silently.
// Reject them before unmarshalling so invalid Unicode cannot become valid text.
// raw has already passed decodeStrictObject, including JSON escape validation.
func eventString(raw json.RawMessage) (string, *APIError) {
	if len(raw) == 0 {
		return "", nil
	}
	if raw[0] != '"' {
		return "", NewError("BAD_REQUEST", "invalid JSON fields", 400)
	}
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		n, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if n >= 0xD800 && n <= 0xDBFF {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return "", NewError("BAD_REQUEST", "invalid Unicode", 400)
			}
			low, _ := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if low < 0xDC00 || low > 0xDFFF {
				return "", NewError("BAD_REQUEST", "invalid Unicode", 400)
			}
			i += 6
		} else if n >= 0xDC00 && n <= 0xDFFF {
			return "", NewError("BAD_REQUEST", "invalid Unicode", 400)
		}
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return "", NewError("BAD_REQUEST", "invalid JSON fields", 400)
	}
	return s, nil
}
func eventInteger(raw json.RawMessage, zero bool) (int64, string, *APIError) {
	if len(raw) == 0 {
		return 0, "REQUIRED", nil
	}
	// Numeric shape errors are structural; range errors are field validation.
	s := string(raw)
	if s == "null" || strings.ContainsAny(s, ".eE\"[]{}") || s == "true" || s == "false" {
		return 0, "", NewError("BAD_REQUEST", "invalid JSON fields", 400)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 || !zero && n == 0 || n > db.MaxSocialID {
		return 0, "INVALID_ID", nil
	}
	return n, "", nil
}

var eventTimePattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$`)

func eventTime(raw json.RawMessage) (string, string, *APIError) {
	s, e := eventString(raw)
	if e != nil {
		return "", "", e
	}
	if s == "" {
		return "", "REQUIRED", nil
	}
	if !eventTimePattern.MatchString(s) {
		return "", "INVALID_TIME", nil
	}
	if s[len(s)-1] != 'Z' {
		off := s[len(s)-5:]
		h, _ := strconv.Atoi(off[:2])
		m, _ := strconv.Atoi(off[3:])
		if h > 23 || m > 59 {
			return "", "INVALID_TIME", nil
		}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil || t.Year() < 1 || t.Year() > 9999 || t.UTC().Year() < 1 || t.UTC().Year() > 9999 {
		return "", "INVALID_TIME", nil
	}
	return t.UTC().Format("2006-01-02T15:04:05Z"), "", nil
}
func (h *GroupEventsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/groups/"), "/")
	if EventMethods(r.URL.Path) == "" {
		WriteError(w, r, NewError("NOT_FOUND", "Not found", 404))
		return
	}
	gid, e := socialID(p[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	var id int64
	if len(p) > 2 {
		id, e = socialID(p[2])
		if e != nil {
			WriteError(w, r, e)
			return
		}
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		h.write(w, r, viewer, gid, id)
		return
	}
	page, per, _, e := socialQuery(r, len(p) == 2 || len(p) == 4, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	switch {
	case len(p) == 2:
		result, err := db.ListGroupEvents(r.Context(), h.conn, viewer, gid, page, per)
		if err != nil {
			eventError(w, r, err)
			return
		}
		WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
	case len(p) == 3:
		event, err := db.GetGroupEvent(r.Context(), h.conn, viewer, gid, id)
		if err != nil {
			eventError(w, r, err)
			return
		}
		WriteOK(w, event, nil)
	default:
		result, err := db.ListGroupEventResponses(r.Context(), h.conn, viewer, gid, id, page, per)
		if err != nil {
			eventError(w, r, err)
			return
		}
		WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
	}
}
func (h *GroupEventsHandler) write(w http.ResponseWriter, r *http.Request, viewer, gid, id int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input map[string]json.RawMessage
	keys := []string{"membership_id", "title", "description", "starts_at"}
	if r.Method == http.MethodPut {
		keys = []string{"membership_id", "choice", "expected_version"}
	}
	if e := socialJSON(w, r, &input, keys...); e != nil {
		WriteError(w, r, e)
		return
	}
	fields := map[string]string{}
	membership, code, e := eventInteger(input["membership_id"], false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		fields["membership_id"] = code
	}
	if r.Method == http.MethodPost {
		values := map[string]string{}
		for _, v := range []struct {
			key   string
			max   int
			multi bool
		}{{"title", 100, false}, {"description", 1000, true}} {
			if _, e := eventString(input[v.key]); e != nil {
				WriteError(w, r, e)
				return
			}
			value, code, e := groupText(input[v.key], v.max, v.multi)
			if e != nil {
				WriteError(w, r, e)
				return
			}
			values[v.key] = value
			if code != "" {
				fields[v.key] = code
			}
		}
		startsAt, code, e := eventTime(input["starts_at"])
		if e != nil {
			WriteError(w, r, e)
			return
		}
		if code != "" {
			fields["starts_at"] = code
		}
		if len(fields) > 0 {
			WriteError(w, r, eventValidation(fields))
			return
		}
		event, err := db.CreateGroupEvent(r.Context(), h.conn, viewer, gid, membership, values["title"], values["description"], startsAt)
		if err != nil {
			eventError(w, r, err)
			return
		}
		WriteCreated(w, event)
		return
	}
	choice, e := eventString(input["choice"])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if len(input["choice"]) == 0 {
		fields["choice"] = "REQUIRED"
	} else if choice != "going" && choice != "not_going" {
		fields["choice"] = "INVALID_CHOICE"
	}
	version, code, e := eventInteger(input["expected_version"], true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		fields["expected_version"] = code
	}
	if len(fields) > 0 {
		WriteError(w, r, eventValidation(fields))
		return
	}
	event, err := db.RespondGroupEvent(r.Context(), h.conn, viewer, gid, id, membership, version, choice)
	if err != nil {
		eventError(w, r, err)
		return
	}
	WriteOK(w, event, nil)
}
