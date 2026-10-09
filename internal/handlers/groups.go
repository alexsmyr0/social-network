package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"forum/internal/db"
)

const (
	groupTitleMax       = 100
	groupDescriptionMax = 1000
)

// GroupsHandler adapts the group, invitation, join-request and membership
// resources. Request shaping lives here; every authorization and transition
// decision is repeated inside the repository's serialized write transaction.
type GroupsHandler struct{ conn *sql.DB }

func NewGroupsHandler(conn *sql.DB) *GroupsHandler { return &GroupsHandler{conn: conn} }

// GroupMethods returns the exact Allow list for the group routes, or "" when the
// path is not one of them. The router rejects wrong methods with it before the
// Origin/CSRF checks, as the contract requires.
func GroupMethods(path string) string {
	const prefix = "/api/v1/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	switch parts[0] {
	case "groups":
		switch {
		case len(parts) == 1:
			return "GET, POST"
		case len(parts) == 2 && parts[1] != "":
			return "GET"
		case len(parts) == 3 && parts[1] != "":
			switch parts[2] {
			case "members":
				return "GET"
			case "invitations":
				return "POST"
			case "join-requests":
				return "GET, POST"
			}
		}
	case "group-invitations", "group-join-requests":
		if len(parts) == 2 && parts[1] != "" {
			return "PATCH"
		}
	case "group-memberships":
		if len(parts) == 2 && parts[1] != "" {
			return "DELETE"
		}
	case "users":
		if len(parts) == 3 && parts[1] == "me" && parts[2] == "group-invitations" {
			return "GET"
		}
	}
	return ""
}

// groupText validates one required text field. JSON wrong types and null are
// structural errors; blank, long and control-character text are field errors.
func groupText(raw json.RawMessage, max int, multiline bool) (string, string, *APIError) {
	if len(raw) == 0 {
		return "", "REQUIRED", nil
	}
	var value string
	if raw[0] != '"' || json.Unmarshal(raw, &value) != nil {
		return "", "", NewError("BAD_REQUEST", "invalid JSON fields", http.StatusBadRequest)
	}
	value = strings.TrimSpace(strings.ReplaceAll(value, "\r\n", "\n"))
	if value == "" {
		return "", "REQUIRED", nil
	}
	if utf8.RuneCountInString(value) > max {
		return "", "TOO_LONG", nil
	}
	for _, r := range value {
		if unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\t')) {
			return "", "INVALID_TEXT", nil
		}
	}
	return value, "", nil
}

func groupValidation(fields map[string]string) *APIError {
	e := NewError("VALIDATION_ERROR", "Check the highlighted fields", http.StatusBadRequest)
	e.Fields = fields
	return e
}

func groupRoute(w http.ResponseWriter, r *http.Request) (int64, bool) {
	viewer, ok := requireUserID(w, r)
	return viewer, ok
}

// Groups serves the collection: GET discovery and POST creation.
func (h *GroupsHandler) Groups(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		h.create(w, r)
		return
	}
	values, e := urlQuery(r)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	memberOnly := false
	if raw, ok := values["membership"]; ok {
		if len(raw) != 1 || raw[0] != "all" && raw[0] != "member" {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid query", 400))
			return
		}
		memberOnly = raw[0] == "member"
		values.Del("membership")
	}
	page, per, q, e := socialQueryValues(values, true, true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	result, err := db.ListGroups(r.Context(), h.conn, viewer, memberOnly, q, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func (h *GroupsHandler) create(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input struct {
		Title       json.RawMessage `json:"title"`
		Description json.RawMessage `json:"description"`
	}
	if e := socialJSON(w, r, &input, "title", "description"); e != nil {
		WriteError(w, r, e)
		return
	}
	fields := map[string]string{}
	title, code, e := groupText(input.Title, groupTitleMax, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		fields["title"] = code
	}
	description, code, e := groupText(input.Description, groupDescriptionMax, true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		fields["description"] = code
	}
	if len(fields) > 0 {
		WriteError(w, r, groupValidation(fields))
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	group, err := db.CreateGroup(r.Context(), h.conn, viewer, title, description)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteCreated(w, group)
}

// GroupItem serves /groups/{id} and its members, invitations and join-requests children.
func (h *GroupsHandler) GroupItem(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/groups/"), "/")
	if len(parts) > 2 || GroupMethods(r.URL.Path) == "" {
		WriteError(w, r, NewError("NOT_FOUND", "route not found", http.StatusNotFound))
		return
	}
	id, e := socialID(parts[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	child := ""
	if len(parts) == 2 {
		child = parts[1]
	}
	switch {
	case child == "" && r.Method == http.MethodGet:
		h.detail(w, r, id)
	case child == "members" && r.Method == http.MethodGet:
		h.members(w, r, id)
	case child == "join-requests" && r.Method == http.MethodGet:
		h.joinRequests(w, r, id)
	case child == "join-requests" && r.Method == http.MethodPost:
		h.requestJoin(w, r, id)
	case child == "invitations" && r.Method == http.MethodPost:
		h.invite(w, r, id)
	default:
		MethodNotAllowed(w, r)
	}
}

func (h *GroupsHandler) detail(w http.ResponseWriter, r *http.Request, id int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	group, err := db.GetGroup(r.Context(), h.conn, viewer, id)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, group, nil)
}

func (h *GroupsHandler) members(w http.ResponseWriter, r *http.Request, id int64) {
	page, per, _, e := socialQuery(r, true, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	result, err := db.ListGroupMembers(r.Context(), h.conn, viewer, id, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func (h *GroupsHandler) joinRequests(w http.ResponseWriter, r *http.Request, id int64) {
	page, per, _, e := socialQuery(r, true, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	result, err := db.ListGroupJoinRequests(r.Context(), h.conn, viewer, id, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func (h *GroupsHandler) requestJoin(w http.ResponseWriter, r *http.Request, id int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	request, created, err := db.CreateGroupJoinRequest(r.Context(), h.conn, viewer, id)
	if err != nil {
		socialError(w, r, err)
		return
	}
	if created {
		WriteCreated(w, request)
		return
	}
	WriteOK(w, request, nil)
}

func (h *GroupsHandler) invite(w http.ResponseWriter, r *http.Request, id int64) {
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
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	if viewer == target {
		socialError(w, r, db.ErrSelfInvite)
		return
	}
	invitation, created, err := db.CreateGroupInvitation(r.Context(), h.conn, viewer, id, target)
	if err != nil {
		socialError(w, r, err)
		return
	}
	if created {
		WriteCreated(w, invitation)
		return
	}
	WriteOK(w, invitation, nil)
}

// MyInvitations lists the caller's pending group invitations.
func (h *GroupsHandler) MyInvitations(w http.ResponseWriter, r *http.Request) {
	page, per, _, e := socialQuery(r, true, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	result, err := db.ListGroupInvitations(r.Context(), h.conn, viewer, page, per)
	if err != nil {
		socialError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

func groupDecision(w http.ResponseWriter, r *http.Request, prefix string) (int64, string, bool) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return 0, "", false
	}
	id, e := socialID(strings.TrimPrefix(r.URL.Path, prefix))
	if e != nil {
		WriteError(w, r, e)
		return 0, "", false
	}
	var input struct {
		Decision *string `json:"decision"`
	}
	if e := socialJSON(w, r, &input, "decision"); e != nil {
		WriteError(w, r, e)
		return 0, "", false
	}
	if input.Decision == nil {
		WriteError(w, r, socialFieldError("decision", "REQUIRED"))
		return 0, "", false
	}
	if *input.Decision != "accept" && *input.Decision != "refuse" {
		WriteError(w, r, socialFieldError("decision", "INVALID_CHOICE"))
		return 0, "", false
	}
	return id, *input.Decision, true
}

// DecideInvitation accepts or refuses one exact invitation as its invitee.
func (h *GroupsHandler) DecideInvitation(w http.ResponseWriter, r *http.Request) {
	id, decision, ok := groupDecision(w, r, "/api/v1/group-invitations/")
	if !ok {
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	membership, err := db.DecideGroupInvitation(r.Context(), h.conn, viewer, id, decision)
	if err != nil {
		socialError(w, r, err)
		return
	}
	writeGroupDecision(w, decision, membership)
}

// DecideJoinRequest accepts or refuses one exact request as the group's creator.
func (h *GroupsHandler) DecideJoinRequest(w http.ResponseWriter, r *http.Request) {
	id, decision, ok := groupDecision(w, r, "/api/v1/group-join-requests/")
	if !ok {
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	membership, err := db.DecideGroupJoinRequest(r.Context(), h.conn, viewer, id, decision)
	if err != nil {
		socialError(w, r, err)
		return
	}
	writeGroupDecision(w, decision, membership)
}

func writeGroupDecision(w http.ResponseWriter, decision string, membership db.Membership) {
	if decision == "refuse" {
		WriteNoContent(w)
		return
	}
	WriteOK(w, membership, nil)
}

// RemoveMembership is leave (own row) or creator removal, addressed by the
// membership ID that identifies one admission.
func (h *GroupsHandler) RemoveMembership(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	id, e := socialID(strings.TrimPrefix(r.URL.Path, "/api/v1/group-memberships/"))
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := groupRoute(w, r)
	if !ok {
		return
	}
	if err := db.RemoveGroupMembership(r.Context(), h.conn, viewer, id); err != nil {
		socialError(w, r, err)
		return
	}
	WriteNoContent(w)
}
