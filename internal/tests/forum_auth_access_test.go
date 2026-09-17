package tests

import (
	"database/sql"
	"net/http"
	"testing"
)

func seedCommentForAuthAccessTest(t *testing.T, dbConn *sql.DB) {
	t.Helper()

	if _, err := dbConn.Exec(`
		INSERT INTO comments (id, post_id, user_id, body, created_at, updated_at)
		VALUES (1, 1, 1, 'Seed comment', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
	`); err != nil {
		t.Fatalf("seed comment: %v", err)
	}
}

func TestForumContentEndpoints_RequireAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	seedCommentForAuthAccessTest(t, db)

	paths := []string{
		"/api/v1/categories",
		"/api/v1/categories/1",
		"/api/v1/categories/view",
		"/api/v1/posts?page=1&per_page=10",
		"/api/v1/posts/1",
		"/api/v1/posts/1/comments",
		"/api/v1/comments/1",
		"/api/v1/users/activity",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec, _ := doRequest(t, h, http.MethodGet, path, nil)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestForumContentEndpoints_AccessWithAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	seedCommentForAuthAccessTest(t, db)
	token := loginAndGetToken(t, h, "testuser", "password123")

	paths := []string{
		"/api/v1/categories",
		"/api/v1/categories/1",
		"/api/v1/categories/view",
		"/api/v1/posts?page=1&per_page=10",
		"/api/v1/posts/1",
		"/api/v1/posts/1/comments",
		"/api/v1/comments/1",
		"/api/v1/users/activity",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			rec, _ := doRequestWithToken(t, h, http.MethodGet, path, token, nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestChatRoutes_GuestCannotSuccessfullyAccess_CurrentStage(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	tests := []struct {
		path string
		want int
	}{
		// Chat routes are wired (C03 history, C05 roster) — guests get 401.
		{path: "/api/v1/chats", want: http.StatusUnauthorized},
		{path: "/api/v1/chats/1/messages", want: http.StatusUnauthorized},
		// /ws is now wired - guests should get 401 (unauthorized), not 404
		{path: "/ws", want: http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			rec, _ := doRequest(t, h, http.MethodGet, tt.path, nil)
			if rec.Code != tt.want {
				t.Fatalf("expected %d, got %d body=%s", tt.want, rec.Code, rec.Body.String())
			}
		})
	}
}
