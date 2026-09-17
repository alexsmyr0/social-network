// internal/middleware/auth.go

package middleware

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"forum/internal/db"
)

type contextKey string

const UserIDKey contextKey = "userID"

// Auth ensures a valid session and injects userID into context.
func Auth(database *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {

			// Authentication is cookie-only by design (SDS §6.3); there is no
			// Authorization: Bearer fallback.
			token := ""
			if cookie, err := r.Cookie("session_token"); err == nil {
				token = cookie.Value
			}

			if token == "" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			session, err := db.GetSessionByToken(r.Context(), database, token)
			if err != nil {
				clearSessionCookie(w)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), UserIDKey, session.UserID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUserID extracts authenticated user ID from context.
func GetUserID(ctx context.Context) (int64, error) {
	id, ok := ctx.Value(UserIDKey).(int64)
	if !ok || id <= 0 {
		return 0, errors.New("unauthenticated")
	}
	return id, nil
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}
