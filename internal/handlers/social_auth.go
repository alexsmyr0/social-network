package handlers

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"forum/internal/db"
)

type socialLoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (u *UsersHandler) loginAccount(w http.ResponseWriter, r *http.Request) {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		WriteError(w, r, NewError("UNSUPPORTED_MEDIA_TYPE", "expected JSON", http.StatusUnsupportedMediaType))
		return
	}
	var input socialLoginInput
	if apiErr := decodeStrictAuthObject(w, r, &input, "email", "password"); apiErr != nil {
		WriteError(w, r, apiErr)
		return
	}
	input.Email = strings.ToLower(strings.TrimSpace(input.Email))
	fields := make(map[string]string)
	if input.Email == "" {
		fields["email"] = "REQUIRED"
	} else if !validAccountEmail(input.Email) {
		fields["email"] = "INVALID_EMAIL"
	}
	if input.Password == "" {
		fields["password"] = "REQUIRED"
	}
	if len(fields) > 0 {
		apiErr := NewError("VALIDATION_ERROR", "Check the highlighted fields", http.StatusBadRequest)
		apiErr.Fields = fields
		WriteError(w, r, apiErr)
		return
	}
	user, err := db.LoginUser(r.Context(), u.conn, db.LoginRequest{Email: input.Email, Password: input.Password})
	if errors.Is(err, db.ErrInvalidCredentials) {
		WriteError(w, r, NewError("INVALID_CREDENTIALS", "Invalid email or password", http.StatusUnauthorized))
		return
	}
	if err != nil {
		writeHandlerError(w, r, err, "failed to check credentials")
		return
	}
	account, err := db.GetAccount(r.Context(), u.conn, user.ID)
	if err != nil {
		writeHandlerError(w, r, err, "failed to load account")
		return
	}
	priorToken := ""
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		priorToken = cookie.Value
	}
	var session db.Session
	createSession := func() error {
		var err error
		session, err = db.CreateSessionForLogin(r.Context(), u.conn, user.ID, priorToken, r.RemoteAddr, r.UserAgent())
		return err
	}
	if priorToken != "" {
		err = u.hub.RevokeToken(r.Context(), priorToken, createSession)
	} else {
		err = createSession()
	}
	if err != nil {
		if session.Token != "" {
			_ = db.InvalidateSessionByToken(r.Context(), u.conn, session.Token)
		}
		writeHandlerError(w, r, err, "failed to create session")
		return
	}
	http.SetCookie(w, socialSessionCookie(session.Token))
	WriteOK(w, account, nil)
}

func (u *UsersHandler) logoutAccount(w http.ResponseWriter, r *http.Request) {
	if body, err := io.ReadAll(io.LimitReader(r.Body, 1)); err != nil || len(body) != 0 {
		WriteError(w, r, NewError("BAD_REQUEST", "logout body must be empty", http.StatusBadRequest))
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		if err := u.hub.RevokeToken(r.Context(), cookie.Value, func() error {
			return db.InvalidateSessionByToken(r.Context(), u.conn, cookie.Value)
		}); err != nil {
			writeHandlerError(w, r, err, "failed to revoke session")
			return
		}
	}
	http.SetCookie(w, socialClearedSessionCookie())
	WriteOK(w, map[string]string{"message": "Logged out"}, nil)
}
