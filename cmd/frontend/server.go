// cmd/frontend/server.go
package main

import (
	"net/http"
	"strings"
)

type CustomFileServer struct {
	fs       http.FileSystem
	handler  http.Handler
	notFound string
}

func NewCustomFileServer(fs http.FileSystem, notFoundPage string) http.Handler {
	return &CustomFileServer{
		fs:       fs,
		handler:  http.FileServer(fs),
		notFound: notFoundPage,
	}
}

func (c *CustomFileServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 1. Try to open the file in the filesystem
	path := r.URL.Path
	f, err := c.fs.Open(path)
	if err == nil {
		f.Close()
		c.handler.ServeHTTP(w, r)
		return
	}

	// 2. If file not found, check if it's a navigation request for SPA fallback
	if isNavigationRequest(r) {
		// Serve the SPA shell.
		// http.ServeFile will set the correct Content-Type (text/html) and status 200.
		http.ServeFile(w, r, c.notFound)
		return
	}

	// 3. Otherwise, return a proper 404
	http.Error(w, "404 page not found", http.StatusNotFound)
}

func isNavigationRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}

	// SPA fallback is typically for extensionless paths (like /login)
	// or paths ending in .html.
	path := r.URL.Path
	lastDot := -1
	for i := len(path) - 1; i >= 0 && path[i] != '/'; i-- {
		if path[i] == '.' {
			lastDot = i
			break
		}
	}

	if lastDot != -1 {
		ext := path[lastDot:]
		if ext != ".html" {
			return false
		}
	}

	// Also check Accept header if present
	accept := r.Header.Get("Accept")
	if accept != "" {
		// If it explicitly asks for something else (like JSON or images) and NOT HTML, don't fallback
		hasHTML := strings.Contains(accept, "text/html") || strings.Contains(accept, "*/*")
		if !hasHTML {
			return false
		}
	}

	return true
}
