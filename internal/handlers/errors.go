// Internal/db/errors.go
package handlers

import (
	"database/sql"
	"errors"
	"forum/internal/db"
	"net/http"
)

type APIError struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
	Status  int               `json:"-"`
}

func (e *APIError) Error() string {
	return e.Message
}

func writeHandlerError(w http.ResponseWriter, r *http.Request, err error, fallbackMsg string) bool {
	if err == nil {
		return false
	}

	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, db.ErrNotFound) {
		notFound(w, r)
		return true
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		WriteError(w, r, apiErr)
		return true
	}

	WriteError(w, r, NewError(
		"INTERNAL_SERVER_ERROR",
		fallbackMsg,
		http.StatusInternalServerError,
	))
	return true
}
