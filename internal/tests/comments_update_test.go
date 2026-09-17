package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func patchCommentJSON(
	t *testing.T,
	h http.Handler,
	token string,
	commentID int64,
	payload map[string]any,
) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal comment patch payload: %v", err)
	}

	req := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/v1/comments/%d", commentID), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func getCommentByID(t *testing.T, h http.Handler, token string, commentID int64) map[string]any {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/comments/%d", commentID), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 when fetching comment, got %d body=%s", rec.Code, rec.Body.String())
	}

	return decodeEnvelopeDataMap(t, rec)
}

func TestAPICommentUpdate_MultipartReplaceImage(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for comment patch",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	createRec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{"body": "initial comment body"},
		"initial-comment.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdComment := decodeEnvelopeDataMap(t, createRec)
	commentID := int64(createdComment["id"].(float64))
	oldImageURL := createdComment["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, oldImageURL) })

	payload, contentType := buildCommentMultipartBody(
		t,
		map[string]string{"body": "updated comment body"},
		"updated-comment.png",
		samplePNGBytes,
	)
	patchRec := multipartRequestWithBody(
		t,
		h,
		http.MethodPatch,
		fmt.Sprintf("/api/v1/comments/%d", commentID),
		token,
		contentType,
		payload,
	)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", patchRec.Code, patchRec.Body.String())
	}

	updatedComment := decodeEnvelopeDataMap(t, patchRec)
	if got := updatedComment["body"]; got != "updated comment body" {
		t.Fatalf("expected updated body, got %v", got)
	}

	newImageURL, ok := updatedComment["image_url"].(string)
	if !ok || newImageURL == "" {
		t.Fatalf("expected non-empty image_url after patch, got %v", updatedComment["image_url"])
	}
	if newImageURL == oldImageURL {
		t.Fatalf("expected replaced image_url, old=%q new=%q", oldImageURL, newImageURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, newImageURL) })

	fetched := getCommentByID(t, h, token, commentID)
	if got := fetched["image_url"]; got != newImageURL {
		t.Fatalf("expected fetched image_url %q, got %v", newImageURL, got)
	}
}

func TestAPICommentUpdate_RemoveImage(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for remove image",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	createRec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{"body": "keep text"},
		"remove-image-comment.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdComment := decodeEnvelopeDataMap(t, createRec)
	commentID := int64(createdComment["id"].(float64))
	if imageURL, _ := createdComment["image_url"].(string); imageURL != "" {
		t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
	}

	patchRec := patchCommentJSON(t, h, token, commentID, map[string]any{
		"body":         "text only now",
		"remove_image": true,
	})
	if patchRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", patchRec.Code, patchRec.Body.String())
	}

	updatedComment := decodeEnvelopeDataMap(t, patchRec)
	if got := updatedComment["body"]; got != "text only now" {
		t.Fatalf("expected updated body, got %v", got)
	}
	if got := updatedComment["image_url"]; got != nil {
		t.Fatalf("expected nil image_url after remove_image patch, got %v", got)
	}

	fetched := getCommentByID(t, h, token, commentID)
	if got := fetched["image_url"]; got != nil {
		t.Fatalf("expected nil image_url in fetched comment after remove, got %v", got)
	}
}

func TestAPICommentUpdate_RemoveImageFromImageOnlyCommentRequiresBody(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for invalid remove image",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	createRec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{},
		"image-only-comment.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdComment := decodeEnvelopeDataMap(t, createRec)
	commentID := int64(createdComment["id"].(float64))
	imageURL, _ := createdComment["image_url"].(string)
	if imageURL != "" {
		t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
	}

	patchRec := patchCommentJSON(t, h, token, commentID, map[string]any{
		"remove_image": true,
	})
	if patchRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", patchRec.Code, patchRec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, patchRec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got %s", patchRec.Body.String())
	}
	if apiErr.Message != "body required" {
		t.Fatalf("expected body required message, got %q", apiErr.Message)
	}

	fetched := getCommentByID(t, h, token, commentID)
	if got := fetched["image_url"]; got == nil {
		t.Fatalf("expected image_url to remain after failed patch, got nil")
	}
}

func TestAPICommentUpdate_RemoveImageAndUploadRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for conflicting image flags",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	createRec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{"body": "initial comment body"},
		"initial-comment.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdComment := decodeEnvelopeDataMap(t, createRec)
	commentID := int64(createdComment["id"].(float64))
	oldImageURL := createdComment["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, oldImageURL) })

	payload, contentType := buildCommentMultipartBody(
		t,
		map[string]string{
			"remove_image": "true",
		},
		"replacement-comment.png",
		samplePNGBytes,
	)
	patchRec := multipartRequestWithBody(
		t,
		h,
		http.MethodPatch,
		fmt.Sprintf("/api/v1/comments/%d", commentID),
		token,
		contentType,
		payload,
	)
	if patchRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", patchRec.Code, patchRec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, patchRec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got %s", patchRec.Body.String())
	}
	if apiErr.Message != "remove_image cannot be combined with image upload" {
		t.Fatalf("unexpected error message: %q", apiErr.Message)
	}

	fetched := getCommentByID(t, h, token, commentID)
	if got := fetched["image_url"]; got != oldImageURL {
		t.Fatalf("expected original image_url to remain %q, got %v", oldImageURL, got)
	}
}

func TestAPICommentUpdate_RemoveImageAndImageURLRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")
	postID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Post for conflicting image flags",
		"body":         "seed body",
		"category_ids": []int64{1},
	})

	createRec := multipartCommentRequest(
		t,
		h,
		token,
		postID,
		map[string]string{"body": "initial comment body"},
		"initial-comment.jpg",
		sampleJPEGBytes,
	)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%s", createRec.Code, createRec.Body.String())
	}

	createdComment := decodeEnvelopeDataMap(t, createRec)
	commentID := int64(createdComment["id"].(float64))
	oldImageURL := createdComment["image_url"].(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, oldImageURL) })

	patchRec := patchCommentJSON(t, h, token, commentID, map[string]any{
		"remove_image": true,
		"image_url":    "/static/uploads/another-comment.jpg",
	})
	if patchRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", patchRec.Code, patchRec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, patchRec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got %s", patchRec.Body.String())
	}
	if apiErr.Message != "remove_image cannot be combined with image_url" {
		t.Fatalf("unexpected error message: %q", apiErr.Message)
	}

	fetched := getCommentByID(t, h, token, commentID)
	if got := fetched["image_url"]; got != oldImageURL {
		t.Fatalf("expected original image_url to remain %q, got %v", oldImageURL, got)
	}
}
