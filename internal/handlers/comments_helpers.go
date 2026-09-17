// internal/handlers/comments_helpers.go
package handlers

import (
	"net/http"
	"strings"
)

func resolveCommentRoute(w http.ResponseWriter, r *http.Request) (commentID int64, action string, ok bool) {
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/comments/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		notFound(w, r)
		return 0, "", false
	}
	id, err := parsePositiveID(parts[0])
	if err != nil {
		WriteError(w, r, NewError("BAD_REQUEST", "invalid comment id", http.StatusBadRequest))
		return 0, "", false
	}

	if len(parts) > 1 {
		action = strings.Split(parts[1], "?")[0]
	}

	return id, action, true
}
