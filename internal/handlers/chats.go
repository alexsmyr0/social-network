// internal/handlers/chats.go
package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"

	"forum/internal/db"
	"forum/internal/middleware"
	"forum/internal/ws"
)

type ChatsHandler struct {
	conn *sql.DB
	hub  *ws.Hub
}

func NewChatsHandler(database *sql.DB, hub *ws.Hub) *ChatsHandler {
	return &ChatsHandler{conn: database, hub: hub}
}

/*--------------------------
  HANDLE CHAT ROSTER
--------------------------*/

// rosterResponseEntry is the JSON shape for a single roster row.
// Last-message fields are pointers so they can be encoded as `null` for users
// without history, matching SDS § 5.3.
type rosterResponseEntry struct {
	UserID             int64   `json:"user_id"`
	Username           string  `json:"username"`
	IsOnline           bool    `json:"is_online"`
	LastMessageAt      *string `json:"last_message_at"`
	LastMessagePreview *string `json:"last_message_preview"`
	LastSenderID       *int64  `json:"last_sender_id"`
}

func (h *ChatsHandler) HandleChatRoster(w http.ResponseWriter, r *http.Request) {
	userID, err := middleware.GetUserID(r.Context())
	if err != nil || userID == 0 {
		WriteError(w, r, NewError("UNAUTHORIZED", "user not authenticated", http.StatusUnauthorized))
		return
	}

	entries, err := db.GetChatRoster(r.Context(), h.conn, userID)
	if err != nil {
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to load roster", http.StatusInternalServerError))
		return
	}

	roster := make([]rosterResponseEntry, len(entries))
	for i, e := range entries {
		row := rosterResponseEntry{
			UserID:   e.UserID,
			Username: e.Username,
			IsOnline: h.hub.IsUserOnline(e.UserID),
		}
		if e.LastMessageAt != "" {
			at := e.LastMessageAt
			preview := e.LastMessagePreview
			sender := e.LastSenderID
			row.LastMessageAt = &at
			row.LastMessagePreview = &preview
			row.LastSenderID = &sender
		}
		roster[i] = row
	}

	WriteOK(w, roster, nil)
}

/*--------------------------
  HANDLE CHAT MESSAGES
--------------------------*/

// HandleChatMessages dispatches the per-conversation subroutes under
// /api/v1/chats/{userID}/...:
//   - GET  .../messages → chat history
//   - POST .../images   → DM image upload (C09)
func (h *ChatsHandler) HandleChatMessages(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/chats/")
	switch {
	case strings.HasSuffix(path, "/messages"):
		if r.Method != http.MethodGet {
			MethodNotAllowed(w, r)
			return
		}
		h.getChatHistory(w, r)
	case strings.HasSuffix(path, "/images"):
		if r.Method != http.MethodPost {
			MethodNotAllowed(w, r)
			return
		}
		h.uploadDMImage(w, r)
	default:
		WriteError(w, r, NewError("BAD_REQUEST", "invalid path, expected /chats/{userID}/messages or /chats/{userID}/images", http.StatusBadRequest))
	}
}

/*--------------------------
  UPLOAD DM IMAGE (C09)
--------------------------*/

// uploadDMImage stores an image to be attached to a DM and returns its URL.
// It does not create a message — the sender includes the returned image_url in
// a subsequent dm.send WebSocket event (SDS §5.7). Validation (size, allowed
// types) is shared with the post/comment upload path.
func (h *ChatsHandler) uploadDMImage(w http.ResponseWriter, r *http.Request) {
	userID, err := middleware.GetUserID(r.Context())
	if err != nil || userID == 0 {
		WriteError(w, r, NewError("UNAUTHORIZED", "user not authenticated", http.StatusUnauthorized))
		return
	}

	// Parse and validate the {userID} path segment so the endpoint honours its
	// route contract; the recipient itself is validated again on dm.send.
	if _, ok := parseChatTargetID(r.URL.Path, "/images"); !ok {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid recipient user ID", http.StatusBadRequest))
		return
	}

	cleanup, ok := parseMultipartForm(w, r)
	if !ok {
		return
	}
	defer cleanup()

	file, mime, hasUpload, ok := parseImageUpload(w, r)
	if !ok {
		return
	}
	if !hasUpload {
		WriteError(w, r, NewError("BAD_REQUEST", "image field is required", http.StatusBadRequest))
		return
	}
	defer file.Close()

	url, _, err := saveUploadedImageToSubdir(file, mime, "dm")
	if err != nil {
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to save image", http.StatusInternalServerError))
		return
	}

	WriteOK(w, map[string]string{"image_url": url}, nil)
}

// parseChatTargetID extracts the positive {userID} from a
// /api/v1/chats/{userID}/<suffix> path. Returns false when the segment is
// missing or not a positive integer.
func parseChatTargetID(path, suffix string) (int64, bool) {
	p := strings.TrimPrefix(path, "/api/v1/chats/")
	p = strings.TrimSuffix(p, suffix)
	p = strings.Trim(p, "/")
	if p == "" {
		return 0, false
	}
	id, err := strconv.ParseInt(p, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

/*--------------------------
  GET CHAT HISTORY
--------------------------*/

func (h *ChatsHandler) getChatHistory(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if !strings.HasSuffix(path, "/messages") {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid path, expected /chats/{userID}/messages", http.StatusBadRequest))
		return
	}

	path = strings.TrimSuffix(path, "/messages")
	path = strings.TrimPrefix(path, "/api/v1/chats/")
	if path == "" {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid path", http.StatusBadRequest))
		return
	}

	recipientID, err := strconv.ParseInt(path, 10, 64)
	if err != nil || recipientID <= 0 {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid recipient user ID", http.StatusBadRequest))
		return
	}

	userID, err := middleware.GetUserID(r.Context())
	if err != nil || userID == 0 {
		WriteError(w, r, NewError("UNAUTHORIZED", "user not authenticated", http.StatusUnauthorized))
		return
	}

	beforeIDStr := r.URL.Query().Get("before_id")
	var beforeID int64
	if beforeIDStr != "" {
		beforeID, err = strconv.ParseInt(beforeIDStr, 10, 64)
		if err != nil || beforeID <= 0 {
			WriteError(w, r, NewError("BAD_REQUEST", "invalid before_id", http.StatusBadRequest))
			return
		}
	}

	messages, hasMore, err := db.GetMessageHistory(r.Context(), h.conn, userID, recipientID, beforeID)
	if err != nil {
		WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to retrieve messages", http.StatusInternalServerError))
		return
	}

	usersMap := make(map[int64]string)
	if len(messages) > 0 {
		uniqueSenders := make(map[int64]bool)
		for _, msg := range messages {
			uniqueSenders[msg.SenderID] = true
		}
		senderIDs := make([]int64, 0, len(uniqueSenders))
		for senderID := range uniqueSenders {
			senderIDs = append(senderIDs, senderID)
		}

		users, err := db.GetUsersByIDs(r.Context(), h.conn, senderIDs)
		if err != nil {
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to retrieve user info", http.StatusInternalServerError))
			return
		}
		for _, user := range users {
			usersMap[user.ID] = user.Username
		}
		// Graceful fallback for orphaned senders (user deleted after sending).
		for senderID := range uniqueSenders {
			if _, found := usersMap[senderID]; !found {
				usersMap[senderID] = "unknown"
			}
		}
	}

	messagesData := make([]map[string]any, len(messages))
	for i, msg := range messages {
		senderUsername := usersMap[msg.SenderID]
		row := map[string]any{
			"id":              msg.ID,
			"sender_id":       msg.SenderID,
			"recipient_id":    msg.RecipientID,
			"sender_username": senderUsername,
			"body":            msg.Body,
			"created_at":      msg.CreatedAt,
		}
		if msg.ImagePath != nil {
			row["image_url"] = *msg.ImagePath
		}
		messagesData[i] = row
	}

	resp := struct {
		Messages []map[string]any `json:"messages"`
		HasMore  bool             `json:"has_more"`
	}{
		Messages: messagesData,
		HasMore:  hasMore,
	}

	WriteOK(w, resp, nil)
}
