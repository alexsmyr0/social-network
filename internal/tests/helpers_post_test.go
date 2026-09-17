package tests

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func countPostCategoriesForPostID(t *testing.T, db *sql.DB, postID int64) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM post_categories WHERE post_id = ?`, postID).Scan(&n); err != nil {
		t.Fatalf("count post_categories: %v", err)
	}
	return n
}

func patchPost(t *testing.T, h http.Handler, token string, postID int64, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/posts/%d", postID), bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func getPost(t *testing.T, h http.Handler, token string, postID int64) map[string]any {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", postID), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	body := rec.Body.Bytes()

	w := rec
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, string(body))
	}

	var env apiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("unmarshal env: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: %+v", env.Error)
	}

	var post map[string]any
	if err := json.Unmarshal(env.Data, &post); err != nil {
		t.Fatalf("unmarshal post: %v", err)
	}
	return post
}

func countPostsByTitle(t *testing.T, db *sql.DB, title string) int {
	t.Helper()

	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM posts WHERE title = ?`, title).Scan(&n); err != nil {
		t.Fatalf("count posts by title: %v", err)
	}
	return n
}

func countPostCategoriesForTitle(t *testing.T, db *sql.DB, title string) int {
	t.Helper()

	var n int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM post_categories pc
		JOIN posts p ON p.id = pc.post_id
		WHERE p.title = ?
	`, title).Scan(&n); err != nil {
		t.Fatalf("count post_categories: %v", err)
	}
	return n
}

func createPostRequest(t *testing.T, h http.Handler, token string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/posts", bytes.NewReader(bodyBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func createPostRequestWithoutCookie(t *testing.T, h http.Handler, token *string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()

	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/posts", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")

	if token != nil {
		req.Header.Set("Cookie", "session_token="+*token)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func createPostAndGetID(t *testing.T, h http.Handler, token string, payload map[string]any) int64 {
	t.Helper()

	rec := createPostRequest(t, h, token, payload)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal env: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: %+v", env.Error)
	}

	var post map[string]any
	if err := json.Unmarshal(env.Data, &post); err != nil {
		t.Fatalf("unmarshal post: %v", err)
	}

	idAny, ok := post["id"]
	if !ok {
		t.Fatalf("expected id in create response, post=%v", post)
	}
	return int64(idAny.(float64))
}

func registerUser(t *testing.T, h http.Handler, username, email, password string) {
	t.Helper()

	body := fmt.Sprintf(`{"username":%q,"email":%q,"password":%q,"first_name":"First","last_name":"Last","age":20,"gender":"other"}`, username, email, password)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}
}

func loginAndGetToken(t *testing.T, h http.Handler, username, password string) string {
	t.Helper()

	loginBody := fmt.Sprintf(`{"username":%q,"password":%q}`, username, password)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d body=%s", rec.Code, rec.Body.String())
	}

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected Set-Cookie header on login")
	}
	return strings.Split(strings.Split(setCookie, ";")[0], "=")[1]
}

func seedPosts(t *testing.T, db *sql.DB, authorID int64, n int) {
	t.Helper()

	for i := 0; i < n; i++ {
		_, err := db.Exec(`
			INSERT INTO posts (author_id, title, body, status, created_at, updated_at)
			VALUES (?, ?, ?, 'published', datetime('now', ?), datetime('now', ?))
		`, authorID, "Post "+fmt.Sprint(i), "Body "+fmt.Sprint(i), fmt.Sprintf("-%d seconds", i), fmt.Sprintf("-%d seconds", i))
		if err != nil {
			t.Fatalf("seed posts: %v", err)
		}
	}
}

func decodePostsList(t *testing.T, body []byte) []map[string]any {
	t.Helper()

	var env apiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: %+v", env.Error)
	}

	var posts []map[string]any
	if err := json.Unmarshal(env.Data, &posts); err != nil {
		t.Fatalf("unmarshal posts: %v", err)
	}
	return posts
}
