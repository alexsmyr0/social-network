package handlers

import (
	"database/sql"
	"net/http"
	"os"
	"strings"
)

type UsersHandler struct {
	conn *sql.DB
}

const sessionCookieName = "session_token"

// sessionCookieSecure reports whether the session cookie should carry the
// Secure attribute. It is derived from the frontend origin rather than
// hardcoded: a Secure cookie is silently dropped by the browser over plain
// http, which would break local development, while omitting it in production
// would let the session token travel in the clear.
func sessionCookieSecure() bool {
	return strings.HasPrefix(strings.ToLower(os.Getenv("FRONTEND_URL")), "https://")
}

// sessionCookie builds the cookie issued on login and register.
func sessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   sessionCookieSecure(),
		SameSite: http.SameSiteLaxMode,
	}
}

// clearedSessionCookie expires the session cookie on logout. Its attributes
// must match sessionCookie exactly or the browser will keep the original.
func clearedSessionCookie() *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   sessionCookieSecure(),
		SameSite: http.SameSiteLaxMode,
	}
}

func NewUsersHandler(database *sql.DB) *UsersHandler {
	return &UsersHandler{conn: database}
}

func resolveUserID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := parseID(r.URL.Path, "/api/v1/users/")
	if err != nil || id <= 0 {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"invalid user ID",
			http.StatusBadRequest,
		))
		return 0, false
	}
	return id, true
}
