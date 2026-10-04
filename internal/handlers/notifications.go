// internal/handlers/notifications.go
package handlers

import (
	"database/sql"
	"net/http"
	"strings"

	repository "forum/internal/db"
)

type NotificationsHandler struct {
	conn         *sql.DB
	socialSchema bool
}

func NewNotificationsHandler(db *sql.DB, socialSchema bool) *NotificationsHandler {
	return &NotificationsHandler{conn: db, socialSchema: socialSchema}
}

func (h *NotificationsHandler) HandleNotifications(w http.ResponseWriter, r *http.Request) {
	if h.socialSchema {
		h.handleSocialNotifications(w, r)
		return
	}

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

func (h *NotificationsHandler) handleSocialNotifications(w http.ResponseWriter, r *http.Request) {
	viewer, ok := requireUserID(w, r)
	if !ok {
		return
	}
	page, per, _, e := socialQuery(r, r.Method == http.MethodGet, false)
	if e != nil {
		WriteError(w, r, e)
		return
	}
	if e := socialEmptyBody(r); e != nil {
		WriteError(w, r, e)
		return
	}
	if r.Method == http.MethodGet {
		result, err := repository.ListSocialNotifications(r.Context(), h.conn, viewer, page, per)
		if err != nil {
			socialError(w, r, err)
			return
		}
		WriteOK(w, result, &Meta{Pagination: makePaginationMeta(page, per, result.Total)})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/notifications/")
	var id int64
	if path != "read-all" {
		parts := strings.Split(path, "/")
		if len(parts) != 2 || parts[1] != "read" {
			WriteError(w, r, NewError("NOT_FOUND", "route not found", 404))
			return
		}
		id, e = socialID(parts[0])
		if e != nil {
			WriteError(w, r, e)
			return
		}
	}
	if err := repository.MarkSocialNotificationsRead(r.Context(), h.conn, viewer, id); err != nil {
		socialError(w, r, err)
		return
	}
	WriteNoContent(w)
}
