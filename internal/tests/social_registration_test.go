package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"forum/internal/db"
	"forum/internal/router"
	"forum/internal/ws"
)

func socialAPI(t *testing.T) (http.Handler, *sql.DB) {
	handler, conn, _ := socialAPIWithHub(t)
	return handler, conn
}

func socialAPIWithHub(t *testing.T) (http.Handler, *sql.DB, *ws.Hub) {
	t.Helper()
	conn, err := db.InitDB(context.Background(), filepath.Join(t.TempDir(), "social.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	hub := ws.NewHub()
	return router.NewRouter(conn, hub), conn, hub
}

func socialRequest(t *testing.T, handler http.Handler, method, path, contentType string, body []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete {
		req.Header.Set("Origin", "http://localhost:3000")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestSocialRegistrationAndAccountRead(t *testing.T) {
	handler, conn := socialAPI(t)
	base := `{"email":" Alex@Example.com ","password":"correct horse battery","first_name":" Alex ","last_name":" Example ","date_of_birth":"2000-02-29"}`
	registered := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(base), "")
	if registered.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", registered.Code, registered.Body.String())
	}
	var response struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(registered.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data["email"] != "alex@example.com" || response.Data["display_name"] != "Alex Example" || response.Data["date_of_birth"] != "2000-02-29" || response.Data["nickname"] != nil || response.Data["avatar_url"] != nil {
		t.Fatalf("wrong account response: %v", response.Data)
	}
	for _, secret := range []string{"password", "password_hash", "username", "age", "gender"} {
		if _, found := response.Data[secret]; found {
			t.Fatalf("account disclosed %s", secret)
		}
	}
	token := registered.Result().Cookies()[0].Value
	alreadySignedIn := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(`{}`), token)
	if alreadySignedIn.Code != http.StatusConflict || !bytes.Contains(alreadySignedIn.Body.Bytes(), []byte(`"ALREADY_AUTHENTICATED"`)) {
		t.Fatalf("existing session: %d %s", alreadySignedIn.Code, alreadySignedIn.Body.String())
	}
	me := socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, token)
	if me.Code != http.StatusOK || !bytes.Contains(me.Body.Bytes(), []byte(`"email":"alex@example.com"`)) {
		t.Fatalf("me: %d %s", me.Code, me.Body.String())
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("user count: %d %v", count, err)
	}

	optional := `{"email":"second@example.com","password":"password123","first_name":"Second","last_name":"Person","date_of_birth":"2001-01-01","nickname":" Alex E ","about_me":" Hiking "}`
	second := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(optional), "")
	if second.Code != http.StatusCreated || !bytes.Contains(second.Body.Bytes(), []byte(`"display_name":"Alex E"`)) || !bytes.Contains(second.Body.Bytes(), []byte(`"about_me":"Hiking"`)) {
		t.Fatalf("optional: %d %s", second.Code, second.Body.String())
	}
	secondMe := socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second.Result().Cookies()[0].Value)
	if secondMe.Code != http.StatusOK || !bytes.Contains(secondMe.Body.Bytes(), []byte(`"nickname":"Alex E"`)) || !bytes.Contains(secondMe.Body.Bytes(), []byte(`"about_me":"Hiking"`)) {
		t.Fatalf("optional fields did not round-trip: %d %s", secondMe.Code, secondMe.Body.String())
	}
	third := strings.Replace(optional, "second@example.com", "third@example.com", 1)
	thirdResult := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(third), "")
	if thirdResult.Code != http.StatusCreated {
		t.Fatalf("duplicate nickname rejected: %d %s", thirdResult.Code, thirdResult.Body.String())
	}
	duplicate := strings.Replace(base, "Alex@Example.com", "ALEX@example.com", 1)
	dupeResult := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(duplicate), "")
	if dupeResult.Code != http.StatusConflict || !bytes.Contains(dupeResult.Body.Bytes(), []byte(`"EMAIL_TAKEN"`)) {
		t.Fatalf("duplicate email: %d %s", dupeResult.Code, dupeResult.Body.String())
	}
}

func TestSocialRegistrationRejectsInvalidInputWithoutAccount(t *testing.T) {
	handler, conn := socialAPI(t)
	valid := `{"email":"valid@example.com","password":"password123","first_name":"First","last_name":"Last","date_of_birth":"2000-01-01"}`
	future := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	cases := []struct {
		name, body, code string
		status           int
	}{
		{"missing required", `{}`, "REQUIRED", 400},
		{"invalid email", strings.Replace(valid, "valid@example.com", "a@@b", 1), "INVALID_EMAIL", 400},
		{"short password", strings.Replace(valid, "password123", "short", 1), "INVALID_PASSWORD", 400},
		{"long password", strings.Replace(valid, "password123", strings.Repeat("x", 73), 1), "INVALID_PASSWORD", 400},
		{"impossible date", strings.Replace(valid, "2000-01-01", "2026-02-30", 1), "INVALID_DATE", 400},
		{"future date", strings.Replace(valid, "2000-01-01", future, 1), "INVALID_DATE", 400},
		{"legacy field", strings.Replace(valid, `"date_of_birth"`, `"age":25,"date_of_birth"`, 1), "BAD_REQUEST", 400},
		{"null name", strings.Replace(valid, `"first_name":"First"`, `"first_name":null`, 1), "REQUIRED", 400},
		{"long nickname", strings.Replace(valid, `"date_of_birth"`, fmt.Sprintf(`"nickname":"%s","date_of_birth"`, strings.Repeat("x", 31)), 1), "TOO_LONG", 400},
		{"json avatar", strings.Replace(valid, `"date_of_birth"`, `"avatar":"/tmp/a.png","date_of_birth"`, 1), "BAD_REQUEST", 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(tc.body), "")
			if rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("result: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid input created accounts: %d %v", count, err)
	}
}

func TestSocialMultipartRejectsInvalidAvatar(t *testing.T) {
	handler, conn := socialAPI(t)
	build := func(avatar bool) (string, []byte) {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		for key, value := range map[string]string{
			"email": "form@example.com", "password": "password123",
			"first_name": "Form", "last_name": "Person", "date_of_birth": "2000-01-01",
		} {
			if err := form.WriteField(key, value); err != nil {
				t.Fatal(err)
			}
		}
		if avatar {
			file, err := form.CreateFormFile("avatar", "avatar.png")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = file.Write([]byte("image"))
		}
		_ = form.Close()
		return form.FormDataContentType(), body.Bytes()
	}
	contentType, body := build(true)
	blocked := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "")
	if blocked.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid avatar accepted: %d %s", blocked.Code, blocked.Body.String())
	}
	var count int
	_ = conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	if count != 0 {
		t.Fatalf("avatar rejection created %d accounts", count)
	}
	contentType, body = build(false)
	accepted := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", contentType, body, "")
	if accepted.Code != http.StatusCreated {
		t.Fatalf("multipart without avatar: %d %s", accepted.Code, accepted.Body.String())
	}
}
