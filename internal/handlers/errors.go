// Internal/db/errors.go
package handlers

import (
	"errors"
	"net/http"
)

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Status  int    `json:"-"`
}

func (e *APIError) Error() string {
	return e.Message
}

func writeHandlerError(w http.ResponseWriter, r *http.Request, err error, fallbackMsg string) bool {
	if err == nil {
		return false
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
