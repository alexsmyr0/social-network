package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"forum/internal/db"
)

type registrationInput struct {
	Email       string  `json:"email"`
	Password    string  `json:"password"`
	FirstName   string  `json:"first_name"`
	LastName    string  `json:"last_name"`
	DateOfBirth string  `json:"date_of_birth"`
	Nickname    *string `json:"nickname"`
	AboutMe     *string `json:"about_me"`
}

func (u *UsersHandler) registerAccount(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		if _, err := db.GetSessionByToken(r.Context(), u.conn, cookie.Value); err == nil {
			WriteError(w, r, NewError("ALREADY_AUTHENTICATED", "already signed in", http.StatusConflict))
			return
		} else if !errors.Is(err, db.ErrNotFound) {
			writeHandlerError(w, r, err, "failed to check session")
			return
		}
	}
	input, avatar, apiErr := parseRegistration(w, r)
	if apiErr != nil {
		WriteError(w, r, apiErr)
		return
	}
	if avatar {
		WriteError(w, r, NewError("SERVICE_UNAVAILABLE", "avatar registration is not available yet", http.StatusServiceUnavailable))
		return
	}
	accountInput, fields := validateRegistration(input, time.Now().UTC())
	if len(fields) > 0 {
		err := NewError("VALIDATION_ERROR", "Check the highlighted fields", http.StatusBadRequest)
		err.Fields = fields
		WriteError(w, r, err)
		return
	}
	account, err := db.CreateAccount(r.Context(), u.conn, accountInput)
	if errors.Is(err, db.ErrEmailTaken) {
		apiErr := NewError("EMAIL_TAKEN", "Email is already registered", http.StatusConflict)
		apiErr.Fields = map[string]string{"email": "EMAIL_TAKEN"}
		WriteError(w, r, apiErr)
		return
	}
	if err != nil {
		writeHandlerError(w, r, err, "failed to register account")
		return
	}
	session, err := db.CreateSession(r.Context(), u.conn, account.ID, r.RemoteAddr, r.UserAgent())
	if err != nil {
		// B09 will make account, session and avatar one durable unit.
		_, _ = u.conn.ExecContext(r.Context(), `DELETE FROM users WHERE id = ?`, account.ID)
		writeHandlerError(w, r, err, "failed to create session")
		return
	}
	http.SetCookie(w, sessionCookie(session.Token))
	WriteCreated(w, account)
}

func parseRegistration(w http.ResponseWriter, r *http.Request) (registrationInput, bool, *APIError) {
	var input registrationInput
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/json" && mediaType != "multipart/form-data") {
		return input, false, NewError("UNSUPPORTED_MEDIA_TYPE", "unsupported content type", http.StatusUnsupportedMediaType)
	}
	if mediaType == "application/json" {
		r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			return input, false, registrationParseError(err)
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			if err != nil {
				return input, false, registrationParseError(err)
			}
			return input, false, NewError("BAD_REQUEST", "invalid json", http.StatusBadRequest)
		}
		return input, false, nil
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		return input, false, registrationParseError(err)
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	var textBytes int
	values := map[string]*string{
		"email": &input.Email, "password": &input.Password,
		"first_name": &input.FirstName, "last_name": &input.LastName,
		"date_of_birth": &input.DateOfBirth,
	}
	for name, parts := range r.MultipartForm.Value {
		if len(parts) != 1 {
			return input, false, NewError("BAD_REQUEST", "repeated form field", http.StatusBadRequest)
		}
		textBytes += len(parts[0])
		if textBytes > 16<<10 {
			return input, false, NewError("PAYLOAD_TOO_LARGE", "form text is too large", http.StatusRequestEntityTooLarge)
		}
		if target, ok := values[name]; ok {
			*target = parts[0]
			continue
		}
		switch name {
		case "nickname":
			input.Nickname = &parts[0]
		case "about_me":
			input.AboutMe = &parts[0]
		default:
			return input, false, NewError("BAD_REQUEST", "unknown form field", http.StatusBadRequest)
		}
	}
	for name, files := range r.MultipartForm.File {
		if name != "avatar" || len(files) != 1 {
			return input, false, NewError("BAD_REQUEST", "unknown or repeated file", http.StatusBadRequest)
		}
	}
	return input, len(r.MultipartForm.File["avatar"]) == 1, nil
}

func registrationParseError(err error) *APIError {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return NewError("PAYLOAD_TOO_LARGE", "request is too large", http.StatusRequestEntityTooLarge)
	}
	return NewError("BAD_REQUEST", "invalid registration body", http.StatusBadRequest)
}

func validateRegistration(input registrationInput, now time.Time) (db.NewAccount, map[string]string) {
	fields := make(map[string]string)
	account := db.NewAccount{
		Email: strings.ToLower(strings.TrimSpace(input.Email)), Password: input.Password,
		FirstName: strings.TrimSpace(input.FirstName), LastName: strings.TrimSpace(input.LastName),
		DateOfBirth: input.DateOfBirth,
	}
	if account.Email == "" {
		fields["email"] = "REQUIRED"
	} else if !validAccountEmail(account.Email) {
		fields["email"] = "INVALID_EMAIL"
	}
	if input.Password == "" {
		fields["password"] = "REQUIRED"
	} else if utf8.RuneCountInString(input.Password) < 8 || len(input.Password) > 72 || strings.ContainsRune(input.Password, 0) {
		fields["password"] = "INVALID_PASSWORD"
	}
	for name, value := range map[string]string{"first_name": account.FirstName, "last_name": account.LastName} {
		switch {
		case value == "":
			fields[name] = "REQUIRED"
		case utf8.RuneCountInString(value) > 100:
			fields[name] = "TOO_LONG"
		case hasControl(value, false):
			fields[name] = "INVALID_TEXT"
		}
	}
	if account.DateOfBirth == "" {
		fields["date_of_birth"] = "REQUIRED"
	} else if len(account.DateOfBirth) != 10 {
		fields["date_of_birth"] = "INVALID_DATE"
	} else if date, err := time.Parse("2006-01-02", account.DateOfBirth); err != nil || date.Format("2006-01-02") != account.DateOfBirth || date.Year() < 1 || date.After(now) {
		fields["date_of_birth"] = "INVALID_DATE"
	}
	for name, raw := range map[string]*string{"nickname": input.Nickname, "about_me": input.AboutMe} {
		if raw == nil {
			continue
		}
		value := strings.TrimSpace(*raw)
		if value == "" {
			continue
		}
		limit := 30
		if name == "about_me" {
			limit = 1000
		}
		switch {
		case utf8.RuneCountInString(value) > limit:
			fields[name] = "TOO_LONG"
		case hasControl(value, name == "about_me"):
			fields[name] = "INVALID_TEXT"
		default:
			if name == "nickname" {
				account.Nickname = &value
			} else {
				account.AboutMe = &value
			}
		}
	}
	return account, fields
}

func hasControl(value string, allowFormatting bool) bool {
	for _, r := range value {
		if unicode.IsControl(r) && !(allowFormatting && (r == '\n' || r == '\t')) {
			return true
		}
	}
	return false
}

func validAccountEmail(email string) bool {
	if len(email) > 254 || strings.Count(email, "@") != 1 {
		return false
	}
	parts := strings.SplitN(email, "@", 2)
	local, domain := parts[0], parts[1]
	if len(local) == 0 || len(local) > 64 || len(domain) == 0 {
		return false
	}
	allowedLocal := "!#$%&'*+-/=?^_`{|}~\\"
	for _, atom := range strings.Split(local, ".") {
		if atom == "" {
			return false
		}
		for _, c := range atom {
			if !asciiAlnum(c) && !strings.ContainsRune(allowedLocal, c) {
				return false
			}
		}
	}
	labels := strings.Split(domain, ".")
	if len(labels) < 2 {
		return false
	}
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !asciiAlnum(c) && c != '-' {
				return false
			}
		}
	}
	return true
}

func asciiAlnum(c rune) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}
