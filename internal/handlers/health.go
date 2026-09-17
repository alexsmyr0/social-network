// Internal/handlers/health.go
package handlers

import (
	"errors"
	"net/http"
)

type HealthHandler struct{}

func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

func (h *HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("error") == "500" {
		writeHandlerError(w, r, errors.New("test internal error"), "simulated server error")
		return
	}
	if r.URL.Query().Get("error") == "400" {
		WriteError(w, r, NewError("BAD_REQUEST", "test bad request", http.StatusBadRequest))
		return
	}
	WriteOK(w, map[string]any{"status": "ok"}, nil)
}
