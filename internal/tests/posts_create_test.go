package tests

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIPostsCreate(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	registerUser(t, h, "testuser2", "test2@example.com", "password123")
	token := loginAndGetToken(t, h, "testuser2", "password123")

	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "API Test Post",
		"body":         "Body from API test",
		"category_ids": []int64{1},
	})

	post := getPost(t, h, token, postID)

	if post["title"] != "API Test Post" {
		t.Fatalf("expected title %q, got %v", "API Test Post", post["title"])
	}
	if post["body"] != "Body from API test" {
		t.Fatalf("expected body %q, got %v", "Body from API test", post["body"])
	}
	if post["author"] != "testuser2" {
		t.Fatalf("expected author %q, got %v", "testuser2", post["author"])
	}
}

func TestAPIPostsCreate_JSONDraftPersistsDraftStatus(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	registerUser(t, h, "draftjson", "draftjson@example.com", "password123")
	token := loginAndGetToken(t, h, "draftjson", "password123")

	rec := createPostRequest(t, h, token, map[string]any{
		"title":  "JSON draft title",
		"body":   "JSON draft body",
		"status": "draft",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := decodeEnvelopeDataMap(t, rec)
	postID := postIDFromResponse(t, post)
	stored := loadStoredPost(t, db, postID)

	if stored.title != "JSON draft title" {
		t.Fatalf("expected persisted title %q, got %q", "JSON draft title", stored.title)
	}
	if stored.body != "JSON draft body" {
		t.Fatalf("expected persisted body %q, got %q", "JSON draft body", stored.body)
	}
	if stored.status != "draft" {
		t.Fatalf("expected persisted status draft, got %q", stored.status)
	}
}

func TestAPIPostsCreate_MultipartDraftPersistsDraftStatusAndImage(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	registerUser(t, h, "draftupload", "draftupload@example.com", "password123")
	token := loginAndGetToken(t, h, "draftupload", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title":  "Multipart draft title",
			"body":   "",
			"status": "draft",
		},
		nil,
		"draft.png",
		samplePNGBytes,
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := decodeEnvelopeDataMap(t, rec)
	rawURL, ok := post["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url in create response, got post=%v", post)
	}
	imageURL, ok := rawURL.(string)
	if !ok || strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

	postID := postIDFromResponse(t, post)
	stored := loadStoredPost(t, db, postID)

	if stored.status != "draft" {
		t.Fatalf("expected persisted status draft, got %q", stored.status)
	}
	if stored.imageURL == nil || *stored.imageURL != imageURL {
		t.Fatalf("expected persisted image_url %q, got %v", imageURL, stored.imageURL)
	}
}

func TestAPIPostsCreate_PublishedStatusStillUsesNormalCreateFlow(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	registerUser(t, h, "publishedjson", "publishedjson@example.com", "password123")
	token := loginAndGetToken(t, h, "publishedjson", "password123")

	rec := createPostRequest(t, h, token, map[string]any{
		"title":        "Published title",
		"body":         "Published body",
		"status":       "published",
		"category_ids": []int64{1},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := decodeEnvelopeDataMap(t, rec)
	postID := postIDFromResponse(t, post)
	stored := loadStoredPost(t, db, postID)

	if stored.status != "published" {
		t.Fatalf("expected persisted status published, got %q", stored.status)
	}
	if stored.title != "Published title" {
		t.Fatalf("expected persisted title %q, got %q", "Published title", stored.title)
	}
	if stored.body != "Published body" {
		t.Fatalf("expected persisted body %q, got %q", "Published body", stored.body)
	}
	if got := countPostCategoriesForPostID(t, db, postID); got != 1 {
		t.Fatalf("expected one category for normal published create, got %d", got)
	}
}

func TestAPIPostsCreate_InvalidTitleOrBody(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	cases := []struct {
		name    string
		payload map[string]any
	}{
		{
			name: "missing title",
			payload: map[string]any{
				"body":         "Body",
				"category_ids": []int64{1},
			},
		},
		{
			name: "empty title",
			payload: map[string]any{
				"title":        "",
				"body":         "Body",
				"category_ids": []int64{1},
			},
		},
		{
			name: "missing body",
			payload: map[string]any{
				"title":        "Title",
				"category_ids": []int64{1},
			},
		},
		{
			name: "empty body",
			payload: map[string]any{
				"title":        "Title",
				"body":         "",
				"category_ids": []int64{1},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := createPostRequest(t, h, token, tc.payload)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAPIPostsCreate_RequiresAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	rec := createPostRequestWithoutCookie(t, h, nil, map[string]any{
		"title":        "Unauthed post",
		"body":         "Body",
		"category_ids": []int64{1},
	})

	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("expected 401 or 403, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAPIPostsCreate_InvalidSessionToken(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	bad := "definitely-not-valid"
	rec := createPostRequestWithoutCookie(t, h, &bad, map[string]any{
		"title":        "Bad token post",
		"body":         "Body",
		"category_ids": []int64{1},
	})

	if rec.Code != http.StatusUnauthorized && rec.Code != http.StatusForbidden {
		t.Fatalf("expected 401 or 403, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAPIPostsCreate_CategoryIDsRequired(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	cases := []struct {
		name    string
		title   string
		payload map[string]any
	}{
		{
			name:  "missing category_ids",
			title: "Post missing category_ids",
			payload: map[string]any{
				"title": "Post missing category_ids",
				"body":  "Body here",
			},
		},
		{
			name:  "empty category_ids",
			title: "Post empty category_ids",
			payload: map[string]any{
				"title":        "Post empty category_ids",
				"body":         "Body here",
				"category_ids": []int64{},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			rec := createPostRequest(t, h, token, tc.payload)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}

			if got := countPostsByTitle(t, db, tc.title); got != 0 {
				t.Fatalf("expected no post created, found %d", got)
			}
		})
	}
}

func TestAPIPostsCreate_DuplicateCategoryIDs(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// ensure category 2 exists (1 likely exists in seed)
	_, err := db.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES (2, 'Cat2', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
	`)
	if err != nil {
		t.Fatalf("seed categories: %v", err)
	}

	token := loginAndGetToken(t, h, "testuser", "password123")

	title := "Post with dup cats"
	rec := createPostRequest(t, h, token, map[string]any{
		"title":        title,
		"body":         "Body here",
		"category_ids": []int64{1, 1, 2, 2, 2},
	})

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Expect only 2 join rows (category 1 and 2 once each)
	if got := countPostCategoriesForTitle(t, db, title); got != 2 {
		t.Fatalf("expected 2 unique post_categories rows, got %d", got)
	}
}

func TestAPIPostsCreate_InvalidCategoryIDs(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	title := "Post invalid cats only"
	rec := createPostRequest(t, h, token, map[string]any{
		"title":        title,
		"body":         "Body here",
		"category_ids": []int64{0, -1, -50},
	})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	if got := countPostsByTitle(t, db, title); got != 0 {
		t.Fatalf("expected no post created, found %d", got)
	}
}

func TestAPIPostsCreateWithCategories(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	_, err := db.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES 
		(2, 'Cat2', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
		(3, 'Cat3', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
	`)
	if err != nil {
		t.Fatalf("failed to seed categories: %v", err)
	}

	token := loginAndGetToken(t, h, "testuser", "password123")

	_ = createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post with categories",
		"body":         "Body here",
		"category_ids": []int64{1, 2, 3},
	})
}

func TestAPIPostsCreate_InvalidJSON(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	// deliberately broken JSON
	badJSON := `{"title": "X", "body": "Y", "category_ids": [1]`

	req := httptest.NewRequest(http.MethodPost, "/api/v1/posts", bytes.NewBufferString(badJSON))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal env: %v", err)
	}
	if env.Error == nil {
		t.Fatalf("expected error envelope, got none: %s", rec.Body.String())
	}
	if env.Error.Code != "BAD_REQUEST" {
		t.Fatalf("expected BAD_REQUEST, got %q", env.Error.Code)
	}
	if env.Error.Message != "invalid json" {
		t.Fatalf("expected message 'invalid json', got %q", env.Error.Message)
	}
}

type storedPostRow struct {
	title    string
	body     string
	status   string
	imageURL *string
}

func postIDFromResponse(t *testing.T, post map[string]any) int64 {
	t.Helper()

	rawID, ok := post["id"]
	if !ok {
		t.Fatalf("missing id in create response: %v", post)
	}

	id, ok := rawID.(float64)
	if !ok {
		t.Fatalf("expected numeric id in create response, got %T(%v)", rawID, rawID)
	}
	return int64(id)
}

func loadStoredPost(t *testing.T, db *sql.DB, postID int64) storedPostRow {
	t.Helper()

	var row storedPostRow
	var imageURL sql.NullString
	if err := db.QueryRow(`
		SELECT title, body, status, image_url
		FROM posts
		WHERE id = ?
	`, postID).Scan(&row.title, &row.body, &row.status, &imageURL); err != nil {
		t.Fatalf("load stored post %d: %v", postID, err)
	}
	if imageURL.Valid {
		row.imageURL = &imageURL.String
	}
	return row
}
