package handlers

import (
	"database/sql"
	"errors"
	"forum/internal/db"
	"io"
	"net/http"
	"os"
	"strconv"
)

func MediaHandler(database *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet {
			MethodNotAllowed(w, r)
			return
		}
		viewer, ok := db.SocialViewer(r.Context())
		if !ok {
			notFound(w, r)
			return
		}
		// Reject aliases before any mux cleaning, redirects, or filesystem access.
		if r.URL.EscapedPath() != r.URL.Path {
			notFound(w, r)
			return
		}
		m, err := db.AuthorizedMedia(r.Context(), database, viewer, r.URL.Path)
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, db.ErrNotFound) {
			notFound(w, r)
			return
		}
		if err != nil {
			writeHandlerError(w, r, err, "failed to load media")
			return
		}
		file, err := db.OpenMediaFile(database, m)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, db.ErrInvalidInput) {
				notFound(w, r)
			} else {
				writeHandlerError(w, r, err, "failed to load media")
			}
			return
		}
		defer file.Close()
		w.Header().Set("Content-Length", strconv.FormatInt(m.Bytes, 10))
		w.Header().Set("Content-Type", m.MIME)
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, io.LimitReader(file, m.Bytes))
	}
}
