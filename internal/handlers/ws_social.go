package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"forum/internal/db"
	"forum/internal/ws"
)

// chatAckPayload answers the requesting socket after a commit or exact retry.
type chatAckPayload struct {
	Kind      string `json:"kind"`
	TargetID  int64  `json:"target_id"`
	ClientID  string `json:"client_id"`
	MessageID int64  `json:"message_id"`
	Duplicate bool   `json:"duplicate"`
}

const (
	chatInvalidPayload  = "Invalid payload"
	chatValidationFails = "Validation failed"
)

// handleSocialFrame is the strict social-schema command dispatcher: `dm.send` and
// `group.send` are the only client commands; every other frame is an
// INVALID_PAYLOAD error to the sender only.
func (h *WsHandler) handleSocialFrame(userID int64, c *ws.Client, raw []byte) {
	var frame ws.WSMessage
	if e := strictObject(raw, &frame, "type", "payload"); e != nil {
		h.sendChatError(c, "INVALID_PAYLOAD", chatInvalidPayload)
		return
	}
	switch frame.Type {
	case "dm.send":
		h.socialDMSend(userID, c, frame.Payload)
	case "group.send":
		h.socialGroupSend(userID, c, frame.Payload)
	default:
		h.sendChatError(c, "INVALID_PAYLOAD", chatInvalidPayload)
	}
}

// echoableClientID returns the payload's client_id only when it is a syntactically
// valid nonce; errors never echo arbitrary client text.
func echoableClientID(payload json.RawMessage) string {
	var loose struct {
		ClientID string `json:"client_id"`
	}
	if json.Unmarshal(payload, &loose) == nil && chatUUID.MatchString(loose.ClientID) {
		return loose.ClientID
	}
	return ""
}

func (h *WsHandler) socialDMSend(senderID int64, c *ws.Client, payload json.RawMessage) {
	clientID := echoableClientID(payload)
	fail := func(code, message string, fields map[string]string) {
		h.sendChatErrorPayload(c, chatErrorPayload{Code: code, Message: message, ClientID: clientID, Fields: fields})
	}
	var input map[string]json.RawMessage
	if e := strictObject(payload, &input, "recipient_id", "client_id", "body", "image_url"); e != nil {
		fail("INVALID_PAYLOAD", chatInvalidPayload, nil)
		return
	}
	in, fields, e := parseDirectInput(input, true)
	if e != nil {
		fail("INVALID_PAYLOAD", chatInvalidPayload, nil)
		return
	}
	if len(fields) > 0 {
		fail("VALIDATION_ERROR", chatValidationFails, fields)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dmDBTimeout)
	defer cancel()
	result, err := db.SendDirectMessage(ctx, h.db, db.DirectSendRequest{
		SenderID: senderID, RecipientID: in.recipient, ClientID: in.clientID, Body: in.body, ImageURL: in.image,
	})
	if err != nil {
		chatSendFailure(err, fail)
		return
	}
	// Commit, then ack the requesting socket, then fan out. The ack shares the
	// sender's queue with the echo, so it always precedes it.
	ack := marshalEvent("chat.ack", chatAckPayload{
		Kind: "dm", TargetID: in.recipient, ClientID: in.clientID, MessageID: result.Message.ID, Duplicate: result.Duplicate,
	})
	select {
	case c.Send <- ack:
	default:
	}
	publishDirectMessage(h.hub, result)
}

// chatSendFailure maps a rejected send to the requesting socket's chat.error.
func chatSendFailure(err error, fail func(code, message string, fields map[string]string)) {
	var field *db.ContentFieldError
	switch {
	case errors.As(err, &field):
		fail("VALIDATION_ERROR", chatValidationFails, map[string]string{field.Field: field.Code})
	case errors.Is(err, db.ErrNotFound), errors.Is(err, sql.ErrNoRows):
		fail("NOT_FOUND", "Not found", nil)
	case errors.Is(err, db.ErrMessageConflict):
		fail("MESSAGE_CONFLICT", "Message retry differs from original", nil)
	case errors.Is(err, db.ErrStaleMembership):
		fail("STALE_MEMBERSHIP", "Membership changed; refresh before acting", nil)
	case db.IsTemporaryDatabaseError(err):
		fail("SERVICE_UNAVAILABLE", "Database is busy; retry", nil)
	default:
		fail("INTERNAL_ERROR", "Failed to send message", nil)
	}
}

func (h *WsHandler) socialGroupSend(senderID int64, c *ws.Client, payload json.RawMessage) {
	clientID := echoableClientID(payload)
	fail := func(code, message string, fields map[string]string) {
		h.sendChatErrorPayload(c, chatErrorPayload{Code: code, Message: message, ClientID: clientID, Fields: fields})
	}
	var input map[string]json.RawMessage
	if e := strictObject(payload, &input, "group_id", "membership_id", "client_id", "body"); e != nil {
		fail("INVALID_PAYLOAD", chatInvalidPayload, nil)
		return
	}
	in, fields, e := parseGroupChatInput(input, true)
	if e != nil {
		fail("INVALID_PAYLOAD", chatInvalidPayload, nil)
		return
	}
	if len(fields) > 0 {
		fail("VALIDATION_ERROR", chatValidationFails, fields)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), dmDBTimeout)
	defer cancel()
	result, err := db.SendGroupMessage(ctx, h.db, db.GroupSendRequest{
		SenderID: senderID, GroupID: in.group, MembershipID: in.membership, ClientID: in.clientID, Body: in.body,
	})
	if err != nil {
		chatSendFailure(err, fail)
		return
	}
	// Commit, then ack the requesting socket, then fan out. The ack shares the
	// sender's queue with its own copy of the message, so it always precedes it.
	ack := GroupFrame("chat.ack", in.membership, chatAckPayload{
		Kind: "group", TargetID: in.group, ClientID: in.clientID, MessageID: result.Message.ID, Duplicate: result.Duplicate,
	})
	select {
	case c.Send <- ack:
	default:
	}
	publishGroupMessage(h.hub, result)
}
