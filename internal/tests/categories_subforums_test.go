package tests

import (
	"encoding/json"
	"net/http"
	"testing"
)

/* ----------------------------------------------
   LIST CATEGORIES WITH POSTS (SUBFORUM VIEW)
-----------------------------------------------*/

func TestAPICategoriesWithPosts(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()
	token := loginAndGetToken(t, h, "testuser", "password123")

	// Seed extra category
	_, err := db.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES (2, 'DevOps', datetime('now'));
	`)
	if err != nil {
		t.Fatalf("seed category: %v", err)
	}

	// Attach post 1 to category 1
	_, err = db.Exec(`
		INSERT INTO post_categories (post_id, category_id)
		VALUES (1, 1);
	`)
	if err != nil {
		t.Fatalf("seed post_categories: %v", err)
	}

	// Call endpoint (TO BE IMPLEMENTED)
	w, body := doRequestWithToken(
		t,
		h,
		http.MethodGet,
		"/api/v1/categories/view",
		token,
		nil,
	)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, string(body))
	}

	var env apiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: %+v", env.Error)
	}

	var categories []map[string]any
	if err := json.Unmarshal(env.Data, &categories); err != nil {
		t.Fatalf("unmarshal categories: %v", err)
	}

	if len(categories) < 1 {
		t.Fatalf("expected at least 1 category")
	}

	// Each category must contain "posts"
	for _, c := range categories {
		if _, ok := c["posts"]; !ok {
			t.Fatalf("expected category to contain posts field")
		}
	}
}
