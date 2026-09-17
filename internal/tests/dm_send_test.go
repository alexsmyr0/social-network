// internal/tests/dm_send_test.go
package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// sendDMSend writes a dm.send frame to conn.
func sendDMSend(t *testing.T, conn *websocket.Conn, recipientID int64, body string) {
	t.Helper()
	msg := map[string]any{
		"type": "dm.send",
		"payload": map[string]any{
			"recipient_id": recipientID,
			"body":         body,
		},
	}
	if err := conn.WriteJSON(msg); err != nil {
		t.Fatalf("sendDMSend: write: %v", err)
	}
}

// tryReadWSMessage reads the next text message with a short deadline. Returns
// (msg, true) if a message arrives, or (nil, false) if the deadline expires.
func tryReadWSMessage(conn *websocket.Conn, timeout time.Duration) (map[string]json.RawMessage, bool) {
	conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		return nil, false
	}
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, false
	}
	return msg, true
}

// drainUntilType reads messages until one with the matching type is found or
// the deadline expires. Returns the message and true on success.
func drainUntilType(conn *websocket.Conn, msgType string, timeout time.Duration) (map[string]json.RawMessage, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, false
		}
		conn.SetReadDeadline(time.Now().Add(remaining))
		_, data, err := conn.ReadMessage()
		if err != nil {
			return nil, false
		}
		var msg map[string]json.RawMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		var typ string
		if err := json.Unmarshal(msg["type"], &typ); err != nil {
			continue
		}
		if typ == msgType {
			return msg, true
		}
	}
	return nil, false
}

/*-----------------------
  VALID DM DELIVERY
------------------------*/

func TestDMSend_DeliveredToSenderAndRecipient(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "dmalice")
	aliceID := getUserID(t, h, tokenAlice)
	tokenBob := registerAndLoginAs(t, h, "dmbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()

	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	// Drain initial presence frames from both connections.
	// Alice: snapshot + self-update.
	// Bob connects after alice: snapshot + self-update. Alice also gets bob's update.
	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	sendDMSend(t, connAlice, bobID, "hello bob")

	// Alice's connection should receive dm.message.
	aliceMsg, ok := drainUntilType(connAlice, "dm.message", 2*time.Second)
	if !ok {
		t.Fatal("alice did not receive dm.message")
	}
	// Bob's connection should also receive dm.message.
	bobMsg, ok := drainUntilType(connBob, "dm.message", 2*time.Second)
	if !ok {
		t.Fatal("bob did not receive dm.message")
	}

	for _, m := range []map[string]json.RawMessage{aliceMsg, bobMsg} {
		var payload struct {
			ID             int64  `json:"id"`
			SenderID       int64  `json:"sender_id"`
			RecipientID    int64  `json:"recipient_id"`
			SenderUsername string `json:"sender_username"`
			Body           string `json:"body"`
			CreatedAt      string `json:"created_at"`
		}
		if err := json.Unmarshal(m["payload"], &payload); err != nil {
			t.Fatalf("unmarshal dm.message payload: %v", err)
		}
		if payload.ID == 0 {
			t.Error("expected non-zero message id")
		}
		if payload.SenderID != aliceID {
			t.Errorf("sender_id: got %d want %d", payload.SenderID, aliceID)
		}
		if payload.SenderUsername != "dmalice" {
			t.Errorf("sender_username: got %q want %q", payload.SenderUsername, "dmalice")
		}
		if payload.Body != "hello bob" {
			t.Errorf("body: got %q want %q", payload.Body, "hello bob")
		}
		if payload.CreatedAt == "" {
			t.Error("expected non-empty created_at")
		}
	}
}

func TestDMSend_MessageIsPersisted(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "persidalice")
	tokenBob := registerAndLoginAs(t, h, "persidbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	sendDMSend(t, connAlice, bobID, "persisted message")
	_, ok = drainUntilType(connAlice, "dm.message", 2*time.Second)
	if !ok {
		t.Fatal("alice did not receive dm.message confirmation")
	}

	// Verify the message appears in the REST history API.
	aliceID := getUserID(t, h, tokenAlice)
	msgs := getChatMessages(t, h, tokenBob, aliceID, 0)
	if len(msgs) == 0 {
		t.Fatal("expected at least one persisted message")
	}
	found := false
	for _, m := range msgs {
		if m["body"] == "persisted message" {
			found = true
		}
	}
	if !found {
		t.Errorf("persisted message not found in history, got: %v", msgs)
	}
}

/*-----------------------
  REJECTION CASES
------------------------*/

func TestDMSend_SelfSendRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "selfsendalice")
	aliceID := getUserID(t, h, tokenAlice)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()

	drainUntilType(connAlice, "presence.update", time.Second)

	sendDMSend(t, connAlice, aliceID, "to myself")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for self-send")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "SELF_SEND" {
		t.Errorf("expected SELF_SEND, got %q", payload.Code)
	}
}

func TestDMSend_EmptyBodyRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "emptybodyalice")
	tokenBob := registerAndLoginAs(t, h, "emptybobbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	sendDMSend(t, connAlice, bobID, "")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for empty body")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "EMPTY_BODY" {
		t.Errorf("expected EMPTY_BODY, got %q", payload.Code)
	}
}

func TestDMSend_WhitespaceBodyRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "wsalice")
	tokenBob := registerAndLoginAs(t, h, "wsbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	sendDMSend(t, connAlice, bobID, "   ")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for whitespace body")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "EMPTY_BODY" {
		t.Errorf("expected EMPTY_BODY, got %q", payload.Code)
	}
}

func TestDMSend_RecipientOfflineRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "offalice2")
	tokenBob := registerAndLoginAs(t, h, "offbob2")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()

	// Bob is not connected — he is offline.
	_ = bobID

	drainUntilType(connAlice, "presence.update", time.Second)

	sendDMSend(t, connAlice, bobID, "you there?")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for offline recipient")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "RECIPIENT_OFFLINE" {
		t.Errorf("expected RECIPIENT_OFFLINE, got %q", payload.Code)
	}
}

func TestDMSend_MissingRecipientRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "missingrecipalice")

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()

	drainUntilType(connAlice, "presence.update", time.Second)

	// dm.send with no recipient_id field — zero value after decode.
	badMsg := map[string]any{
		"type":    "dm.send",
		"payload": map[string]any{"body": "no recipient"},
	}
	if err := connAlice.WriteJSON(badMsg); err != nil {
		t.Fatalf("write bad dm.send: %v", err)
	}

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for missing recipient_id")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "INVALID_RECIPIENT" {
		t.Errorf("expected INVALID_RECIPIENT, got %q", payload.Code)
	}
}

func TestDMSend_MalformedPayloadRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "malformedpayloadalice")

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()

	drainUntilType(connAlice, "presence.update", time.Second)

	// dm.send with payload that is a JSON string (not an object) — decode fails.
	frame := []byte(`{"type":"dm.send","payload":"not-an-object"}`)
	if err := connAlice.WriteMessage(websocket.TextMessage, frame); err != nil {
		t.Fatalf("write malformed dm.send: %v", err)
	}

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for malformed payload")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "INVALID_PAYLOAD" {
		t.Errorf("expected INVALID_PAYLOAD, got %q", payload.Code)
	}
}

/*-----------------------
  PROTOCOL EDGE CASES
------------------------*/

// assertNextIsDMMessage drives a "send-X-then-send-valid-dm.send" check
// without ever invoking a probe read whose timeout would put the gorilla
// websocket connection in a sticky-error state. The server dispatches frames
// strictly in order, so if X is silently dropped the very next emitted event
// is the dm.message confirming the follow-up. If X had elicited chat.error,
// it would arrive first.
func assertNextIsDMMessage(t *testing.T, conn *websocket.Conn, recipientID int64, body string) {
	t.Helper()
	sendDMSend(t, conn, recipientID, body)
	msg, ok := drainUntilType(conn, "dm.message", 2*time.Second)
	if !ok {
		t.Fatalf("expected dm.message; got nothing within 2s")
	}
	// Sanity: payload body matches what we just sent.
	var p struct {
		Body string `json:"body"`
	}
	if err := json.Unmarshal(msg["payload"], &p); err != nil {
		t.Fatalf("unmarshal dm.message payload: %v", err)
	}
	if p.Body != body {
		t.Errorf("expected body %q, got %q (something else was emitted first)", body, p.Body)
	}
}

// TestDMSend_MalformedJSONIgnored documents that a non-JSON top-level frame
// is silently dropped: the server emits no chat.error and the connection
// stays usable.
func TestDMSend_MalformedJSONIgnored(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "malformjsonalice")
	tokenBob := registerAndLoginAs(t, h, "malformjsonbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	// Send a frame that is not JSON at all.
	if err := connAlice.WriteMessage(websocket.TextMessage, []byte("{not json}")); err != nil {
		t.Fatalf("write malformed frame: %v", err)
	}

	// The very next event must be the dm.message from the follow-up — if the
	// server had emitted chat.error for the malformed frame it would arrive
	// first and assertNextIsDMMessage would catch the body mismatch.
	assertNextIsDMMessage(t, connAlice, bobID, "after garbage")
}

// TestDMSend_UnknownTypeIgnored documents that frames with an unrecognised
// `type` are silently dropped. Validates the `switch msg.Type` fall-through.
func TestDMSend_UnknownTypeIgnored(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "unknowntypealice")
	tokenBob := registerAndLoginAs(t, h, "unknowntypebob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	frame := []byte(`{"type":"typing","payload":{"recipient_id":1}}`)
	if err := connAlice.WriteMessage(websocket.TextMessage, frame); err != nil {
		t.Fatalf("write unknown-type frame: %v", err)
	}

	assertNextIsDMMessage(t, connAlice, bobID, "after unknown type")
}

// TestDMSend_DBErrorReturnsInternalError drops the private_messages table
// after both users authenticate but before the WS dm.send, forcing the
// CreateMessage call to fail. The handler must surface INTERNAL_ERROR with
// a generic message — never echoing the DB error string to the wire.
func TestDMSend_DBErrorReturnsInternalError(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "dberralice")
	tokenBob := registerAndLoginAs(t, h, "dberrbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	// Sabotage the DB: drop the table the handler will try to insert into.
	if _, err := sqlDB.Exec(`DROP TABLE private_messages`); err != nil {
		t.Fatalf("sabotage: drop table: %v", err)
	}

	sendDMSend(t, connAlice, bobID, "should fail")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error after DB sabotage")
	}
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "INTERNAL_ERROR" {
		t.Errorf("expected INTERNAL_ERROR, got %q", payload.Code)
	}
	// The wire message must NOT leak the SQLite error string.
	if strings.Contains(strings.ToLower(payload.Message), "sql") ||
		strings.Contains(strings.ToLower(payload.Message), "table") ||
		strings.Contains(strings.ToLower(payload.Message), "private_messages") {
		t.Errorf("INTERNAL_ERROR message leaks DB detail: %q", payload.Message)
	}
}

/*-----------------------
  HELPERS
------------------------*/

// getChatMessages calls GET /api/v1/chats/{userID}/messages and returns the
// messages slice as []map[string]any. Fails the test on non-200.
func getChatMessages(t *testing.T, h http.Handler, token string, otherUserID int64, beforeID int64) []map[string]any {
	t.Helper()
	path := fmt.Sprintf("/api/v1/chats/%d/messages", otherUserID)
	if beforeID > 0 {
		path += fmt.Sprintf("?before_id=%d", beforeID)
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("getChatMessages: got %d", rec.Code)
	}
	var resp struct {
		Data struct {
			Messages []map[string]any `json:"messages"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("getChatMessages: decode: %v", err)
	}
	return resp.Data.Messages
}
