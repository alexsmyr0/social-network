// internal/tests/auth_errors_test.go
//
// C08 — auth endpoint error-path coverage: malformed request bodies and the
// POST-only method contract on register/login.
//
// #58 — also locks in the cookie-only auth contract: a valid token presented
// via Authorization: Bearer must NOT authenticate.
package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegister_MalformedJSONRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(`{not valid json`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed register body, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLogin_MalformedJSONRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(`{not valid json`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed login body, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestRegister_WrongMethodRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	rec, _ := doRequest(t, h, http.MethodGet, "/api/v1/users/register", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET on register, got %d", rec.Code)
	}
}

func TestLogin_WrongMethodRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	rec, _ := doRequest(t, h, http.MethodGet, "/api/v1/users/login", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET on login, got %d", rec.Code)
	}
}

// TestAuth_BearerTokenRejected proves the Authorization: Bearer fallback is
// gone (#58): even a genuine, valid session token is rejected when presented
// via the Authorization header instead of the session_token cookie.
func TestAuth_BearerTokenRejected(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginTestUser(t, h, "testuser")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Bearer token must not authenticate (cookie-only), got %d body=%s", rec.Code, rec.Body.String())
	}

	// Control: the same token via the cookie still authenticates.
	rec2, _ := doRequestWithToken(t, h, http.MethodGet, "/api/v1/users/me", token, nil)
	if rec2.Code != http.StatusOK {
		t.Fatalf("valid cookie token should authenticate, got %d", rec2.Code)
	}
}
