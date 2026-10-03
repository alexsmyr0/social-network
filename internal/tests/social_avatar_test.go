package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"forum/internal/db"
)

func avatarImage(t *testing.T, format string) []byte {
	t.Helper()
	var output bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var err error
	switch format {
	case "jpeg":
		err = jpeg.Encode(&output, img, nil)
	case "png":
		err = png.Encode(&output, img)
	case "gif":
		err = gif.Encode(&output, img, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func avatarForm(t *testing.T, email, filename, declared string, data []byte) (string, []byte) {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	fields := map[string]string{"email": email, "password": socialPassword,
		"first_name": "Avatar", "last_name": "Owner", "date_of_birth": "2000-01-01"}
	for name, value := range fields {
		if err := form.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if data != nil {
		header := make(map[string][]string)
		header["Content-Disposition"] = []string{`form-data; name="avatar"; filename="` + filename + `"`}
		header["Content-Type"] = []string{declared}
		part, err := form.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	return form.FormDataContentType(), body.Bytes()
}

func TestSocialAvatarRoundTripAndAccess(t *testing.T) {
	handler, conn := socialAPI(t)
	for _, format := range []string{"jpeg", "png", "gif"} {
		t.Run(format, func(t *testing.T) {
			data := avatarImage(t, format)
			ext := format
			if ext == "jpeg" {
				ext = "jpg"
			}
			contentType, body := avatarForm(t, format+"@example.com", "image."+ext, "image/"+format, data)
			created := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "")
			if created.Code != 201 {
				t.Fatalf("register: %d %s", created.Code, created.Body.String())
			}
			var response struct {
				Data struct {
					AvatarURL string `json:"avatar_url"`
				} `json:"data"`
			}
			if err := json.Unmarshal(created.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.AvatarURL == "" {
				t.Fatal("missing avatar URL")
			}
			token := created.Result().Cookies()[0].Value
			owner := socialRequest(t, handler, http.MethodGet, response.Data.AvatarURL, "", nil, token)
			if owner.Code != 200 || !bytes.Equal(owner.Body.Bytes(), data) || owner.Header().Get("Content-Type") != "image/"+format || owner.Header().Get("X-Content-Type-Options") != "nosniff" || owner.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("owner avatar: %d headers=%v", owner.Code, owner.Header())
			}
			unauth := socialRequest(t, handler, http.MethodGet, response.Data.AvatarURL, "", nil, "")
			if unauth.Code != 401 {
				t.Fatalf("unauth avatar: %d", unauth.Code)
			}
			other := registerSocialUser(t, handler, "other-"+format+"@example.com")

			public := socialRequest(t, handler, http.MethodGet, response.Data.AvatarURL, "", nil, other)
			if public.Code != 200 || !bytes.Equal(public.Body.Bytes(), data) {
				t.Fatalf("public avatar: %d", public.Code)
			}
			changed := socialRequest(t, handler, http.MethodPatch, "/api/v1/users/me/privacy", "application/json", []byte(`{"visibility":"private","expected_version":1}`), token)
			assertSocialCode(t, changed, 200, "")
			denied := socialRequest(t, handler, http.MethodGet, response.Data.AvatarURL, "", nil, other)
			if denied.Code != 404 || bytes.Contains(denied.Body.Bytes(), data) {
				t.Fatalf("other avatar: %d", denied.Code)
			}
			me := socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, token)
			if me.Code != 200 || !strings.Contains(me.Body.String(), response.Data.AvatarURL) {
				t.Fatalf("me: %d %s", me.Code, me.Body.String())
			}
		})
	}
	missingToken := registerSocialUser(t, handler, "no-avatar@example.com")
	var missingID int64
	if err := conn.QueryRow(`SELECT id FROM users WHERE email = ?`, "no-avatar@example.com").Scan(&missingID); err != nil {
		t.Fatal(err)
	}
	missing := socialRequest(t, handler, http.MethodGet, "/api/v1/users/"+strconv.FormatInt(missingID, 10)+"/avatar", "", nil, missingToken)
	if missing.Code != 404 {
		t.Fatalf("missing avatar: %d", missing.Code)
	}
}

func TestSocialAvatarValidationAndCleanup(t *testing.T) {
	handler, conn := socialAPI(t)
	valid := avatarImage(t, "png")
	large := image.NewRGBA(image.Rect(0, 0, 4097, 1))
	var largePNG bytes.Buffer
	if err := png.Encode(&largePNG, large); err != nil {
		t.Fatal(err)
	}
	frames := make([]*image.Paletted, 101)
	for i := range frames {
		frames[i] = image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White})
	}
	var longGIF bytes.Buffer
	if err := gif.EncodeAll(&longGIF, &gif.GIF{Image: frames, Delay: make([]int, len(frames))}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, filename, declared, code string
		data                           []byte
		status                         int
	}{
		{"empty", "a.png", "image/png", "INVALID_AVATAR", []byte{}, 422},
		{"corrupt", "a.png", "image/png", "INVALID_AVATAR", []byte("not an image"), 422},
		{"truncated", "a.png", "image/png", "INVALID_AVATAR", valid[:len(valid)/2], 422},
		{"mime mismatch", "a.png", "image/jpeg", "INVALID_AVATAR", valid, 422},
		{"extension mismatch", "a.jpg", "image/png", "INVALID_AVATAR", valid, 422},
		{"dimensions", "wide.png", "image/png", "INVALID_AVATAR", largePNG.Bytes(), 422},
		{"gif frames", "long.gif", "image/gif", "INVALID_AVATAR", longGIF.Bytes(), 422},
		{"too large", "a.png", "image/png", "PAYLOAD_TOO_LARGE", bytes.Repeat([]byte("a"), (5<<20)+1), 413},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			contentType, body := avatarForm(t, "invalid"+string(rune('a'+i))+"@example.com", tc.filename, tc.declared, tc.data)
			result := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "")
			if result.Code != tc.status || !strings.Contains(result.Body.String(), tc.code) {
				t.Fatalf("result: %d %s", result.Code, result.Body.String())
			}
		})
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid accounts: %d %v", count, err)
	}
	root, _ := db.AvatarRoot(conn)
	files, _ := os.ReadDir(filepath.Join(root, "objects"))
	if len(files) != 0 {
		t.Fatalf("orphan files: %d", len(files))
	}

	// Force a session write failure after the avatar file and user insert.
	if _, err := conn.Exec(`CREATE TRIGGER reject_new_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	contentType, body := avatarForm(t, "failure@example.com", "a.png", "image/png", valid)
	failed := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "")
	if failed.Code != 500 {
		t.Fatalf("session failure: %d %s", failed.Code, failed.Body.String())
	}
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial account: %d %v", count, err)
	}
	files, _ = os.ReadDir(filepath.Join(root, "objects"))
	if len(files) != 0 {
		t.Fatalf("failed session leaked avatar: %d", len(files))
	}
}

func TestSocialAvatarRejectsForeignAttachmentFields(t *testing.T) {
	handler, conn := socialAPI(t)
	registerSocialUser(t, handler, "owner@example.com")
	for _, field := range []string{"avatar_key", "avatar_id", "user_id"} {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		for name, value := range map[string]string{
			"email": field + "@example.com", "password": socialPassword,
			"first_name": "Forge", "last_name": "Attempt", "date_of_birth": "2000-01-01",
			field: "1",
		} {
			if err := form.WriteField(name, value); err != nil {
				t.Fatal(err)
			}
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		response := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", form.FormDataContentType(), body.Bytes(), "")
		if response.Code != 400 || !strings.Contains(response.Body.String(), "BAD_REQUEST") {
			t.Fatalf("%s: %d %s", field, response.Code, response.Body.String())
		}
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("forged accounts: %d %v", count, err)
	}
}

func TestSocialAvatarDuplicateAndStartupRecovery(t *testing.T) {
	handler, conn := socialAPI(t)
	data := avatarImage(t, "png")
	contentType, body := avatarForm(t, "duplicate@example.com", "a.png", "image/png", data)
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "").Code
		}()
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for status := range results {
		counts[status]++
	}
	if counts[201] != 1 || counts[409] != 1 {
		t.Fatalf("duplicate outcomes: %v", counts)
	}
	root, _ := db.AvatarRoot(conn)
	files, _ := os.ReadDir(filepath.Join(root, "objects"))
	if len(files) != 1 {
		t.Fatalf("duplicate files: %d", len(files))
	}
	if err := os.WriteFile(filepath.Join(root, "objects", "orphan.png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".tmp-crash"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := db.PrepareAvatarStorage(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	files, _ = os.ReadDir(filepath.Join(root, "objects"))
	if len(files) != 1 {
		t.Fatalf("recovery files: %d", len(files))
	}
	if _, err := os.Stat(filepath.Join(root, ".tmp-crash")); !os.IsNotExist(err) {
		t.Fatalf("temporary file remained: %v", err)
	}
}
