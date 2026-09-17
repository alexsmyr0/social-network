// tests/notifications_api_test.go
package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	repository "forum/internal/db"
)

type notificationsResponse struct {
	Data struct {
		Notifications []any `json:"notifications"`
		UnreadCount   int   `json:"unread_count"`
	} `json:"data"`
}

func TestNotifications_AuthRequired(t *testing.T) {
	h, _ := newTestAPI(t)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestNotifications_GetAndUnreadCount(t *testing.T) {
	h, database := newTestAPI(t)
	ctx := context.Background()

	authorID, authorEmail := createTestUser(t, database, "author")
	userID, _ := createTestUser(t, database, "user")
	postID := createTestPost(t, database, authorID)

	_, err := repository.ToggleReaction(ctx, database, userID, postID, 1, "post")
	if err != nil {
		t.Fatalf("toggle reaction: %v", err)
	}

	// Login with EMAIL
	token := loginTestUserByEmail(t, h, authorEmail)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp notificationsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("invalid json: %v", err)
	}

	if resp.Data.UnreadCount != 1 {
		t.Fatalf("expected unread_count 1, got %d", resp.Data.UnreadCount)
	}

	if len(resp.Data.Notifications) != 1 {
		t.Fatalf("expected 1 notification in list, got %d", len(resp.Data.Notifications))
	}
}

func TestNotifications_ReadOne(t *testing.T) {
	h, database := newTestAPI(t)
	ctx := context.Background()

	authorID, authorEmail := createTestUser(t, database, "author")
	userID, _ := createTestUser(t, database, "user")
	postID := createTestPost(t, database, authorID)

	_, _ = repository.ToggleReaction(ctx, database, userID, postID, 1, "post")

	token := loginTestUserByEmail(t, h, authorEmail)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/notifications/1/read", nil)
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
}

func TestNotifications_ReadAll(t *testing.T) {
	h, database := newTestAPI(t)
	ctx := context.Background()

	authorID, authorEmail := createTestUser(t, database, "author")
	userID, _ := createTestUser(t, database, "user")
	postID := createTestPost(t, database, authorID)

	_, _ = repository.ToggleReaction(ctx, database, userID, postID, 1, "post")

	token := loginTestUserByEmail(t, h, authorEmail)

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/notifications/read-all", nil)
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
}

func TestNotifications_ReadOne_InvalidID_BadRequest(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	paths := []string{
		"/api/v1/notifications/abc/read",
		"/api/v1/notifications/0/read",
		"/api/v1/notifications/-1/read",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, path, nil)
			req.Header.Set("Cookie", "session_token="+token)

			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}

			apiErr := decodeErrorEnvelope(t, rec)
			if apiErr == nil || apiErr.Code != "BAD_REQUEST" {
				t.Fatalf("expected BAD_REQUEST error, got %+v body=%s", apiErr, rec.Body.String())
			}
		})
	}
}

func TestNotifications_ReadOne_NotFound(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	req := httptest.NewRequest(http.MethodPatch, "/api/v1/notifications/9999/read", nil)
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil || apiErr.Code != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND error, got %+v body=%s", apiErr, rec.Body.String())
	}
}
