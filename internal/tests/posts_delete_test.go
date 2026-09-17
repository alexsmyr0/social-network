package tests

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAPIPostDelete_Success(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	// Ensure extra category exists
	_, err := db.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES (222, 'DelCat', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
	`)
	if err != nil {
		t.Fatalf("seed category: %v", err)
	}

	// Create a post with 2 categories (1 from seed + 222)
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Delete Me",
		"body":         "Body",
		"category_ids": []int64{1, 222},
	})

	// Sanity: post exists + has 2 join rows
	if got := countPostCategoriesForPostID(t, db, postID); got != 2 {
		t.Fatalf("expected 2 post_categories rows before delete, got %d", got)
	}

	// DELETE
	req := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", postID), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Post should be gone meaning GET should 404
	w, body := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", postID), token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d body=%s", w.Code, string(body))
	}

	// Join rows should be gone too
	if got := countPostCategoriesForPostID(t, db, postID); got != 0 {
		t.Fatalf("expected 0 post_categories rows after delete, got %d", got)
	}
}

func TestAPIPostDelete_OnlyAuthorCanDelete(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Author (user A) creates the post
	tokenA := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, tokenA, map[string]any{
		"title":        "Delete Protected",
		"body":         "Body",
		"category_ids": []int64{1},
	})

	// Register + login another user B
	regBody := `{"username":"delete_other","email":"delete_other@example.com","password":"password123","first_name":"Delete","last_name":"Other","age":25,"gender":"other"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register other user failed: %d body=%s", rec.Code, rec.Body.String())
	}

	tokenB := loginAndGetToken(t, h, "delete_other", "password123")

	// User B tries to delete user A's post
	req = httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", postID), nil)
	req.Header.Set("Cookie", "session_token="+tokenB)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden && rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 or 403, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Post must still exist
	_ = getPost(t, h, tokenA, postID)
}
