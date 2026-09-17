// internal/handlers/notifications.go
package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	repository "forum/internal/db"
)

type NotificationsHandler struct {
	conn *sql.DB
}

func NewNotificationsHandler(db *sql.DB) *NotificationsHandler {
	return &NotificationsHandler{conn: db}
}

func (h *NotificationsHandler) HandleNotifications(w http.ResponseWriter, r *http.Request) {

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	switch r.Method {

	case http.MethodGet:
		result, err := repository.ListUserNotifications(r.Context(), h.conn, userID)
		if err != nil {
			WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to load notifications", http.StatusInternalServerError))
			return
		}
		WriteOK(w, result, nil)

	case http.MethodPatch:

		path := strings.TrimPrefix(r.URL.Path, "/api/v1/notifications/")

		if path == "read-all" {
			err := repository.MarkAllNotificationsRead(r.Context(), h.conn, userID)
			if err != nil {
				WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to mark all read", http.StatusInternalServerError))
				return
			}
			WriteNoContent(w)
			return
		}

		if strings.HasSuffix(path, "/read") {
			idStr := strings.TrimSuffix(path, "/read")
			id, err := parsePositiveID(idStr)
			if err != nil {
				WriteError(w, r, NewError("BAD_REQUEST", "invalid notification id", http.StatusBadRequest))
				return
			}

			updated, err := repository.MarkNotificationRead(r.Context(), h.conn, userID, id)
			if err != nil {
				WriteError(w, r, NewError("INTERNAL_SERVER_ERROR", "failed to mark read", http.StatusInternalServerError))
				return
			}
			if !updated {
				WriteError(w, r, NewError("NOT_FOUND", "notification not found", http.StatusNotFound))
				return
			}

			WriteNoContent(w)
			return
		}

		MethodNotAllowed(w, r)

	default:
		MethodNotAllowed(w, r)
	}
}
