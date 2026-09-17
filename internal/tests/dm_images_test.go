// internal/tests/dm_images_test.go
//
// C09 — DM image upload backend. Covers the upload endpoint
// (POST /api/v1/chats/{userID}/images), the optional image_url on dm.send,
// the image_url echoed on dm.message, and image_url surfacing in the history
// API.
package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

/*-----------------------
  HELPERS
------------------------*/

// uploadDMImageReq POSTs a multipart image to /api/v1/chats/{recipientID}/images.
func uploadDMImageReq(t *testing.T, h http.Handler, token string, recipientID int64, filename string, fileBytes []byte) *httptest.ResponseRecorder {
	t.Helper()
	payload, contentType := buildCommentMultipartBody(t, nil, filename, fileBytes)
	path := fmt.Sprintf("/api/v1/chats/%d/images", recipientID)
	return multipartRequestWithBody(t, h, http.MethodPost, path, token, contentType, payload)
}

// dmUploadDiskPath resolves the on-disk path of an uploaded DM image from its
// public URL, trying both candidate roots (test cwd is the package dir, but the
// handler writes relative to wherever the process runs). Returns ("", false)
// when the file is not present at either location.
func dmUploadDiskPath(imageURL string) (string, bool) {
	rel := strings.TrimPrefix(imageURL, "/")
	for _, p := range []string{filepath.Join("web", rel), filepath.Join("..", "..", "web", rel)} {
		if _, err := os.Stat(p); err == nil {
			return p, true
		}
	}
	return "", false
}

// sendDMSendWithImage writes a dm.send frame carrying an image_url.
func sendDMSendWithImage(t *testing.T, conn *websocket.Conn, recipientID int64, body, imageURL string) {
	t.Helper()
	msg := map[string]any{
		"type": "dm.send",
		"payload": map[string]any{
			"recipient_id": recipientID,
			"body":         body,
			"image_url":    imageURL,
		},
	}
	if err := conn.WriteJSON(msg); err != nil {
		t.Fatalf("sendDMSendWithImage: write: %v", err)
	}
}

/*-----------------------
  UPLOAD ENDPOINT
------------------------*/

func TestDMImageUpload_SavesFileAndReturnsURL(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "imgsender")
	tokenBob := registerAndLoginAs(t, h, "imgrecipient")
	bobID := getUserID(t, h, tokenBob)

	cases := []struct {
		name     string
		filename string
		bytes    []byte
		wantExt  string
	}{
		{"jpeg", "pic.jpg", sampleJPEGBytes, ".jpg"},
		{"png", "pic.png", samplePNGBytes, ".png"},
		{"gif", "pic.gif", sampleGIFBytes, ".gif"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := uploadDMImageReq(t, h, token, bobID, tc.filename, tc.bytes)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d, body=%s", rec.Code, rec.Body.String())
			}
			data := decodeEnvelopeDataMap(t, rec)
			url, _ := data["image_url"].(string)
			if !strings.HasPrefix(url, "/static/uploads/dm/") {
				t.Fatalf("image_url not under dm dir: %q", url)
			}
			if !strings.HasSuffix(url, tc.wantExt) {
				t.Errorf("image_url ext: got %q want suffix %q", url, tc.wantExt)
			}
			diskPath, ok := dmUploadDiskPath(url)
			if !ok {
				t.Fatalf("uploaded file not found on disk for url %q", url)
			}
			t.Cleanup(func() { _ = os.Remove(diskPath) })
		})
	}
}

func TestDMImageUpload_RejectsNonImage(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "badimgsender")
	tokenBob := registerAndLoginAs(t, h, "badimgrecipient")
	bobID := getUserID(t, h, tokenBob)

	rec := uploadDMImageReq(t, h, token, bobID, "notimage.txt", sampleTextBytes)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-image, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDMImageUpload_RejectsMissingFile(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "nofilesender")
	tokenBob := registerAndLoginAs(t, h, "nofilerecipient")
	bobID := getUserID(t, h, tokenBob)

	// No file bytes → no "image" part in the multipart body.
	rec := uploadDMImageReq(t, h, token, bobID, "", nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing file, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDMImageUpload_RejectsOversizedFile(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "bigimgsender")
	tokenBob := registerAndLoginAs(t, h, "bigimgrecipient")
	bobID := getUserID(t, h, tokenBob)

	oversized := jpegBytesOfSize(t, maxUploadBytes+1)
	rec := uploadDMImageReq(t, h, token, bobID, "huge.jpg", oversized)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized upload, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDMImageUpload_RejectsBadRecipientID(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "badidsender")

	payload, contentType := buildCommentMultipartBody(t, nil, "pic.jpg", sampleJPEGBytes)
	rec := multipartRequestWithBody(t, h, http.MethodPost, "/api/v1/chats/abc/images", token, contentType, payload)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-numeric recipient id, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestDMImageUpload_RejectsWrongMethod(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "wrongmethodsender")
	tokenBob := registerAndLoginAs(t, h, "wrongmethodrecipient")
	bobID := getUserID(t, h, tokenBob)

	// GET on the images subroute is not allowed.
	path := fmt.Sprintf("/api/v1/chats/%d/images", bobID)
	rec, _ := doRequestWithToken(t, h, http.MethodGet, path, token, nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET on images route, got %d", rec.Code)
	}
}

func TestDMImageUpload_RequiresAuth(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	payload, contentType := buildCommentMultipartBody(t, nil, "pic.jpg", sampleJPEGBytes)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chats/1/images", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without session, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestChatSubroute_UnknownSuffixRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token := registerAndLoginAs(t, h, "subroutesender")
	tokenBob := registerAndLoginAs(t, h, "subrouterecipient")
	bobID := getUserID(t, h, tokenBob)

	// Neither /messages nor /images → BAD_REQUEST from the dispatcher.
	path := fmt.Sprintf("/api/v1/chats/%d/bogus", bobID)
	rec, _ := doRequestWithToken(t, h, http.MethodGet, path, token, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown chat subroute, got %d", rec.Code)
	}
}

/*-----------------------
  dm.send WITH IMAGE
------------------------*/

func TestDMSend_WithImageDeliveredAndPersisted(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "imgdmalice")
	aliceID := getUserID(t, h, tokenAlice)
	tokenBob := registerAndLoginAs(t, h, "imgdmbob")
	bobID := getUserID(t, h, tokenBob)

	// Upload an image first to obtain a server-issued URL.
	rec := uploadDMImageReq(t, h, tokenAlice, bobID, "pic.png", samplePNGBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload failed: %d body=%s", rec.Code, rec.Body.String())
	}
	imageURL, _ := decodeEnvelopeDataMap(t, rec)["image_url"].(string)
	if imageURL == "" {
		t.Fatal("empty image_url from upload")
	}
	if diskPath, ok := dmUploadDiskPath(imageURL); ok {
		t.Cleanup(func() { _ = os.Remove(diskPath) })
	}

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	sendDMSendWithImage(t, connAlice, bobID, "look at this", imageURL)

	for _, c := range []*websocket.Conn{connAlice, connBob} {
		msg, ok := drainUntilType(c, "dm.message", 2*time.Second)
		if !ok {
			t.Fatal("did not receive dm.message")
		}
		var payload struct {
			Body     string `json:"body"`
			ImageURL string `json:"image_url"`
		}
		if err := json.Unmarshal(msg["payload"], &payload); err != nil {
			t.Fatalf("unmarshal dm.message payload: %v", err)
		}
		if payload.ImageURL != imageURL {
			t.Errorf("dm.message image_url: got %q want %q", payload.ImageURL, imageURL)
		}
	}

	// History API must surface the image_url for the persisted message.
	msgs := getChatMessages(t, h, tokenBob, aliceID, 0)
	if len(msgs) == 0 {
		t.Fatal("expected persisted message in history")
	}
	found := false
	for _, m := range msgs {
		if m["image_url"] == imageURL {
			found = true
		}
	}
	if !found {
		t.Errorf("history did not surface image_url %q, got: %v", imageURL, msgs)
	}
}

func TestDMSend_InvalidImageURLRejected(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "badurlalice")
	aliceID := getUserID(t, h, tokenAlice)
	tokenBob := registerAndLoginAs(t, h, "badurlbob")
	bobID := getUserID(t, h, tokenBob)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	// A traversal-style path outside the DM upload dir must be rejected.
	sendDMSendWithImage(t, connAlice, bobID, "sneaky", "/static/uploads/dm/../../../etc/passwd")

	errMsg, ok := drainUntilType(connAlice, "chat.error", 2*time.Second)
	if !ok {
		t.Fatal("expected chat.error for invalid image_url")
	}
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(errMsg["payload"], &payload); err != nil {
		t.Fatalf("unmarshal chat.error: %v", err)
	}
	if payload.Code != "INVALID_IMAGE" {
		t.Errorf("expected INVALID_IMAGE, got %q", payload.Code)
	}

	// Nothing must have been persisted.
	if msgs := getChatMessages(t, h, tokenBob, aliceID, 0); len(msgs) != 0 {
		t.Errorf("expected no persisted message after rejection, got %d", len(msgs))
	}
}

func TestDMSend_ImageOnlyAccepted(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()
	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "imgonlyalice")
	aliceID := getUserID(t, h, tokenAlice)
	tokenBob := registerAndLoginAs(t, h, "imgonlybob")
	bobID := getUserID(t, h, tokenBob)

	rec := uploadDMImageReq(t, h, tokenAlice, bobID, "pic.gif", sampleGIFBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload failed: %d", rec.Code)
	}
	imageURL, _ := decodeEnvelopeDataMap(t, rec)["image_url"].(string)
	if diskPath, ok := dmUploadDiskPath(imageURL); ok {
		t.Cleanup(func() { _ = os.Remove(diskPath) })
	}

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice ws failed")
	}
	defer connAlice.Close()
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob ws failed")
	}
	defer connBob.Close()

	drainUntilType(connAlice, "presence.update", time.Second)
	drainUntilType(connBob, "presence.update", time.Second)

	// Image attached with an empty body — image-only DMs are allowed and must
	// be echoed to both parties and persisted.
	sendDMSendWithImage(t, connAlice, bobID, "", imageURL)

	for _, c := range []*websocket.Conn{connAlice, connBob} {
		msg, ok := drainUntilType(c, "dm.message", 2*time.Second)
		if !ok {
			t.Fatal("did not receive dm.message for image-only send")
		}
		var payload struct {
			Body     string `json:"body"`
			ImageURL string `json:"image_url"`
		}
		if err := json.Unmarshal(msg["payload"], &payload); err != nil {
			t.Fatalf("unmarshal dm.message payload: %v", err)
		}
		if payload.Body != "" {
			t.Errorf("dm.message body: got %q want empty", payload.Body)
		}
		if payload.ImageURL != imageURL {
			t.Errorf("dm.message image_url: got %q want %q", payload.ImageURL, imageURL)
		}
	}

	// The image-only message must be persisted and surfaced by the history API.
	msgs := getChatMessages(t, h, tokenBob, aliceID, 0)
	found := false
	for _, m := range msgs {
		if m["image_url"] == imageURL {
			found = true
		}
	}
	if !found {
		t.Errorf("history did not surface image-only message %q, got: %v", imageURL, msgs)
	}
}
