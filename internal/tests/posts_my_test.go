package tests

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIMyPostsList(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Register + login USER A
	regA := `{"username":"alice","email":"a@example.com","password":"password123","first_name":"Alice","last_name":"User","age":20,"gender":"female"}`
	_, _ = doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(regA))

	loginA := `{"username":"alice","password":"password123"}`
	recA, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(loginA))

	tokenA := extractToken(t, recA)

	// Register + login USER B
	regB := `{"username":"bob","email":"b@example.com","password":"password123","first_name":"Bob","last_name":"User","age":22,"gender":"male"}`
	_, _ = doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(regB))

	loginB := `{"username":"bob","password":"password123"}`
	recB, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(loginB))

	tokenB := extractToken(t, recB)

	// USER A creates 2 posts
	createPost := func(token, title string) {
		payload := map[string]any{
			"title":        title,
			"body":         "body",
			"category_ids": []int64{1},
		}
		b, _ := json.Marshal(payload)

		req := httptest.NewRequest(http.MethodPost, "/api/v1/posts", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", "session_token="+token)

		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)

		if w.Code != http.StatusCreated {
			t.Fatalf("post create failed: %d %s", w.Code, w.Body.String())
		}
	}

	createPost(tokenA, "Alice post 1")
	createPost(tokenA, "Alice post 2")
	createPost(tokenB, "Bob post")

	// USER A fetches /posts/mine
	req := httptest.NewRequest(http.MethodGet, "/api/v1/posts/mine?page=1&per_page=10", nil)
	req.Header.Set("Cookie", "session_token="+tokenA)

	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d, body=%s", w.Code, w.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}

	var posts []map[string]any
	if err := json.Unmarshal(env.Data, &posts); err != nil {
		t.Fatalf("unmarshal posts: %v", err)
	}

	if len(posts) != 2 {
		t.Fatalf("expected 2 posts, got %d", len(posts))
	}

	for _, p := range posts {
		if strings.Contains(p["title"].(string), "Bob") {
			t.Fatalf("found post from another user")
		}
	}
}

func TestGuestCannotListMyPosts(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/posts/mine", nil)
	w := httptest.NewRecorder()

	h.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
