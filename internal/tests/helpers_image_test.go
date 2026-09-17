package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var (
	sampleJPEGBytes = []byte{
		0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x02, 0x03,
	}
	samplePNGBytes = []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 'I', 'H', 'D', 'R', 0x00, 0x00,
	}
	sampleGIFBytes = []byte{
		'G', 'I', 'F', '8', '9', 'a', 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
	}
	sampleTextBytes = []byte("not an image")
)

const maxUploadBytes = 20 << 20

func jpegBytesOfSize(t *testing.T, size int) []byte {
	t.Helper()
	if size < len(sampleJPEGBytes) {
		t.Fatalf("requested jpeg size %d is smaller than header %d", size, len(sampleJPEGBytes))
	}
	b := make([]byte, size)
	copy(b, sampleJPEGBytes)
	return b
}

func buildPostMultipartBody(
	t *testing.T,
	fields map[string]string,
	categoryIDs []int64,
	filename string,
	fileBytes []byte,
) (payload []byte, contentType string) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	for k, v := range fields {
		if err := writer.WriteField(k, v); err != nil {
			t.Fatalf("write multipart field %q: %v", k, err)
		}
	}
	for _, cid := range categoryIDs {
		if err := writer.WriteField("category_ids", strconv.FormatInt(cid, 10)); err != nil {
			t.Fatalf("write category_ids field: %v", err)
		}
	}

	if fileBytes != nil {
		fw, err := writer.CreateFormFile("image", filename)
		if err != nil {
			t.Fatalf("create multipart file: %v", err)
		}
		if _, err := fw.Write(fileBytes); err != nil {
			t.Fatalf("write multipart file: %v", err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	return body.Bytes(), writer.FormDataContentType()
}

func buildCommentMultipartBody(
	t *testing.T,
	fields map[string]string,
	filename string,
	fileBytes []byte,
) (payload []byte, contentType string) {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	for k, v := range fields {
		if err := writer.WriteField(k, v); err != nil {
			t.Fatalf("write multipart comment field %q: %v", k, err)
		}
	}

	if fileBytes != nil {
		fw, err := writer.CreateFormFile("image", filename)
		if err != nil {
			t.Fatalf("create multipart comment image: %v", err)
		}
		if _, err := fw.Write(fileBytes); err != nil {
			t.Fatalf("write multipart comment image: %v", err)
		}
	}

	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	return body.Bytes(), writer.FormDataContentType()
}

func multipartRequestWithBody(
	t *testing.T,
	h http.Handler,
	method, path, token, contentType string,
	payload []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func multipartRequest(
	t *testing.T,
	h http.Handler,
	method, path, token string,
	fields map[string]string,
	categoryIDs []int64,
	filename string,
	fileBytes []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	payload, contentType := buildPostMultipartBody(t, fields, categoryIDs, filename, fileBytes)
	return multipartRequestWithBody(t, h, method, path, token, contentType, payload)
}

func multipartCommentRequest(
	t *testing.T,
	h http.Handler,
	token string,
	postID int64,
	fields map[string]string,
	filename string,
	fileBytes []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	payload, contentType := buildCommentMultipartBody(t, fields, filename, fileBytes)
	path := fmt.Sprintf("/api/v1/posts/%d/comments", postID)
	return multipartRequestWithBody(t, h, http.MethodPost, path, token, contentType, payload)
}

func decodeEnvelopeDataMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v body=%s", err, rec.Body.String())
	}
	if env.Error != nil {
		t.Fatalf("unexpected error envelope: %+v body=%s", env.Error, rec.Body.String())
	}

	var data map[string]any
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("unmarshal envelope data map: %v body=%s", err, rec.Body.String())
	}
	return data
}

func decodeErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder) *apiError {
	t.Helper()

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v body=%s", err, rec.Body.String())
	}
	return env.Error
}

func cleanupUploadedFromImageURL(t *testing.T, imageURL string) {
	t.Helper()
	if strings.TrimSpace(imageURL) == "" {
		return
	}
	relURL := strings.TrimPrefix(imageURL, "/")
	paths := []string{
		filepath.Join("web", relURL),
		filepath.Join("..", "..", "web", relURL),
	}
	for _, p := range paths {
		_ = os.Remove(p)
	}
}

func findPostByID(posts []map[string]any, id int64) (map[string]any, bool) {
	for _, p := range posts {
		raw, ok := p["id"]
		if !ok {
			continue
		}
		got := int64(raw.(float64))
		if got == id {
			return p, true
		}
	}
	return nil, false
}
