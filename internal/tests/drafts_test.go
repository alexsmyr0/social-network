package tests

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAPIDraftCreate_ManualImageOnlyMultipartAndRestore(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts/draft",
		token,
		map[string]string{
			"title":  "Draft with image only",
			"body":   "",
			"manual": "true",
		},
		[]int64{1},
		"draft.jpg",
		sampleJPEGBytes,
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	draftCreate := decodeEnvelopeDataMap(t, rec)
	draftID := int64(draftCreate["id"].(float64))

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/posts/draft", nil)
	getReq.Header.Set("Cookie", "session_token="+token)
	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on draft get, got %d body=%s", getRec.Code, getRec.Body.String())
	}

	draft := decodeEnvelopeDataMap(t, getRec)
	if int64(draft["id"].(float64)) != draftID {
		t.Fatalf("expected draft id %d, got %v", draftID, draft["id"])
	}
	if draft["title"] != "Draft with image only" {
		t.Fatalf("expected restored title, got %v", draft["title"])
	}
	if draft["body"] != "" {
		t.Fatalf("expected empty body for image-only draft, got %v", draft["body"])
	}
	rawURL, ok := draft["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url on restored draft, got %v", draft)
	}
	imageURL := rawURL.(string)
	if strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url on restored draft")
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
}

func TestAPIDraftUpdate_ManualImageOnlyMultipart(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	// create a starting draft via JSON
	createReq := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/posts/draft",
		strings.NewReader(`{"title":"Initial Draft","body":"Initial body","category_ids":[1],"manual":true}`),
	)
	createReq.Header.Set("Content-Type", "application/json")
	createReq.Header.Set("Cookie", "session_token="+token)
	createRec := httptest.NewRecorder()
	h.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on initial draft create, got %d body=%s", createRec.Code, createRec.Body.String())
	}
	createData := decodeEnvelopeDataMap(t, createRec)
	draftID := int64(createData["id"].(float64))

	updateRec := multipartRequest(
		t,
		h,
		http.MethodPut,
		fmt.Sprintf("/api/v1/posts/draft/%d", draftID),
		token,
		map[string]string{
			"title":  "Updated Draft",
			"body":   "",
			"manual": "true",
		},
		[]int64{1},
		"updated.png",
		samplePNGBytes,
	)
	if updateRec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d body=%s", updateRec.Code, updateRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/posts/draft", nil)
	getReq.Header.Set("Cookie", "session_token="+token)
	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on draft get, got %d body=%s", getRec.Code, getRec.Body.String())
	}
	draft := decodeEnvelopeDataMap(t, getRec)

	if int64(draft["id"].(float64)) != draftID {
		t.Fatalf("expected updated draft id %d, got %v", draftID, draft["id"])
	}
	if draft["title"] != "Updated Draft" {
		t.Fatalf("expected updated title, got %v", draft["title"])
	}
	if draft["body"] != "" {
		t.Fatalf("expected empty body after image-only update, got %v", draft["body"])
	}
	rawURL, ok := draft["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url after draft image update, got %v", draft)
	}
	imageURL := rawURL.(string)
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
}

func TestAPIDraftCreate_RejectsUnsupportedImageType(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts/draft",
		token,
		map[string]string{
			"title":  "Bad draft image",
			"body":   "Has text",
			"manual": "true",
		},
		[]int64{1},
		"bad.gif",
		sampleTextBytes,
	)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	apiErr := decodeErrorEnvelope(t, rec)
	if apiErr == nil {
		t.Fatalf("expected error envelope, got body=%s", rec.Body.String())
	}
	if !strings.HasPrefix(apiErr.Message, "unsupported image type") {
		t.Fatalf("expected unsupported image type prefix, got %q", apiErr.Message)
	}
}

func TestAPIDraftCreate_AllowsExtensionMimeMismatchWhenDetectedTypeSupported(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	rec := multipartRequest(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts/draft",
		token,
		map[string]string{
			"title":  "Mismatch draft image",
			"body":   "Body",
			"manual": "true",
		},
		[]int64{1},
		"draft.jpg",
		sampleGIFBytes,
	)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/posts/draft", nil)
	getReq.Header.Set("Cookie", "session_token="+token)
	getRec := httptest.NewRecorder()
	h.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected 200 on draft get, got %d body=%s", getRec.Code, getRec.Body.String())
	}

	draft := decodeEnvelopeDataMap(t, getRec)
	rawURL, ok := draft["image_url"]
	if !ok || rawURL == nil {
		t.Fatalf("expected image_url in draft response, got draft=%v", draft)
	}
	imageURL, ok := rawURL.(string)
	if !ok || strings.TrimSpace(imageURL) == "" {
		t.Fatalf("expected non-empty image_url string, got %T(%v)", rawURL, rawURL)
	}
	t.Cleanup(func() { cleanupUploadedFromImageURL(t, imageURL) })
	if !strings.HasSuffix(strings.ToLower(imageURL), ".gif") {
		t.Fatalf("expected uploaded image extension to match detected GIF type, got %q", imageURL)
	}
}

func TestAPIDraftByID_InvalidID_BadRequest(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	paths := []string{
		"/api/v1/posts/draft/abc",
		"/api/v1/posts/draft/0",
		"/api/v1/posts/draft/-1",
		"/api/v1/posts/draft/",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPut,
				path,
				strings.NewReader(`{"title":"Draft","body":"Body","category_ids":[1],"manual":true}`),
			)
			req.Header.Set("Content-Type", "application/json")
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
