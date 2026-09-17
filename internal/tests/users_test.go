package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"forum/internal/router"
	"forum/internal/ws"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*----------
  REGISTER
-----------*/

func TestUserRegistration(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	hub := ws.NewHub()
	r := router.NewRouter(db, hub)
	// Test valid registration
	validBody := `{"username":"newuser","email":"new@example.com","password":"password123","first_name":"New","last_name":"User","age":20,"gender":"other"}`
	req := httptest.NewRequest("POST", "/api/v1/users/register", bytes.NewBufferString(validBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", rec.Code)
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	id, ok := resp["data"].(map[string]interface{})["id"]
	if !ok {
		t.Errorf("expected id in response")
	}
	// Login
	loginBody := `{"username":"newuser","password":"password123"}`
	req = httptest.NewRequest("POST", "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d", rec.Code)
	}
	// Extract token
	setCookie := rec.Header().Get("Set-Cookie")
	parts := strings.Split(setCookie, ";")
	token := strings.TrimPrefix(strings.TrimSpace(parts[0]), "session_token=")

	// Test user retrieval
	userID := int64(id.(float64))
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/v1/users/%d", userID), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200 for user get, got %d", rec.Code)
	}
	var userResp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&userResp); err != nil {
		t.Fatalf("failed to decode user response: %v", err)
	}
	data, ok := userResp["data"].(map[string]interface{})
	if !ok || data["username"] != "newuser" {
		t.Errorf("expected user data with username 'newuser'")
	}
	// Test invalid cases
	invalidCases := []struct {
		body string
		desc string
	}{
		{`{"username":"ab","email":"test@example.com","password":"password123"}`, "short username"},
		{`{"username":"newuser2","email":"test@example.com","password":"123"}`, "weak password"},
		{`{"username":"newuser2","email":"invalid","password":"password123"}`, "invalid email"},
		{`{"username":"user@name","email":"user2@example.com","password":"password123"}`, "username contains @"},
		{`{"username":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","email":"longuser@example.com","password":"password123"}`, "username too long"},
		{`{"username":"testuser","email":"dup@example.com","password":"password123"}`, "duplicate username"},
		{`{"username":"otheruser","email":"new@example.com","password":"password123"}`, "duplicate email"},
	}
	for _, tc := range invalidCases {
		req := httptest.NewRequest("POST", "/api/v1/users/register", bytes.NewBufferString(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for %s, got %d", tc.desc, rec.Code)
		}
	}
}

/*----------
   LOGIN
-----------*/

func TestUserLoginByUsername(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()
	hub := ws.NewHub()
	r := router.NewRouter(db, hub)
	// Register a user
	regBody := `{"username":"newuser123","email":"test2@example.com","password":"password123","first_name":"First","last_name":"Last","age":30,"gender":"other"}`
	req := httptest.NewRequest("POST", "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	t.Logf("register response body: %s", rec.Body.String())
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for register, got %d", rec.Code)
	}
	// Login
	loginBody := `{"username":"newuser123","password":"password123"}`
	req = httptest.NewRequest("POST", "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	t.Logf("login response body: %s", rec.Body.String())
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for login, got %d", rec.Code)
	}
	// Check login response has success message
	var loginResp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&loginResp); err != nil {
		t.Fatalf("failed to decode login response: %v", err)
	}
	userData, ok := loginResp["data"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected data in login response")
	}
	message, ok := userData["message"].(string)
	if !ok || message != "Login successful" {
		t.Fatalf("expected 'Login successful' message, got %v", userData)
	}
	// Extract token from Set-Cookie header
	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected Set-Cookie header")
	}
	// Parse cookie: "session_token=uuid; Path=/; HttpOnly; SameSite=StrictMode"
	parts := strings.Split(setCookie, ";")
	tokenPart := strings.TrimSpace(parts[0])
	if !strings.HasPrefix(tokenPart, "session_token=") {
		t.Fatalf("expected session_token in cookie")
	}
	token := strings.TrimPrefix(tokenPart, "session_token=")
	// Call /me with cookie
	req = httptest.NewRequest("GET", "/api/v1/users/me", nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for /me, got %d", rec.Code)
	}
	var meResp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&meResp); err != nil {
		t.Fatalf("failed to decode /me response: %v", err)
	}
	data, ok := meResp["data"].(map[string]interface{})
	if !ok || data["username"] != "newuser123" {
		t.Errorf("expected user data with username 'newuser123'")
	}
}

func TestUserLoginByEmail(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Register
	regBody := `{"username":"emailuser","email":"emailuser@example.com","password":"password123","first_name":"Email","last_name":"User","age":25,"gender":"other"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}

	// Login by email
	loginBody := `{"email":"emailuser@example.com","password":"password123"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login by email failed: %d body=%s", rec.Code, rec.Body.String())
	}

	// Extract session cookie
	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected Set-Cookie on login")
	}
	token := strings.Split(strings.Split(setCookie, ";")[0], "=")[1]

	// Verifies session works
	req = httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected /me to succeed after email login, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserLogin_WrongPassword(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Register
	regBody := `{"username":"wrongpassuser","email":"wrongpass@example.com","password":"password123","first_name":"Wrong","last_name":"Pass","age":22,"gender":"other"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}

	// Login with wrong password
	loginBody := `{"username":"wrongpassuser","password":"wrongpassword"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got %d body=%s", rec.Code, rec.Body.String())
	}

	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("did not expect Set-Cookie on failed login")
	}
}

func TestUserLogin_NonExistentUsername(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Login with user that does NOT exist
	loginBody := `{"username":"doesnotexist","password":"password123"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for non-existent user, got %d body=%s", rec.Code, rec.Body.String())
	}

	if rec.Header().Get("Set-Cookie") != "" {
		t.Fatalf("did not expect Set-Cookie on failed login")
	}
}

func TestUserLogin_NonExistentEmail(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	loginBody := `{"email":"ghost@example.com","password":"password123"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for non-existent email, got %d body=%s", rec.Code, rec.Body.String())
	}
}

/*---------
   LOGOUT
-----------*/

func TestUserLogout(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Register + Login
	regBody := `{"username":"logoutUser","email":"logout@example.com","password":"password123","first_name":"Logout","last_name":"User","age":40,"gender":"other"}`
	_, _ = doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(regBody))

	loginBody := `{"username":"logoutUser","password":"password123"}`
	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(loginBody))

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected cookie on login")
	}
	token := strings.Split(strings.Split(setCookie, ";")[0], "=")[1]

	// Logout
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/logout", nil)
	req.Header.Set("Cookie", "session_token="+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 logout, got %d", w.Code)
	}

	req2 := httptest.NewRequest("GET", "/api/v1/users/me", nil)
	req2.Header.Set("Cookie", "session_token="+token)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, req2)

	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 after logout, got %d", w2.Code)
	}
}

/*----------------
 INVALID /ME CALL
------------------*/

func TestUserMe_NoCookie(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without auth, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserMe_InvalidCookie(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Cookie", "session_token=invalidtoken123")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with invalid cookie, got %d body=%s", rec.Code, rec.Body.String())
	}
}

/*-------------------
 GET NONEXISTENT USER
---------------------*/

func TestUserGet_NonExistent(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// Register + login
	regBody := `{"username":"exists","email":"exists@example.com","password":"password123","first_name":"Exists","last_name":"User","age":28,"gender":"other"}`
	_, _ = doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(regBody))

	loginBody := `{"username":"exists","password":"password123"}`
	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(loginBody))

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected cookie on login")
	}
	token := strings.Split(strings.Split(setCookie, ";")[0], "=")[1]

	// Request non-existent user
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/9999", nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)

	if rec2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent user, got %d body=%s",
			rec2.Code, rec2.Body.String())
	}
}

/*---------------------------
  C11 - PROFILE FIELD VALIDATION
----------------------------*/

func TestC11_Registration_MissingProfileFields(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	cases := []struct {
		desc string
		body string
	}{
		{"missing age", `{"username":"u1","email":"u1@example.com","password":"password123","age":0,"gender":"male","first_name":"A","last_name":"B"}`},
		{"negative age", `{"username":"u2","email":"u2@example.com","password":"password123","age":-1,"gender":"male","first_name":"A","last_name":"B"}`},
		{"missing gender", `{"username":"u3","email":"u3@example.com","password":"password123","age":20,"gender":"","first_name":"A","last_name":"B"}`},
		{"whitespace gender", `{"username":"u4","email":"u4@example.com","password":"password123","age":20,"gender":"   ","first_name":"A","last_name":"B"}`},
		{"missing first_name", `{"username":"u5","email":"u5@example.com","password":"password123","age":20,"gender":"male","first_name":"","last_name":"B"}`},
		{"whitespace first_name", `{"username":"u6","email":"u6@example.com","password":"password123","age":20,"gender":"male","first_name":"   ","last_name":"B"}`},
		{"missing last_name", `{"username":"u7","email":"u7@example.com","password":"password123","age":20,"gender":"male","first_name":"A","last_name":""}`},
		{"whitespace last_name", `{"username":"u8","email":"u8@example.com","password":"password123","age":20,"gender":"male","first_name":"A","last_name":"   "}`},
	}

	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(tc.body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d body=%s", tc.desc, rec.Code, rec.Body.String())
		}
	}
}

func TestC11_Registration_ValidPayloadSucceeds(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	body := `{"username":"c11user","email":"c11@example.com","password":"password123","age":22,"gender":"female","first_name":"Clara","last_name":"Smith"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for valid extended payload, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Set-Cookie") == "" {
		t.Fatal("expected session cookie after registration")
	}
}
