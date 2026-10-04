package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"

	"github.com/gorilla/websocket"
)

// client wraps a websocket connection with a dedicated send channel so that
// all writes to the connection are serialized through a single goroutine.
// Username is resolved once at upgrade time and reused for every outbound
// dm.message — avoids a DB round-trip per send on the chat hot path.
type Client struct {
	Conn     *websocket.Conn
	Send     chan []byte
	Username string
	Token    string
	Done     chan struct{}
}

func NewClient(conn *websocket.Conn) *Client {
	return &Client{
		Conn: conn,
		Send: make(chan []byte, 64),
		Done: make(chan struct{}),
	}
}

type Hub struct {
	mu     sync.RWMutex
	gateMu sync.Mutex
	gates  map[string]*sessionGate

	connections map[int64]map[*Client]bool

	onConnect    func(userID int64)
	onDisconnect func(userID int64)
}

type sessionGate struct {
	mu   sync.RWMutex
	refs int
}

func (h *Hub) acquireSessionGate(token string) (*sessionGate, func()) {
	h.gateMu.Lock()
	if h.gates == nil {
		h.gates = make(map[string]*sessionGate)
	}
	gate := h.gates[token]
	if gate == nil {
		gate = &sessionGate{}
		h.gates[token] = gate
	}
	gate.refs++
	h.gateMu.Unlock()
	return gate, func() {
		h.gateMu.Lock()
		gate.refs--
		if gate.refs == 0 {
			delete(h.gates, token)
		}
		h.gateMu.Unlock()
	}
}

// WithSessionAdmission holds a token's gate through validation and privileged
// work. Revocation waits for admitted work before invalidating the token.
func (h *Hub) WithSessionAdmission(token string, admit func()) {
	gate, release := h.acquireSessionGate(token)
	gate.mu.RLock()
	defer release()
	defer gate.mu.RUnlock()
	admit()
}

// RevokeToken waits for admitted work, invalidates the token, then closes its
// retained sockets. The gate is released before waiting for read pumps, which
// may themselves be waiting to revalidate through that gate.
func (h *Hub) RevokeToken(ctx context.Context, token string, revoke func() error) error {
	gate, release := h.acquireSessionGate(token)
	gate.mu.Lock()
	err := revoke()
	gate.mu.Unlock()
	release()
	if err != nil {
		return err
	}
	return h.DisconnectToken(ctx, token)
}

func NewHub() *Hub {
	return &Hub{
		connections: make(map[int64]map[*Client]bool),
		gates:       make(map[string]*sessionGate),
	}
}

// SetCallbacks registers lifecycle hooks that fire on first connect and last
// disconnect. The callbacks are invoked while the Hub's write lock is held, so
// they must not call any Hub method that acquires a read or write lock
// (e.g. BroadcastPresenceUpdate, SendPresenceSnapshot, SendToUser) — doing so
// will deadlock. Use these hooks only for lightweight, non-Hub side-effects.
func (h *Hub) SetCallbacks(onConnect, onDisconnect func(int64)) {
	h.onConnect = onConnect
	h.onDisconnect = onDisconnect
}

// Add registers a new client for the given user. Returns the client and whether
// this is the user's first connection.
func (h *Hub) Add(userID int64, conn *websocket.Conn) (*Client, bool) {
	return h.AddSession(userID, "", conn)
}

func (h *Hub) AddSession(userID int64, token string, conn *websocket.Conn) (*Client, bool) {
	c := NewClient(conn)
	c.Token = token

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.connections[userID] == nil {
		h.connections[userID] = make(map[*Client]bool)
	}

	firstConnection := len(h.connections[userID]) == 0
	h.connections[userID][c] = true

	if firstConnection && h.onConnect != nil {
		h.onConnect(userID)
	}

	return c, firstConnection
}

// Remove unregisters a client. Deletes the user entry when the last connection
// closes so that GetOnlineUserIDs never returns stale disconnected users.
func (h *Hub) Remove(userID int64, c *Client) int {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.connections[userID] == nil {
		return 0
	}

	if !h.connections[userID][c] {
		return len(h.connections[userID])
	}
	delete(h.connections[userID], c)
	close(c.Done)
	remaining := len(h.connections[userID])

	if remaining == 0 {
		delete(h.connections, userID)
		if h.onDisconnect != nil {
			h.onDisconnect(userID)
		}
	}

	return remaining
}

// DisconnectToken closes only sockets authenticated with this session. It
// waits for each read pump to remove its client before the caller reports
// successful revocation.
func (h *Hub) DisconnectToken(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	h.mu.RLock()
	var clients []*Client
	for _, byUser := range h.connections {
		for c := range byUser {
			if c.Token == token {
				clients = append(clients, c)
			}
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		_ = c.Conn.Close()
	}
	for _, c := range clients {
		select {
		case <-c.Done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (h *Hub) GetOnlineUserIDs() []int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var userIDs []int64
	for userID := range h.connections {
		userIDs = append(userIDs, userID)
	}
	return userIDs
}

func (h *Hub) IsUserOnline(userID int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections[userID]) > 0
}

func (h *Hub) GetConnectionCount(userID int64) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections[userID])
}

// BroadcastPresenceUpdate enqueues a presence.update message for every connected
// client via their send channels — never writes to connections directly.
func (h *Hub) BroadcastPresenceUpdate(userID int64, isOnline bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := WSMessage{
		Type: "presence.update",
		Payload: json.RawMessage(
			`{"user_id":` + int64ToJSON(userID) + `,"is_online":` + boolToJSON(isOnline) + `}`,
		),
	}
	data, _ := json.Marshal(msg)

	for _, clients := range h.connections {
		for c := range clients {
			select {
			case c.Send <- data:
			default:
				// slow client — drop rather than block
			}
		}
	}
}

// SendToUser enqueues data for every connection belonging to the given user.
// The read lock is held for the entire iteration because the channel sends are
// non-blocking (select/default), making it safe to hold a read lock here — and
// necessary to prevent a concurrent Remove from mutating the clients map while
// we iterate it.
func (h *Hub) SendToUser(userID int64, data []byte) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := h.connections[userID]
	if len(clients) == 0 {
		return ErrUserOffline
	}

	for c := range clients {
		select {
		case c.Send <- data:
		default:
		}
	}
	return nil
}

// NotifyNotification tells one user that a notification row was created for
// them, so the SPA can refetch on demand instead of polling on a timer. The
// frame deliberately carries no payload: the notification list is authoritative
// and is fetched over REST, so duplicating its contents on the wire would give
// the client two sources of truth to reconcile.
//
// Delivery is best-effort — a recipient who is offline (or whose buffer is
// full) simply picks the notification up from the list on their next load.
func (h *Hub) NotifyNotification(userID int64) {
	data, err := json.Marshal(WSMessage{Type: "notification.new"})
	if err != nil {
		return
	}
	_ = h.SendToUser(userID, data)
}

// InvalidateSocial sends only a refresh hint. Empty recipients broadcasts an
// actual privacy switch, since any authenticated viewer may hold affected data.
func (h *Hub) InvalidateSocial(userIDs []int64) {
	data, _ := json.Marshal(WSMessage{Type: "social.invalidate"})
	if len(userIDs) == 0 {
		userIDs = h.GetOnlineUserIDs()
	}
	seen := make(map[int64]bool)
	for _, id := range userIDs {
		if !seen[id] {
			_ = h.SendToUser(id, data)
			seen[id] = true
		}
	}
}

// SendSnapshotToClient enqueues a presence.snapshot to a single client.
// Call this immediately after Add so the connecting client learns who is online.
// Using the Client directly (rather than a userID) ensures only the new
// connection receives the snapshot — not any existing tabs for the same user.
func (h *Hub) SendSnapshotToClient(c *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	users := make([]json.RawMessage, 0, len(h.connections))
	for uid := range h.connections {
		users = append(users, json.RawMessage(
			`{"user_id":`+int64ToJSON(uid)+`,"is_online":true}`,
		))
	}

	payload, _ := json.Marshal(map[string]any{"users": users})
	msg := WSMessage{
		Type:    "presence.snapshot",
		Payload: payload,
	}
	data, _ := json.Marshal(msg)

	select {
	case c.Send <- data:
	default:
	}
}

type WSMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

var ErrUserOffline = fmt.Errorf("user offline")

func int64ToJSON(v int64) string {
	return strconv.FormatInt(v, 10)
}

func boolToJSON(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
