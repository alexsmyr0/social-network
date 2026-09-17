package tests

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAPIHealth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	w, body := doRequest(t, h, http.MethodGet, "/api/v1/health", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d, body=%s", w.Code, string(body))
	}

	var env apiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error in response: %+v", env.Error)
	}

	var payload struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(env.Data, &payload); err != nil {
		t.Fatalf("failed to unmarshal data: %v", err)
	}
	if payload.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", payload.Status)
	}
}
