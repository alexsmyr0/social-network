// internal/handlers/ws.go
package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"forum/internal/db"
	"forum/internal/ws"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     checkWSOrigin,
}

// checkWSOrigin is the Upgrader's Origin gate. CSWSH is already mitigated by
// SameSite=Lax on the session cookie plus the in-handler GetSessionByToken
// check; this is defense-in-depth so a cross-site page cannot even complete the
// handshake. An absent Origin (native/non-browser clients) is allowed, since
// there is no browser to forge it. A same-origin request (SPA served from the
// API host) is allowed. Otherwise the Origin must match FRONTEND_URL.
func checkWSOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	return strings.EqualFold(origin, allowedWSOrigin())
}

// allowedWSOrigin mirrors the router's frontendOrigin resolution so the WS
// allowlist and the CORS allowlist share one source of truth.
func allowedWSOrigin() string {
	if o := os.Getenv("FRONTEND_URL"); o != "" {
		return o
	}
	return "http://localhost:3000"
}

// dmDBTimeout caps every DB call made on behalf of an inbound dm.send so a
// slow query cannot pin a goroutine indefinitely. The number is generous
// relative to a healthy local SQLite roundtrip; tune if real workloads need it.
const dmDBTimeout = 5 * time.Second

type WsHandler struct {
	db  *sql.DB
	hub *ws.Hub
}

func NewWsHandler(database *sql.DB, hub *ws.Hub) *WsHandler {
	return &WsHandler{
		db:  database,
		hub: hub,
	}
}

func (h *WsHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	token := ""
	if cookie, err := r.Cookie("session_token"); err == nil {
		token = cookie.Value
	}
	if token == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	session, err := db.GetSessionByToken(r.Context(), h.db, token)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	client, firstConnection := h.hub.Add(session.UserID, conn)

	// Cache the sender's username on the client so dm.send does not need to
	// query the users table per outbound message. Best-effort: on lookup
	// failure the field stays "" and handleDMSend falls back to "unknown".
	if users, err := db.GetUsersByIDs(r.Context(), h.db, []int64{session.UserID}); err == nil && len(users) > 0 {
		client.Username = users[0].Username
	}

	// Enqueue presence messages before starting goroutines. The Send channel is
	// buffered so this is safe. Doing it here — rather than after launching
	// readPump — eliminates a race where readPump's defer (Remove + offline
	// broadcast) could fire before the online broadcast is enqueued, leaving
	// other clients with a stale "online" event for a user who has already gone.
	//
	// Every new connection receives a snapshot so it knows who is online, even
	// when the same user opens a second tab. The presence.update broadcast only
	// fires on an offline→online state transition (first connection).
	h.hub.SendSnapshotToClient(client)
	if firstConnection {
		h.hub.BroadcastPresenceUpdate(session.UserID, true)
	}

	go h.readPump(session.UserID, client)
	go h.writePump(client)
}

func (h *WsHandler) readPump(userID int64, c *ws.Client) {
	// Each pump runs in its own goroutine, so the HTTP Recoverer middleware
	// cannot catch a panic here — an unrecovered panic would crash the whole
	// process. Recover per pump so a panic drops only this one connection.
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("ws readPump: recovered panic for user %d: %v\n%s", userID, rec, debug.Stack())
		}
		remaining := h.hub.Remove(userID, c)
		if remaining == 0 {
			h.hub.BroadcastPresenceUpdate(userID, false)
		}
		close(c.Send)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(4096)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Frame dispatch is intentionally synchronous: one goroutine per connection
	// reads, validates, persists, and emits in order. This gives us
	// per-connection ordering for free and keeps the DB write path off the
	// hot read loop's critical section. Do NOT change this to `go h.handle…`
	// without also adding ordering and rate-limiting guards.
	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			break
		}
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var msg ws.WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			// Malformed frame: drop silently. We have no `type` to attribute
			// the error to and no contract for a generic protocol error. The
			// connection stays open — a buggy client can recover on its own.
			continue
		}

		switch msg.Type {
		case "dm.send":
			h.handleDMSend(userID, c, msg.Payload)
		}
	}
}

// writePump is the sole goroutine writing to the connection, preventing
// concurrent-write data races. It delivers messages from the client's send
// channel and sends periodic pings to keep the connection alive.
func (h *WsHandler) writePump(c *ws.Client) {
	ticker := time.NewTicker(30 * time.Second)
	// See readPump: recover per pump so a panic in this goroutine drops only
	// this connection instead of crashing the process.
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("ws writePump: recovered panic: %v\n%s", rec, debug.Stack())
		}
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

/*--------------------------
  dm.send wire types
--------------------------*/

type dmSendPayload struct {
	RecipientID int64  `json:"recipient_id"`
	Body        string `json:"body"`
	// ImageURL is optional (C09). When set it must be a URL produced by the DM
	// image upload endpoint: /static/uploads/dm/<file>.<jpg|png|gif>.
	ImageURL string `json:"image_url"`
}

// dmMessagePayload is the typed wire shape for the `dm.message` server event.
// Tagged so marshalling is guaranteed-correct against SDS § 5.5 without
// relying on map ordering or untyped any-values. ImageURL is omitted when the
// message has no attachment.
type dmMessagePayload struct {
	ID             int64  `json:"id"`
	SenderID       int64  `json:"sender_id"`
	RecipientID    int64  `json:"recipient_id"`
	SenderUsername string `json:"sender_username"`
	Body           string `json:"body"`
	ImageURL       string `json:"image_url,omitempty"`
	CreatedAt      string `json:"created_at"`
}

// chatErrorPayload is the typed wire shape for the `chat.error` server event.
type chatErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Canonical chat.error codes. The SDS shows `RECIPIENT_OFFLINE` as the
// example; the rest are project conventions documented here as the single
// source of truth for the dm.send rejection contract.
const (
	codeInvalidPayload   = "INVALID_PAYLOAD"
	codeInvalidRecipient = "INVALID_RECIPIENT"
	codeSelfSend         = "SELF_SEND"
	codeEmptyBody        = "EMPTY_BODY"
	codeRecipientOffline = "RECIPIENT_OFFLINE"
	codeInvalidImage     = "INVALID_IMAGE"
	codeInternalError    = "INTERNAL_ERROR"
)

// dmImageURLPattern matches exactly the URLs the DM image upload endpoint
// produces: /static/uploads/dm/<uuid-ish>.<ext>. The image_url on dm.send is
// later rendered as an <img src> by the frontend (D08), so it is validated
// rather than trusted — this rejects arbitrary paths, traversal (".."), and
// external URLs, binding the field to files our own endpoint created.
var dmImageURLPattern = regexp.MustCompile(`^/static/uploads/dm/[A-Za-z0-9._-]+\.(jpg|png|gif)$`)

// isValidDMImageURL reports whether url is a well-formed DM upload URL. An
// embedded ".." segment is rejected even though the character class forbids
// "/", as defence-in-depth against path traversal.
func isValidDMImageURL(url string) bool {
	return dmImageURLPattern.MatchString(url) && !strings.Contains(url, "..")
}

// handleDMSend processes a client dm.send event:
//  1. Validate payload (parseable, recipient present, non-self, and carrying
//     a non-empty body or an image attachment).
//  2. Reject if recipient is offline → chat.error RECIPIENT_OFFLINE.
//     NOTE: there is an unavoidable TOCTOU window between IsUserOnline and
//     SendToUser — the recipient may disconnect after the check. The message
//     is still persisted; the recipient picks it up via the REST history API
//     on reconnect. This matches SDS § 6.1 ("reject recipient if offline" is
//     a check, not a transactional guarantee).
//  3. Persist via db.CreateMessage.
//  4. Emit dm.message to sender and recipient.
//
// Self-send is also rejected at the db layer via db.CreateMessage; the
// handler-layer check exists so the wire error has a precise code instead
// of leaking the repository's free-form error string.
func (h *WsHandler) handleDMSend(senderID int64, senderClient *ws.Client, payload json.RawMessage) {
	var p dmSendPayload
	if err := json.Unmarshal(payload, &p); err != nil {
		h.sendChatError(senderClient, codeInvalidPayload, "invalid dm.send payload")
		return
	}
	if p.RecipientID == 0 {
		h.sendChatError(senderClient, codeInvalidRecipient, "recipient_id is required")
		return
	}
	if p.RecipientID == senderID {
		h.sendChatError(senderClient, codeSelfSend, "cannot send a message to yourself")
		return
	}
	if strings.TrimSpace(p.Body) == "" && strings.TrimSpace(p.ImageURL) == "" {
		// A message must carry text or an image. An image-only message (empty
		// body + valid image_url) is allowed, matching the DB CHECK on
		// private_messages and the posts/comments image-only pattern.
		h.sendChatError(senderClient, codeEmptyBody, "message must have a body or an image")
		return
	}
	if p.ImageURL != "" && !isValidDMImageURL(p.ImageURL) {
		h.sendChatError(senderClient, codeInvalidImage, "invalid image_url")
		return
	}
	if !h.hub.IsUserOnline(p.RecipientID) {
		h.sendChatError(senderClient, codeRecipientOffline, "recipient is offline")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), dmDBTimeout)
	defer cancel()

	msg, err := db.CreateMessage(ctx, h.db, db.CreateMessageRequest{
		SenderID:    senderID,
		RecipientID: p.RecipientID,
		Body:        p.Body,
		ImagePath:   p.ImageURL,
	})
	if err != nil {
		// Surface a generic code; never echo the DB error string to the wire.
		h.sendChatError(senderClient, codeInternalError, "failed to send message")
		return
	}

	senderUsername := senderClient.Username
	if senderUsername == "" {
		senderUsername = "unknown"
	}

	imageURL := ""
	if msg.ImagePath != nil {
		imageURL = *msg.ImagePath
	}

	data := marshalEvent("dm.message", dmMessagePayload{
		ID:             msg.ID,
		SenderID:       msg.SenderID,
		RecipientID:    msg.RecipientID,
		SenderUsername: senderUsername,
		Body:           msg.Body,
		ImageURL:       imageURL,
		CreatedAt:      msg.CreatedAt,
	})

	// Deliver to both parties. SendToUser returns ErrUserOffline if the
	// recipient raced us to disconnect; that is fine — the message is in the
	// DB and they will see it on reconnect via the history API.
	h.hub.SendToUser(senderID, data)
	h.hub.SendToUser(p.RecipientID, data)
}

// sendChatError enqueues a chat.error event on the sender's connection only.
// The send is non-blocking — a saturated client buffer drops the error rather
// than blocking the read pump. Same policy as Hub broadcasts.
func (h *WsHandler) sendChatError(c *ws.Client, code, message string) {
	data := marshalEvent("chat.error", chatErrorPayload{
		Code:    code,
		Message: message,
	})
	select {
	case c.Send <- data:
	default:
	}
}

// marshalEvent serializes a typed payload into a WSMessage envelope.
// json.Marshal of a typed struct with primitive fields cannot fail; the
// returned errors are intentionally discarded.
func marshalEvent(eventType string, payload any) []byte {
	rawPayload, _ := json.Marshal(payload)
	envelope, _ := json.Marshal(ws.WSMessage{
		Type:    eventType,
		Payload: rawPayload,
	})
	return envelope
}
