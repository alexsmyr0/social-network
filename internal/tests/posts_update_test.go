package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestAPIPostUpdate_OnlyAuthorCanUpdate(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// User A (seed user) creates the post
	tokenA := loginAndGetToken(t, h, "testuser", "password123")

	postID := createPostAndGetID(t, h, tokenA, map[string]any{
		"title":        "Author Title",
		"body":         "Author Body",
		"category_ids": []int64{1},
	})

	// Register + login User B
	registerUser(t, h, "otheruser", "other@example.com", "password123")
	tokenB := loginAndGetToken(t, h, "otheruser", "password123")

	// User B attempts to update User A's post
	rec := patchPost(t, h, tokenB, postID, map[string]any{
		"title": "Hacked Title",
	})

	if rec.Code != http.StatusForbidden && rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 or 403, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Verify post did not change
	post := getPost(t, h, tokenA, postID)
	if post["title"] != "Author Title" {
		t.Fatalf("expected title unchanged, got %v", post["title"])
	}
	if post["body"] != "Author Body" {
		t.Fatalf("expected body unchanged, got %v", post["body"])
	}
}

func TestAPIPostUpdate_Content(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	cases := []struct {
		name         string
		patch        map[string]any
		wantTitle    string
		wantBody     string
		initialTitle string
		initialBody  string
	}{
		{
			name:         "title only",
			patch:        map[string]any{"title": "Updated Title"},
			initialTitle: "Original Title",
			initialBody:  "Original Body",
			wantTitle:    "Updated Title",
			wantBody:     "Original Body",
		},
		{
			name:         "body only",
			patch:        map[string]any{"body": "Updated Body"},
			initialTitle: "Original Title",
			initialBody:  "Original Body",
			wantTitle:    "Original Title",
			wantBody:     "Updated Body",
		},
		{
			name:         "title and body",
			patch:        map[string]any{"title": "Updated Title", "body": "Updated Body"},
			initialTitle: "Original Title",
			initialBody:  "Original Body",
			wantTitle:    "Updated Title",
			wantBody:     "Updated Body",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			postID := createPostAndGetID(t, h, token, map[string]any{
				"title":        tc.initialTitle,
				"body":         tc.initialBody,
				"category_ids": []int64{1},
			})

			rec := patchPost(t, h, token, postID, tc.patch)
			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
			}

			post := getPost(t, h, token, postID)
			if post["title"] != tc.wantTitle {
				t.Fatalf("expected title %q, got %v", tc.wantTitle, post["title"])
			}
			if post["body"] != tc.wantBody {
				t.Fatalf("expected body %q, got %v", tc.wantBody, post["body"])
			}
		})
	}
}

func TestAPIPostUpdate_Validation(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	cases := []struct {
		name  string
		patch map[string]any
	}{
		{name: "empty title", patch: map[string]any{"title": ""}},
		{name: "empty body", patch: map[string]any{"body": ""}},
		{name: "no fields", patch: map[string]any{}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			postID := createPostAndGetID(t, h, token, map[string]any{
				"title":        "Valid Title",
				"body":         "Valid Body",
				"category_ids": []int64{1},
			})
			rec := patchPost(t, h, token, postID, tc.patch)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
			}

			// Ensure unchanged for all invalid update attempts.
			post := getPost(t, h, token, postID)
			if post["title"] != "Valid Title" || post["body"] != "Valid Body" {
				t.Fatalf("post should be unchanged, got %v", post)
			}
		})
	}
}

func TestAPIPostUpdate_NotFound(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	const missingID int64 = 999999

	rec := patchPost(t, h, token, missingID, map[string]any{
		"title": "Does not matter",
	})

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal env: %v", err)
	}
	if env.Error == nil {
		t.Fatalf("expected error envelope, got none: %s", rec.Body.String())
	}

	// align with your app's error conventions
	if env.Error.Code != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND, got %q", env.Error.Code)
	}
	if env.Error.Message == "" {
		t.Fatalf("expected non-empty error message")
	}
}

func TestAPIPostUpdate_UpdatedAtIsSet(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	// Create post
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Original Title",
		"body":         "Original Body",
		"category_ids": []int64{1},
	})

	// Fetch post before update
	postBefore := getPost(t, h, token, postID)

	updatedAtBeforeAny, ok := postBefore["updated_at"]
	if !ok {
		t.Fatalf("expected updated_at in post before update, got %v", postBefore)
	}
	updatedAtBefore, ok := updatedAtBeforeAny.(string)
	if !ok || updatedAtBefore == "" {
		t.Fatalf("expected updated_at to be non-empty string, got %T (%v)", updatedAtBeforeAny, updatedAtBeforeAny)
	}

	// Ensure timestamp changes (SQLite uses second precision)
	time.Sleep(1100 * time.Millisecond)

	// Update title
	rec := patchPost(t, h, token, postID, map[string]any{
		"title": "Updated Title",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	// Fetch post after update
	postAfter := getPost(t, h, token, postID)

	updatedAtAfterAny, ok := postAfter["updated_at"]
	if !ok {
		t.Fatalf("expected updated_at in post after update, got %v", postAfter)
	}
	updatedAtAfter, ok := updatedAtAfterAny.(string)
	if !ok || updatedAtAfter == "" {
		t.Fatalf("expected updated_at to be non-empty string, got %T (%v)", updatedAtAfterAny, updatedAtAfterAny)
	}

	if updatedAtAfter == updatedAtBefore {
		t.Fatalf("expected updated_at to change after update, before=%q after=%q",
			updatedAtBefore, updatedAtAfter)
	}
}

func TestAPIPostUpdate_MultipartImageAndCategories(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	if _, err := db.Exec(`INSERT OR IGNORE INTO categories (id, name) VALUES (2, 'Tech')`); err != nil {
		t.Fatalf("seed category 2: %v", err)
	}

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Original title",
		"body":         "Original body",
		"category_ids": []int64{1},
	})

	rec := multipartRequest(
		t,
		h,
		http.MethodPatch,
		fmt.Sprintf("/api/v1/posts/%d", postID),
		token,
		map[string]string{
			"title": "Updated title",
			"body":  "",
		},
		[]int64{2},
		"updated.png",
		samplePNGBytes,
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := getPost(t, h, token, postID)
	if got := post["title"]; got != "Updated title" {
		t.Fatalf("expected updated title, got %v", got)
	}
	if got := post["body"]; got != "" {
		t.Fatalf("expected empty body after image-only update, got %v", got)
	}

	imageURL, ok := post["image_url"].(string)
	if !ok || imageURL == "" {
		t.Fatalf("expected image_url after multipart update, got %v", post["image_url"])
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })

	categories := extractCategoryIDsFromPost(t, post)
	if len(categories) != 1 || categories[0] != 2 {
		t.Fatalf("expected categories [2], got %v", categories)
	}
}

func TestAPIPostUpdate_RemoveImage(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	createRec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Image post",
			"body":  "",
		},
		[]int64{1},
		"initial.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdPost := decodeEnvelopeDataMap(t, createRec)
	postID := int64(createdPost["id"].(float64))

	rec := patchPost(t, h, token, postID, map[string]any{
		"title":        "No image now",
		"body":         "Body text after removing image",
		"category_ids": []int64{1},
		"remove_image": true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	post := getPost(t, h, token, postID)
	if got := post["image_url"]; got != nil {
		t.Fatalf("expected image_url to be nil after remove_image update, got %v", got)
	}
}

func TestAPIPostUpdate_RemoveImageAndUploadRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	createRec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Image post",
			"body":  "post body",
		},
		[]int64{1},
		"initial.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdPost := decodeEnvelopeDataMap(t, createRec)
	postID := int64(createdPost["id"].(float64))
	oldImageURL := createdPost["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, oldImageURL) })

	rec := multipartRequest(
		t,
		h,
		http.MethodPatch,
		fmt.Sprintf("/api/v1/posts/%d", postID),
		token,
		map[string]string{
			"remove_image": "true",
		},
		nil,
		"replacement.png",
		samplePNGBytes,
	)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got %s", rec.Body.String())
	}
	if apiErr.Message != "remove_image cannot be combined with image upload" {
		t.Fatalf("unexpected error message: %q", apiErr.Message)
	}

	post := getPost(t, h, token, postID)
	if got := post["image_url"]; got != oldImageURL {
		t.Fatalf("expected original image_url to remain %q, got %v", oldImageURL, got)
	}
}

func TestAPIPostUpdate_RemoveImageAndImageURLRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	createRec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts",
		token,
		map[string]string{
			"title": "Image post",
			"body":  "post body",
		},
		[]int64{1},
		"initial.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdPost := decodeEnvelopeDataMap(t, createRec)
	postID := int64(createdPost["id"].(float64))
	oldImageURL := createdPost["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, oldImageURL) })

	rec := patchPost(t, h, token, postID, map[string]any{
		"remove_image": true,
		"image_url":    "/static/uploads/another.jpg",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got %s", rec.Body.String())
	}
	if apiErr.Message != "remove_image cannot be combined with image_url" {
		t.Fatalf("unexpected error message: %q", apiErr.Message)
	}

	post := getPost(t, h, token, postID)
	if got := post["image_url"]; got != oldImageURL {
		t.Fatalf("expected original image_url to remain %q, got %v", oldImageURL, got)
	}
}

func extractCategoryIDsFromPost(t *testing.T, post map[string]any) []int64 {
	t.Helper()

	raw, ok := post["categories"]
	if !ok {
		return nil
	}
	list, ok := raw.([]any)
	if !ok {
		t.Fatalf("expected categories array, got %T", raw)
	}

	ids := make([]int64, 0, len(list))
	for _, item := range list {
		category, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("expected category object, got %T", item)
		}
		idRaw, ok := category["id"]
		if !ok {
			t.Fatalf("missing category id in %v", category)
		}
		ids = append(ids, int64(idRaw.(float64)))
	}

	return ids
}
