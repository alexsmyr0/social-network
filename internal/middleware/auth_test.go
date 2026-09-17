// internal/middleware/auth_test.go
//
// Isolated unit tests for the Auth chokepoint — the session-validation gate
// that every protected REST route and the WebSocket upgrade depend on. These
// exercise the four acceptance cases (valid / expired / invalid / missing
// cookie) without standing up the full router, by driving Auth against an
// in-memory SQLite database with hand-inserted session rows.
package middleware

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	db "forum/internal/db"
)

// newAuthDB boots an in-memory sqlite instance with the real schema and a
// single seeded user, returning the handle plus that user's id.
func newAuthDB(t *testing.T) (*sql.DB, int64) {
	t.Helper()

	conn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	conn.SetMaxOpenConns(1)

	schemaBytes, err := os.ReadFile(filepath.Join("..", "db", "forum_schema.sql"))
	if err != nil {
		conn.Close()
		t.Fatalf("read schema: %v", err)
	}
	if _, err := conn.Exec(string(schemaBytes)); err != nil {
		conn.Close()
		t.Fatalf("exec schema: %v", err)
	}

	createdID, err := db.CreateUser(context.Background(), conn, db.CreateUserRequest{
		Username:  "authuser",
		Email:     "auth@example.com",
		Password:  "password123",
		FirstName: "Auth",
		LastName:  "User",
		Age:       20,
		Gender:    "other",
	})
	if err != nil {
		conn.Close()
		t.Fatalf("seed user: %v", err)
	}

	return conn, createdID
}

// insertSession writes a raw session row with an explicit token + expiry so we
// can model both valid and already-expired sessions deterministically.
func insertSession(t *testing.T, conn *sql.DB, userID int64, token string, expiresAt time.Time) {
	t.Helper()
	_, err := conn.Exec(
		`INSERT INTO sessions (user_id, token, expires_at, ip, user_agent)
		 VALUES (?, ?, ?, '127.0.0.1', 'test')`,
		userID, token, expiresAt.UTC().Format(time.RFC3339),
	)
	if err != nil {
		t.Fatalf("insert session: %v", err)
	}
}

// okHandler reports 200 and echoes the authenticated user id from context.
func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := GetUserID(r.Context())
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"user_id":` + itoa(id) + `}`))
	})
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	pos := len(buf)
	for v > 0 {
		pos--
		buf[pos] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

func TestAuth_Chokepoint(t *testing.T) {
	conn, userID := newAuthDB(t)
	defer conn.Close()

	const validToken = "valid-token"
	const expiredToken = "expired-token"

	// sessions.user_id is UNIQUE (one session per user), so the expired row
	// must belong to a different seeded user.
	expiredUser, err := db.CreateUser(context.Background(), conn, db.CreateUserRequest{
		Username:  "expireduser",
		Email:     "expired@example.com",
		Password:  "password123",
		FirstName: "Expired",
		LastName:  "User",
		Age:       20,
		Gender:    "other",
	})
	if err != nil {
		t.Fatalf("seed expired user: %v", err)
	}

	insertSession(t, conn, userID, validToken, time.Now().Add(time.Hour))
	insertSession(t, conn, expiredUser, expiredToken, time.Now().Add(-time.Hour))

	auth := Auth(conn)

	cases := []struct {
		name     string
		cookie   string
		wantCode int
		wantUser bool
	}{
		{
			name:     "valid cookie authenticates and injects userID",
			cookie:   "session_token=" + validToken,
			wantCode: http.StatusOK,
			wantUser: true,
		},
		{
			name:     "expired cookie is rejected with 401",
			cookie:   "session_token=" + expiredToken,
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "unknown token is rejected with 401",
			cookie:   "session_token=does-not-exist",
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "missing cookie is rejected with 401",
			cookie:   "",
			wantCode: http.StatusUnauthorized,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
			if tc.cookie != "" {
				req.Header.Set("Cookie", tc.cookie)
			}
			rec := httptest.NewRecorder()
			auth(okHandler()).ServeHTTP(rec, req)

			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tc.wantCode, rec.Body.String())
			}
			if tc.wantUser {
				if rec.Body.String() != `{"user_id":`+itoa(userID)+`}` {
					t.Errorf("unexpected body %q", rec.Body.String())
				}
			}
		})
	}
}
