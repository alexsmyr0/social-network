// Internal/handlers/helpers.go
package handlers

import (
	"errors"
	"forum/internal/middleware"
	"net/http"
	"strconv"
	"strings"
)

/*-----------------
  REQUEST HELPERS
-----------------*/

func sanitizePagination(r *http.Request) (page int, perPage int) {
	page = atoiOrDefault(r.URL.Query().Get("page"), 1)
	perPage = atoiOrDefault(r.URL.Query().Get("per_page"), 20)

	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 20
	}
	if perPage > 100 {
		perPage = 100
	}
	return
}

func sanitizeSort(r *http.Request) string {
	switch strings.ToLower(r.URL.Query().Get("sort")) {
	case "oldest", "top":
		return r.URL.Query().Get("sort")
	default:
		return "newest"
	}
}

/*-----------------
  GENERIC HELPERS
-----------------*/

func atoiOrDefault(str string, def int) int {
	if value, err := strconv.Atoi(str); err == nil {
		return value
	}
	return def
}

func parseID(path, prefix string) (int64, error) {
	raw := strings.TrimPrefix(path, prefix)
	return strconv.ParseInt(raw, 10, 64)
}

var errInvalidPositiveID = errors.New("invalid positive id")

func parsePositiveID(raw string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, errInvalidPositiveID
	}
	return id, nil
}

/*--------------
  AUTH HELPERS
--------------*/

func requireUserID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	userID, err := middleware.GetUserID(r.Context())
	if err != nil {
		WriteError(w, r, NewError("UNAUTHORIZED", "login required", http.StatusUnauthorized))
		return 0, false
	}
	return userID, true
}

/*------------------
  RESPONSE HELPERS
------------------*/

func MethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError("METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed))
}

func notFound(w http.ResponseWriter, r *http.Request) {
	WriteError(w, r, NewError("NOT_FOUND", "route not found", http.StatusNotFound))
}

/*---------------------
  STRING / DB HELPERS
---------------------*/

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, " ", "-")
	value = strings.ReplaceAll(value, "_", "-")
	return value
}

// isUniqueConstraint checks UNIQUE constraint errors via message matching.
func isUniqueConstraint(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "UNIQUE")
}

func getPostIDFromURL(w http.ResponseWriter, r *http.Request) (int64, bool) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 {
		notFound(w, r)
		return 0, false
	}

	id, err := parsePositiveID(parts[len(parts)-2])
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid post id", http.StatusBadRequest))
		return 0, false
	}

	return id, true
}
