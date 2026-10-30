package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"forum/internal/db"
	"forum/internal/ws"
)

const (
	chatBodyMax      = 2000
	chatHistoryLimit = 10
	chatHistoryMax   = 50
)

var chatUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// ChatMethods owns the exact Allow list of the social chat routes ("" otherwise).
func ChatMethods(path string) string {
	const prefix = "/api/v1/chats"
	if path == prefix {
		return "GET"
	}
	if !strings.HasPrefix(path, prefix+"/") {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix+"/"), "/")
	switch {
	case len(parts) == 1 && parts[0] == "unread":
		return "GET"
	case len(parts) == 2 && parts[0] != "":
		switch parts[1] {
		case "messages":
			return "GET, POST"
		case "images":
			return "POST"
		case "read":
			return "PUT"
		}
	}
	return ""
}

// directInput is a syntactically valid send command, shared by HTTP and socket.
type directInput struct {
	recipient int64
	clientID  string
	body      string
	image     string
}

// chatBody validates message text: LF-normalized, edge-trimmed, at most 2000 code
// points, no control characters except tab and line feed. Emptiness is judged by
// the caller, since an image can stand in for text.
func chatBody(raw json.RawMessage) (string, string, *APIError) {
	if len(raw) == 0 {
		return "", "REQUIRED", nil
	}
	value, e := eventString(raw)
	if e != nil {
		return "", "", e
	}
	value = strings.TrimSpace(strings.ReplaceAll(value, "\r\n", "\n"))
	if utf8.RuneCountInString(value) > chatBodyMax {
		return "", "TOO_LONG", nil
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return "", "INVALID_TEXT", nil
		}
	}
	return value, "", nil
}

// chatClientID validates a retry nonce: a lowercase canonical UUID v4.
func chatClientID(raw json.RawMessage) (string, string, *APIError) {
	if len(raw) == 0 {
		return "", "REQUIRED", nil
	}
	value, e := eventString(raw)
	if e != nil {
		return "", "", e
	}
	if !chatUUID.MatchString(value) {
		return value, "INVALID_UUID", nil
	}
	return value, "", nil
}

// parseDirectInput returns structural problems as an *APIError and field
// problems as a map. withRecipient is set for socket payloads, where the
// recipient travels in the body instead of the path.
func parseDirectInput(input map[string]json.RawMessage, withRecipient bool) (directInput, map[string]string, *APIError) {
	var in directInput
	fields := map[string]string{}
	if withRecipient {
		recipient, code, e := eventInteger(input["recipient_id"], false)
		if e != nil {
			return in, nil, e
		}
		if code != "" {
			fields["recipient_id"] = code
		}
		in.recipient = recipient
	}
	clientID, code, e := chatClientID(input["client_id"])
	if e != nil {
		return in, nil, e
	}
	if code != "" {
		fields["client_id"] = code
	}
	in.clientID = clientID
	if len(input["image_url"]) > 0 {
		value, e := eventString(input["image_url"])
		if e != nil {
			return in, nil, e
		}
		if value != "" && !db.IsPrivateMediaURL(value) {
			fields["image_url"] = "INVALID_ID"
		}
		in.image = value
	}
	body, code, e := chatBody(input["body"])
	if e != nil {
		return in, nil, e
	}
	switch {
	case code != "":
		fields["body"] = code
	case body == "" && in.image == "":
		fields["body"] = "CONTENT_REQUIRED"
	}
	in.body = body
	return in, fields, nil
}

// publishDirectMessage fans out a committed message to the sender's and the
// recipient's sessions. Whether recipient sessions exist, and whether the pair
// may still message each other, is decided again at each queued write.
func publishDirectMessage(hub *ws.Hub, result db.DirectSendResult) {
	if hub == nil || result.Duplicate {
		return
	}
	data := marshalEvent("dm.message", result.Message)
	_ = hub.SendToUser(result.Message.SenderID, data)
	_ = hub.SendToUser(result.Message.RecipientID, data)
}

type chatReadPayload struct {
	Kind        string `json:"kind"`
	TargetID    int64  `json:"target_id"`
	ThroughID   int64  `json:"through_id"`
	UnreadCount int    `json:"unread_count"`
}

func publishDirectRead(hub *ws.Hub, viewer, other int64, result db.DirectReadResult) {
	if hub == nil || !result.Changed {
		return
	}
	_ = hub.SendToUser(viewer, marshalEvent("chat.read", chatReadPayload{"dm", other, result.ThroughID, result.UnreadCount}))
}

func chatError(w http.ResponseWriter, r *http.Request, err error) {
	var field *db.ContentFieldError
	switch {
	case errors.As(err, &field):
		WriteError(w, r, eventValidation(map[string]string{field.Field: field.Code}))
	case errors.Is(err, db.ErrNotFound), errors.Is(err, sql.ErrNoRows):
		WriteError(w, r, NewError("NOT_FOUND", "Not found", 404))
	case errors.Is(err, db.ErrMessageConflict):
		WriteError(w, r, NewError("MESSAGE_CONFLICT", "Message retry differs from original", 409))
	case errors.Is(err, db.ErrStaleMembership):
		WriteError(w, r, NewError("STALE_MEMBERSHIP", "Membership changed; refresh before acting", 409))
	default:
		socialError(w, r, err)
	}
}

func (h *ChatsHandler) socialRoster(w http.ResponseWriter, r *http.Request) {
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
	result, err := db.DirectRoster(r.Context(), h.conn, viewer, page, per)
	if err != nil {
		chatError(w, r, err)
		return
	}
	// Presence follows profile visibility, decided in the roster snapshot; hidden
	// presence is omitted, never reported as false.
	for i := range result.Items {
		if entry := &result.Items[i]; entry.PresenceVisible {
			online := h.hub.IsUserOnline(entry.UserID)
			entry.IsOnline = &online
		}
	}
	WriteOK(w, result.Items, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
}

// socialChat serves everything under /chats/: unread and the per-user resources.
func (h *ChatsHandler) socialChat(w http.ResponseWriter, r *http.Request) {
	methods := ChatMethods(r.URL.Path)
	if methods == "" {
		WriteError(w, r, NewError("NOT_FOUND", "Not found", 404))
		return
	}
	if !strings.Contains(", "+methods+", ", ", "+r.Method+", ") {
		w.Header().Set("Allow", methods)
		MethodNotAllowed(w, r)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/chats/"), "/")
	if parts[0] == "unread" {
		h.socialUnread(w, r)
		return
	}
	target, e := socialID(parts[0])
	if e != nil {
		WriteError(w, r, e)
		return
	}
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	switch parts[1] {
	case "messages":
		if r.Method == http.MethodPost {
			h.socialSend(w, r, viewer, target)
		} else {
			h.socialHistory(w, r, viewer, target)
		}
	case "images":
		h.socialUpload(w, r, viewer, target)
	default:
		h.socialRead(w, r, viewer, target)
	}
}

func (h *ChatsHandler) socialUnread(w http.ResponseWriter, r *http.Request) {
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
	total, err := db.DirectUnreadTotal(r.Context(), h.conn, viewer)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, map[string]int{"unread_count": total}, nil)
}

// chatHistoryQuery reads the shared history paging keys: optional before_id and
// limit (1–50, default 10). Both are positive safe integers; anything else is rejected.
func chatHistoryQuery(r *http.Request) (int64, int, *APIError) {
	values, e := urlQuery(r)
	if e != nil {
		return 0, 0, e
	}
	var before int64
	limit := chatHistoryLimit
	for key, list := range values {
		if len(list) != 1 || key != "before_id" && key != "limit" {
			return 0, 0, NewError("BAD_REQUEST", "invalid query", 400)
		}
		n, e := socialID(list[0])
		if e != nil || key == "limit" && n > chatHistoryMax {
			return 0, 0, NewError("BAD_REQUEST", "invalid query", 400)
		}
		if key == "before_id" {
			before = n
		} else {
			limit = int(n)
		}
	}
	return before, limit, nil
}

func (h *ChatsHandler) socialHistory(w http.ResponseWriter, r *http.Request, viewer, target int64) {
	before, limit, e := chatHistoryQuery(r)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	page, err := db.DirectHistory(r.Context(), h.conn, viewer, target, before, limit)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, map[string]any{"messages": page.Messages, "has_more": page.HasMore, "next_before_id": page.NextBeforeID}, nil)
}

func (h *ChatsHandler) socialSend(w http.ResponseWriter, r *http.Request, viewer, target int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input map[string]json.RawMessage
	if e := socialJSON(w, r, &input, "client_id", "body", "image_url"); e != nil {
		WriteError(w, r, e)
		return
	}
	in, fields, e := parseDirectInput(input, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if len(fields) > 0 {
		WriteError(w, r, eventValidation(fields))
		return
	}
	result, err := db.SendDirectMessage(r.Context(), h.conn, db.DirectSendRequest{
		SenderID: viewer, RecipientID: target, ClientID: in.clientID, Body: in.body, ImageURL: in.image,
	})
	if err != nil {
		chatError(w, r, err)
		return
	}
	publishDirectMessage(h.hub, result)
	if result.Duplicate {
		WriteOK(w, result.Message, nil)
		return
	}
	WriteCreated(w, result.Message)
}

func (h *ChatsHandler) socialRead(w http.ResponseWriter, r *http.Request, viewer, target int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	var input map[string]json.RawMessage
	if e := socialJSON(w, r, &input, "through_id"); e != nil {
		WriteError(w, r, e)
		return
	}
	through, code, e := eventInteger(input["through_id"], true)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if code != "" {
		WriteError(w, r, eventValidation(map[string]string{"through_id": code}))
		return
	}
	result, err := db.MarkDirectRead(r.Context(), h.conn, viewer, target, through)
	if err != nil {
		chatError(w, r, err)
		return
	}
	publishDirectRead(h.hub, viewer, target, result)
	WriteOK(w, map[string]any{"through_id": result.ThroughID, "unread_count": result.UnreadCount}, nil)
}

// socialUpload stages one image for a conversation the uploader may still write
// to. It creates no message; the later send claims the staged object.
func (h *ChatsHandler) socialUpload(w http.ResponseWriter, r *http.Request, viewer, target int64) {
	if _, _, _, e := socialQuery(r, false, false); e != nil {
		WriteError(w, r, e)
		return
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mediaType != "multipart/form-data" {
		WriteError(w, r, NewError("UNSUPPORTED_MEDIA_TYPE", "expected multipart form", 415))
		return
	}
	cleanup, ok := parseMultipartForm(w, r)
	if !ok {
		return
	}
	defer cleanup()
	form := r.MultipartForm
	if form == nil || len(form.Value) > 0 || len(form.File) != 1 || len(form.File["image"]) != 1 {
		WriteError(w, r, NewError("BAD_REQUEST", "expected a single image part", 400))
		return
	}
	file, kind, _, ok := parseImageUpload(w, r)
	if !ok {
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, imageMaxBytes+1))
	if err != nil {
		chatError(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), dmDBTimeout)
	defer cancel()
	url, _, err := db.StageMedia(ctx, h.conn, viewer, target, "dm", data, kind)
	if err != nil {
		chatError(w, r, err)
		return
	}
	WriteOK(w, map[string]string{"image_url": url}, nil)
}
