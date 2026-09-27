package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"forum/internal/db"
	"forum/internal/router"
	"forum/internal/ws"

	"github.com/gorilla/websocket"
)

const socialPassword = "correct horse battery"

func registerSocialUser(t *testing.T, handler http.Handler, email string) string {
	t.Helper()
	body := `{"email":"` + email + `","password":"` + socialPassword + `","first_name":"Alex","last_name":"Example","date_of_birth":"1998-03-14"}`
	response := socialRequest(t, handler, http.MethodPost, "/api/v1/users/register", "application/json", []byte(body), "")
	if response.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", response.Code, response.Body.String())
	}
	return response.Result().Cookies()[0].Value
}

func loginSocialUser(t *testing.T, handler http.Handler, email, priorToken string) *httptest.ResponseRecorder {
	t.Helper()
	body := `{"email":"` + email + `","password":"` + socialPassword + `"}`
	return socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "application/json", []byte(body), priorToken)
}

func assertSocialCode(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status || (code != "" && !strings.Contains(response.Body.String(), `"`+code+`"`)) {
		t.Fatalf("status/body: %d %s; want %d %s", response.Code, response.Body.String(), status, code)
	}
}

func TestSocialSessionLoginPersistenceAndCookie(t *testing.T) {
	handler, conn := socialAPI(t)
	first := registerSocialUser(t, handler, "alex@example.com")
	bad := socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "application/json", []byte(`{"email":"alex@example.com","password":"wrong password"}`), "")
	unknown := loginSocialUser(t, handler, "unknown@example.com", "")
	assertSocialCode(t, bad, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	assertSocialCode(t, unknown, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	if bad.Body.String() != unknown.Body.String() || bad.Header().Get("Set-Cookie") != "" {
		t.Fatal("invalid login disclosed account existence or changed cookie")
	}
	login := loginSocialUser(t, handler, " ALEX@EXAMPLE.COM ", "")
	assertSocialCode(t, login, http.StatusOK, "")
	if !bytes.Contains(login.Body.Bytes(), []byte(`"email":"alex@example.com"`)) || bytes.Contains(login.Body.Bytes(), []byte("password")) {
		t.Fatalf("wrong login account: %s", login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	if cookie.Value == first || cookie.MaxAge != 400*24*60*60 || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Secure || cookie.Domain != "" || cookie.Path != "/" {
		t.Fatalf("wrong persistent cookie: %+v", cookie)
	}
	if cookie.Expires.Before(time.Now().Add(399 * 24 * time.Hour)) {
		t.Fatalf("cookie expires too soon: %v", cookie.Expires)
	}
	if login.Header().Get("Cache-Control") != "no-store" || bad.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("auth response must be no-store")
	}
	for _, age := range []time.Duration{13 * time.Hour, 30 * 24 * time.Hour, 401 * 24 * time.Hour} {
		issuedAt := time.Now().UTC().Add(-age).Format(time.RFC3339)
		if _, err := conn.Exec(`UPDATE sessions SET created_at = ?, expires_at = '2000-01-01T00:00:00Z' WHERE token = ?`, issuedAt, cookie.Value); err != nil {
			t.Fatal(err)
		}
		me := socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, cookie.Value)
		assertSocialCode(t, me, http.StatusOK, "")
		refreshed := me.Result().Cookies()[0]
		if refreshed.Value != cookie.Value || refreshed.MaxAge != cookie.MaxAge {
			t.Fatalf("/me did not renew same cookie: %+v", refreshed)
		}
	}
	if err := db.CleanupSessions(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, cookie.Value), http.StatusOK, "")
	if _, err := conn.Exec(`UPDATE users SET is_active = 0 WHERE email = 'alex@example.com'`); err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, cookie.Value), http.StatusUnauthorized, "UNAUTHORIZED")
	assertSocialCode(t, loginSocialUser(t, handler, "alex@example.com", ""), http.StatusUnauthorized, "INVALID_CREDENTIALS")
}

func TestSocialSessionIndependentLoginLogoutAndReplay(t *testing.T) {
	handler, conn := socialAPI(t)
	first := registerSocialUser(t, handler, "alex@example.com")
	secondLogin := loginSocialUser(t, handler, "alex@example.com", "")
	assertSocialCode(t, secondLogin, http.StatusOK, "")
	second := secondLogin.Result().Cookies()[0].Value
	rejected := socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "application/json", []byte(`{"email":"alex@example.com","password":"wrong password"}`), second)
	assertSocialCode(t, rejected, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, first), http.StatusOK, "")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusOK, "")
	thirdLogin := loginSocialUser(t, handler, "alex@example.com", first)
	assertSocialCode(t, thirdLogin, http.StatusOK, "")
	third := thirdLogin.Result().Cookies()[0].Value
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, first), http.StatusUnauthorized, "UNAUTHORIZED")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusOK, "")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, third), http.StatusOK, "")
	badLogout := socialRequest(t, handler, http.MethodPost, "/api/v1/users/logout", "application/json", []byte(`{}`), third)
	assertSocialCode(t, badLogout, http.StatusBadRequest, "BAD_REQUEST")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, third), http.StatusOK, "")
	for _, token := range []string{second, second, "", "unknown"} {
		logout := socialRequest(t, handler, http.MethodPost, "/api/v1/users/logout", "", nil, token)
		assertSocialCode(t, logout, http.StatusOK, "")
		if !strings.Contains(logout.Header().Get("Set-Cookie"), "Max-Age=0") || !bytes.Contains(logout.Body.Bytes(), []byte(`"message":"Logged out"`)) {
			t.Fatalf("logout did not clear cookie: %s %s", logout.Header().Get("Set-Cookie"), logout.Body.String())
		}
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusUnauthorized, "UNAUTHORIZED")
	assertSocialCode(t, socialRequest(t, handler, http.MethodPost, "/api/v1/posts", "application/json", []byte(`{}`), second), http.StatusUnauthorized, "UNAUTHORIZED")
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, third), http.StatusOK, "")
	var dbPath string
	var seq int
	var name string
	if err := conn.QueryRow("PRAGMA database_list").Scan(&seq, &name, &dbPath); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted := router.NewRouter(reopened, ws.NewHub())
	assertSocialCode(t, socialRequest(t, restarted, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusUnauthorized, "UNAUTHORIZED")
	assertSocialCode(t, socialRequest(t, restarted, http.MethodGet, "/api/v1/users/me", "", nil, third), http.StatusOK, "")
}

func TestSocialSessionOriginAndBodyEnforcement(t *testing.T) {
	handler, conn := socialAPI(t)
	wrongMethod := socialRequest(t, handler, http.MethodGet, "/api/v1/users/login", "", nil, "")
	assertSocialCode(t, wrongMethod, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED")
	if wrongMethod.Header().Get("Allow") != "POST" || wrongMethod.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("method response headers: %v", wrongMethod.Header())
	}
	registerBody := []byte(`{"email":"alex@example.com","password":"correct horse battery","first_name":"Alex","last_name":"Example","date_of_birth":"1998-03-14"}`)
	for _, tc := range []struct {
		name, origin, referer, header, want string
	}{
		{"missing origin", "", "", "XMLHttpRequest", "ORIGIN_FORBIDDEN"},
		{"foreign origin", "http://evil.example", "", "XMLHttpRequest", "ORIGIN_FORBIDDEN"},
		{"null origin", "null", "http://localhost:3000/register", "XMLHttpRequest", "ORIGIN_FORBIDDEN"},
		{"wrong header", "http://localhost:3000", "", "nope", "CSRF_CHECK_FAILED"},
		{"missing header", "http://localhost:3000", "", "", "CSRF_CHECK_FAILED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewReader(registerBody))
			req.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				req.Header.Set("Referer", tc.referer)
			}
			if tc.header != "" {
				req.Header.Set("X-Requested-With", tc.header)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			assertSocialCode(t, rec, http.StatusForbidden, tc.want)
		})
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("forbidden writes changed data: %d %v", count, err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewReader(registerBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Referer", "http://localhost:3000/register")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, http.StatusCreated, "")
	token := rec.Result().Cookies()[0].Value
	protected := httptest.NewRequest(http.MethodPost, "/api/v1/posts", strings.NewReader(`{}`))
	protected.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	protected.Header.Set("Origin", "http://localhost:3000")
	blocked := httptest.NewRecorder()
	handler.ServeHTTP(blocked, protected)
	assertSocialCode(t, blocked, http.StatusForbidden, "CSRF_CHECK_FAILED")

	for _, body := range []string{
		`{"email":"alex@example.com","email":"other@example.com","password":"correct horse battery"}`,
		`{"email":"alex@example.com","Email":"other@example.com","password":"correct horse battery"}`,
		`{"Email":"alex@example.com","password":"correct horse battery"}`,
		`{"email":"alex@example.com","password":"correct horse battery","username":"legacy"}`,
		`{"email":"alex@example.com","password":"correct horse battery"}{}`,
		`["alex@example.com","correct horse battery"]`,
	} {
		assertSocialCode(t, socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "application/json", []byte(body), ""), http.StatusBadRequest, "BAD_REQUEST")
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "text/plain", []byte(`{}`), ""), http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE")
	assertSocialCode(t, socialRequest(t, handler, http.MethodPost, "/api/v1/users/login", "application/json", bytes.Repeat([]byte("x"), 16<<10+1), ""), http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE")
}

func TestSocialSessionSecureCookieAndLookupFailure(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://social.example")
	handler, conn := socialAPI(t)
	body := `{"email":"alex@example.com","password":"correct horse battery","first_name":"Alex","last_name":"Example","date_of_birth":"1998-03-14"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", strings.NewReader(body))
	req.Header.Set("Origin", "https://social.example")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, http.StatusCreated, "")
	cookie := rec.Result().Cookies()[0]
	if !cookie.Secure || cookie.Domain != "" {
		t.Fatalf("production cookie flags: %+v", cookie)
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	failed := socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, cookie.Value)
	assertSocialCode(t, failed, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR")
	if failed.Header().Get("Set-Cookie") != "" {
		t.Fatal("lookup failure cleared the browser cookie")
	}
	logout := httptest.NewRequest(http.MethodPost, "/api/v1/users/logout", nil)
	logout.AddCookie(&http.Cookie{Name: "session_token", Value: cookie.Value})
	logout.Header.Set("Origin", "https://social.example")
	logout.Header.Set("X-Requested-With", "XMLHttpRequest")
	failedLogout := httptest.NewRecorder()
	handler.ServeHTTP(failedLogout, logout)
	assertSocialCode(t, failedLogout, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR")
	if failedLogout.Header().Get("Set-Cookie") != "" {
		t.Fatal("revocation failure cleared the browser cookie")
	}
}

func TestSocialSessionRevokesRetainedSocketOnly(t *testing.T) {
	requireLocalTCPListener(t)
	handler, conn, hub := socialAPIWithHub(t)
	first := registerSocialUser(t, handler, "alex@example.com")
	secondResponse := loginSocialUser(t, handler, "alex@example.com", "")
	assertSocialCode(t, secondResponse, http.StatusOK, "")
	second := secondResponse.Result().Cookies()[0].Value
	srv := httptest.NewServer(handler)
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	dial := func(token, origin string) (*websocket.Conn, int) {
		headers := http.Header{}
		headers.Set("Cookie", "session_token="+token)
		if origin != "" {
			headers.Set("Origin", origin)
		}
		conn, response, err := websocket.DefaultDialer.Dial(url, headers)
		if err != nil {
			if response == nil {
				t.Fatalf("WebSocket dial: %v", err)
			}
			return nil, response.StatusCode
		}
		return conn, http.StatusSwitchingProtocols
	}
	if _, status := dial(first, ""); status != http.StatusForbidden {
		t.Fatalf("missing WS Origin: %d", status)
	}
	if _, status := dial(first, "http://evil.example"); status != http.StatusForbidden {
		t.Fatalf("foreign WS Origin: %d", status)
	}
	firstSocket, status := dial(first, "http://localhost:3000")
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("first WS: %d", status)
	}
	defer firstSocket.Close()
	secondSocket, status := dial(second, "http://localhost:3000")
	if status != http.StatusSwitchingProtocols {
		t.Fatalf("second WS: %d", status)
	}
	defer secondSocket.Close()
	logout := socialRequest(t, handler, http.MethodPost, "/api/v1/users/logout", "", nil, first)
	assertSocialCode(t, logout, http.StatusOK, "")
	_ = firstSocket.SetReadDeadline(time.Now().Add(time.Second))
	for {
		if _, _, err := firstSocket.ReadMessage(); err != nil {
			break
		}
	}
	var userID int64
	if err := conn.QueryRow(`SELECT id FROM users WHERE email = 'alex@example.com'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if got := hub.GetConnectionCount(userID); got != 1 {
		t.Fatalf("logout closed %d connections; want only first token closed", 2-got)
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusOK, "")
	if _, status := dial(first, "http://localhost:3000"); status != http.StatusUnauthorized {
		t.Fatalf("revoked WS reopened: %d", status)
	}
	replacement := loginSocialUser(t, handler, "alex@example.com", second)
	assertSocialCode(t, replacement, http.StatusOK, "")
	if got := hub.GetConnectionCount(userID); got != 0 {
		t.Fatalf("replaced session retained %d sockets", got)
	}
	assertSocialCode(t, socialRequest(t, handler, http.MethodGet, "/api/v1/users/me", "", nil, second), http.StatusUnauthorized, "UNAUTHORIZED")
}

func TestSocialSessionRevokedSocketCannotSend(t *testing.T) {
	requireLocalTCPListener(t)
	handler, conn, _ := socialAPIWithHub(t)
	aliceToken := registerSocialUser(t, handler, "alice@example.com")
	bobToken := registerSocialUser(t, handler, "bob@example.com")
	var bobID int64
	if err := conn.QueryRow(`SELECT id FROM users WHERE email = 'bob@example.com'`).Scan(&bobID); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()
	dial := func(token string) *websocket.Conn {
		t.Helper()
		headers := http.Header{}
		headers.Set("Origin", "http://localhost:3000")
		headers.Set("Cookie", "session_token="+token)
		url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
		socket, _, err := websocket.DefaultDialer.Dial(url, headers)
		if err != nil {
			t.Fatal(err)
		}
		return socket
	}
	alice := dial(aliceToken)
	defer alice.Close()
	bob := dial(bobToken)
	defer bob.Close()
	if err := db.InvalidateSessionByToken(context.Background(), conn, aliceToken); err != nil {
		t.Fatal(err)
	}
	message := `{"type":"dm.send","payload":{"recipient_id":` + strconv.FormatInt(bobID, 10) + `,"body":"after revoke"}}`
	if err := alice.WriteMessage(websocket.TextMessage, []byte(message)); err != nil {
		t.Fatal(err)
	}
	_ = alice.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if _, _, err := alice.ReadMessage(); err != nil {
			var networkError net.Error
			if errors.As(err, &networkError) && networkError.Timeout() {
				t.Fatal("revoked socket stayed open")
			}
			break
		}
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM private_messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("revoked socket persisted %d messages", count)
	}
}

func TestSocialWebSocketOriginUsesEffectivePort(t *testing.T) {
	requireLocalTCPListener(t)
	t.Setenv("FRONTEND_URL", "https://social.example")
	handler, _, _ := socialAPIWithHub(t)
	body := `{"email":"alex@example.com","password":"correct horse battery","first_name":"Alex","last_name":"Example","date_of_birth":"1998-03-14"}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", strings.NewReader(body))
	request.Header.Set("Origin", "https://social.example:443")
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertSocialCode(t, response, http.StatusCreated, "")
	token := response.Result().Cookies()[0].Value
	srv := httptest.NewServer(handler)
	defer srv.Close()
	headers := http.Header{}
	headers.Set("Origin", "https://social.example:443")
	headers.Set("Cookie", "session_token="+token)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		t.Fatalf("equivalent Origin rejected: %v", err)
	}
	conn.Close()
}

func TestSocialLoginResponseMatchesAccount(t *testing.T) {
	handler, _ := socialAPI(t)
	registerSocialUser(t, handler, "alex@example.com")
	login := loginSocialUser(t, handler, "alex@example.com", "")
	var body struct {
		Data db.Account `json:"data"`
	}
	if err := json.Unmarshal(login.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Email != "alex@example.com" || body.Data.DisplayName != "Alex Example" || body.Data.AvatarURL != nil {
		t.Fatalf("login account: %+v", body.Data)
	}
}
