package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"forum/internal/db"
	"forum/internal/ws"
)

// GroupChatMethods owns the exact Allow list of the group chat routes ("" otherwise).
func GroupChatMethods(path string) string {
	switch path {
	case "/api/v1/group-chats", "/api/v1/group-chats/unread":
		return "GET"
	}
	const prefix = "/api/v1/groups/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	switch {
	case len(parts) == 2 && parts[0] != "" && parts[1] == "messages":
		return "GET, POST"
	case len(parts) == 3 && parts[0] != "" && parts[1] == "messages" && parts[2] == "read":
		return "PUT"
	}
	return ""
}

// GroupChatHandler serves the members-only room of each group. Every route and the
// socket command share the same db functions, so the HTTP and socket outcomes match.
type GroupChatHandler struct {
	conn *sql.DB
	hub  *ws.Hub
}

func NewGroupChatHandler(conn *sql.DB, hub *ws.Hub) *GroupChatHandler {
	return &GroupChatHandler{conn: conn, hub: hub}
}

// groupChatInput is a syntactically valid send command, shared by HTTP and socket.
type groupChatInput struct {
	group      int64
	membership int64
	clientID   string
	body       string
}

// parseGroupChatInput returns structural problems as an *APIError and field
// problems as a map. withGroup is set for socket payloads, where the group
// travels in the body instead of the path.
func parseGroupChatInput(input map[string]json.RawMessage, withGroup bool) (groupChatInput, map[string]string, *APIError) {
	var in groupChatInput
	fields := map[string]string{}
	if withGroup {
		group, code, e := eventInteger(input["group_id"], false)
		if e != nil {
			return in, nil, e
		}
		if code != "" {
			fields["group_id"] = code
		}
		in.group = group
	}
	membership, code, e := eventInteger(input["membership_id"], false)
	if e != nil {
		return in, nil, e
	}
	if code != "" {
		fields["membership_id"] = code
	}
	in.membership = membership
	clientID, code, e := chatClientID(input["client_id"])
	if e != nil {
		return in, nil, e
	}
	if code != "" {
		fields["client_id"] = code
	}
	in.clientID = clientID
	body, code, e := chatBody(input["body"])
	if e != nil {
		return in, nil, e
	}
	switch {
	case code != "":
		fields["body"] = code
	case body == "":
		fields["body"] = "CONTENT_REQUIRED"
	}
	in.body = body
	return in, fields, nil
}

// groupFrameEnvelope carries the recipient's membership generation next to a
// room frame. The generation is internal: authorizeFrame checks it when the frame
// is written and removes it, so it never reaches a client.
type groupFrameEnvelope struct {
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	Membership int64           `json:"x_membership_id"`
}

// GroupFrame builds a room frame stamped with the recipient's membership
// generation, for group.message, chat.ack and chat.read.
func GroupFrame(kind string, membership int64, payload any) []byte {
	raw, _ := json.Marshal(payload)
	out, _ := json.Marshal(groupFrameEnvelope{Type: kind, Payload: raw, Membership: membership})
	return out
}

// publishGroupMessage fans a committed message out to every session of each
// member in the commit-time snapshot, the sender included. Whether each session's
// generation is still current is decided again at the socket write.
func publishGroupMessage(hub *ws.Hub, result db.GroupSendResult) {
	if hub == nil || result.Duplicate {
		return
	}
	for _, r := range result.Recipients {
		_ = hub.SendToUser(r.UserID, GroupFrame("group.message", r.MembershipID, result.Message))
	}
}

func publishGroupRead(hub *ws.Hub, viewer, group int64, result db.GroupReadResult) {
	if hub == nil || !result.Changed {
		return
	}
	_ = hub.SendToUser(viewer, GroupFrame("chat.read", result.MembershipID, chatReadPayload{"group", group, result.ThroughID, result.UnreadCount}))
}

// Rooms lists the viewer's current rooms.
func (h *GroupChatHandler) Rooms(w http.ResponseWriter, r *http.Request) {
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
	result, err := db.GroupRooms(r.Context(), h.conn, viewer, page, per)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

// Unread counts unread messages across the viewer's current rooms.
func (h *GroupChatHandler) Unread(w http.ResponseWriter, r *http.Request) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
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
	total, err := db.GroupUnreadTotal(r.Context(), h.conn, viewer)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, map[string]int{"unread_count": total}, nil)
}

// Room serves /groups/{id}/messages and /groups/{id}/messages/read.
func (h *GroupChatHandler) Room(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/groups/"), "/")
	group, e := socialID(parts[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	switch {
	case len(parts) == 3:
		h.read(w, r, viewer, group)
	case r.Method == http.MethodPost:
		h.send(w, r, viewer, group)
	default:
		h.history(w, r, viewer, group)
	}
}

func (h *GroupChatHandler) history(w http.ResponseWriter, r *http.Request, viewer, group int64) {
	before, limit, e := chatHistoryQuery(r)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	page, err := db.GroupHistory(r.Context(), h.conn, viewer, group, before, limit)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, map[string]any{"messages": page.Messages, "has_more": page.HasMore, "next_before_id": page.NextBeforeID}, nil)
}

func (h *GroupChatHandler) send(w http.ResponseWriter, r *http.Request, viewer, group int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input map[string]json.RawMessage
	if e := socialJSON(w, r, &input, "membership_id", "client_id", "body"); e != nil {
		WriteError(w, r, e)
		return
	}
	in, fields, e := parseGroupChatInput(input, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if len(fields) > 0 {
		WriteError(w, r, eventValidation(fields))
		return
	}
	result, err := db.SendGroupMessage(r.Context(), h.conn, db.GroupSendRequest{
		SenderID: viewer, GroupID: group, MembershipID: in.membership, ClientID: in.clientID, Body: in.body,
	})
	if err != nil {
		chatError(w, r, err)
		return
	}
	publishGroupMessage(h.hub, result)
	if result.Duplicate {
		WriteOK(w, result.Message, nil)
		return
	}
	WriteCreated(w, result.Message)
}

func (h *GroupChatHandler) read(w http.ResponseWriter, r *http.Request, viewer, group int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input map[string]json.RawMessage
	if e := socialJSON(w, r, &input, "membership_id", "through_id"); e != nil {
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
	through, code, e := eventInteger(input["through_id"], true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		fields["through_id"] = code
	}
	if len(fields) > 0 {
		WriteError(w, r, eventValidation(fields))
		return
	}
	result, err := db.MarkGroupRead(r.Context(), h.conn, viewer, group, membership, through)
	if err != nil {
		chatError(w, r, err)
		return
	}
	publishGroupRead(h.hub, viewer, group, result)
	WriteOK(w, map[string]any{"through_id": result.ThroughID, "unread_count": result.UnreadCount}, nil)
}
