// internal/tests/session_lifecycle_test.go
//
// C08 — session lifecycle coverage. Two genuinely-untested real paths:
//   - CleanupSessions (wired into backend startup, previously 0% coverage)
//   - single-active-session invalidation: a new login rotates the session and
//     invalidates the previous one (CreateSession bumps session_version and
//     invalidates prior sessions).
package tests

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"forum/internal/db"
)

// loginAs logs in an already-registered user and returns the new session token.
func loginAs(t *testing.T, h http.Handler, username string) string {
	t.Helper()
	body := fmt.Sprintf(`{"username":"%s","password":"password123"}`, username)
	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/login", []byte(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d body=%s", rec.Code, rec.Body.String())
	}
	sc := rec.Header().Get("Set-Cookie")
	if sc == "" {
		t.Fatalf("expected Set-Cookie on login")
	}
	return strings.Split(strings.Split(sc, ";")[0], "=")[1]
}

// meStatus returns the HTTP status of GET /me for the given token.
func meStatus(t *testing.T, h http.Handler, token string) int {
	t.Helper()
	rec, _ := doRequestWithToken(t, h, http.MethodGet, "/api/v1/users/me", token, nil)
	return rec.Code
}

func TestSession_NewLoginInvalidatesPreviousSession(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	token1 := registerAndLoginAs(t, h, "sessionrotate")
	if got := meStatus(t, h, token1); got != http.StatusOK {
		t.Fatalf("token1 should be valid right after login, got %d", got)
	}

	// A second login rotates the session: the old token must stop working.
	token2 := loginAs(t, h, "sessionrotate")
	if token1 == token2 {
		t.Fatal("expected a fresh session token on re-login")
	}
	if got := meStatus(t, h, token1); got != http.StatusUnauthorized {
		t.Errorf("old token should be invalidated after re-login, got %d", got)
	}
	if got := meStatus(t, h, token2); got != http.StatusOK {
		t.Errorf("new token should be valid, got %d", got)
	}
}

func TestCleanupSessions_RemovesInvalidAndExpired(t *testing.T) {
	sqlDB := setupTestDB(t)
	defer sqlDB.Close()
	ctx := context.Background()

	// A partial unique index (ux_session_single_active ON sessions(user_id)
	// WHERE is_valid = 1) allows only one *valid* session per user. Using a
	// distinct user per row keeps the seeding simple and unambiguous.
	aliceID, bobID := seedTwoUsers(t, sqlDB)
	charlieID, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username: "charlie", Email: "charlie@example.com", Password: "password123",
		Age: 25, Gender: "other", FirstName: "Charlie", LastName: "Brown",
	})
	if err != nil {
		t.Fatalf("create charlie: %v", err)
	}

	// Seed three sessions: one healthy, one explicitly invalidated, one expired.
	// Extreme years keep the expires_at string comparison unambiguous regardless
	// of stored timestamp formatting.
	if _, err := sqlDB.Exec(`
		INSERT INTO sessions (user_id, token, expires_at, is_valid) VALUES
		  (?, 'valid-token',   '2999-01-01T00:00:00Z', 1),
		  (?, 'invalid-token', '2999-01-01T00:00:00Z', 0),
		  (?, 'expired-token', '2000-01-01T00:00:00Z', 1)
	`, aliceID, bobID, charlieID); err != nil {
		t.Fatalf("seed sessions: %v", err)
	}

	if err := db.CleanupSessions(ctx, sqlDB); err != nil {
		t.Fatalf("CleanupSessions: %v", err)
	}

	count := func(token string) int {
		var n int
		if err := sqlDB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE token = ?`, token).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", token, err)
		}
		return n
	}
	if count("valid-token") != 1 {
		t.Error("valid session should survive cleanup")
	}
	if count("invalid-token") != 0 {
		t.Error("invalidated session should be deleted")
	}
	if count("expired-token") != 0 {
		t.Error("expired session should be deleted")
	}
}
