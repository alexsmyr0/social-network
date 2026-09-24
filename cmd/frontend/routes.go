// cmd/frontend/routes.go
package main

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
)

// cspHeaderPolicy is the frontend's Content-Security-Policy (issue #57).
//
// Notes on the source lists, since they are easy to loosen by accident:
//   - img-src: `'self'` already covers /static/uploads/* — the DM and post
//     attachments are same-origin. `data:`/`blob:` are for the image-picker
//     preview. No third-party image host is allowed, so nothing in the SPA may
//     hotlink an avatar or icon CDN.
//   - connect-src: `'self'` covers the same-origin /ws upgrade on its own under
//     CSP3; `ws:`/`wss:` scheme sources are deliberately NOT listed, because
//     they would permit a WebSocket to any host on the internet.
//   - style-src keeps 'unsafe-inline' for the Google Fonts stylesheet and the
//     handful of inline style attributes in rendered markup; script-src does
//     not, so the SPA must stay free of inline <script> and on* handlers.
const (
	cspHeaderPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';"
)

const defaultBackendBaseURL = "http://localhost:8080"

var backendBaseURL = configuredBackendBaseURL()

func configuredBackendBaseURL() string {
	if value := os.Getenv("BACKEND_URL"); value != "" {
		return value
	}

	return defaultBackendBaseURL
}

// SecurityHeaders injects standard browser security headers into all frontend responses.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", cspHeaderPolicy)
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// NewMux builds the frontend server mux, including static SPA delivery and the
// backend proxy routes used for REST and authenticated WebSocket traffic.
func NewMux() http.Handler {
	mux := http.NewServeMux()

	/* ----------------------------
	   Static assets (/static/*)
	------------------------------*/
	mux.Handle(
		"/static/",
		http.StripPrefix(
			"/static/",
			http.FileServer(http.Dir("./web/static")),
		),
	)

	// Favicon (served from root with cache headers)
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeFile(w, r, "./web/static/favicon.ico")
	})

	/*-----------------------------
	  Error assets (/errors/*)
	-----------------------------*/
	mux.Handle(
		"/errors/",
		http.StripPrefix(
			"/errors/",
			http.FileServer(http.Dir("./web/errors")),
		),
	)

	// ---- API and WebSocket proxy to backend (8080) ----
	backendURL, err := url.Parse(backendBaseURL)
	if err != nil {
		log.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(backendURL)

	// Route both /api/ and /ws through the same backend proxy so the frontend
	// server stays the browser-facing entry point while preserving session-cookie
	// authentication for both HTTP requests and WebSocket upgrades.
	proxyHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Host = backendURL.Host
		proxy.ServeHTTP(w, r)
	})

	mux.Handle("/api/", proxyHandler)
	mux.Handle("/ws", proxyHandler)

	/*-----------------------------
	  SPA Catch-all
	-----------------------------*/
	// Serve immutable Vite output and fall back to its shell for client routes.
	const spaRoot = "./SPA/dist"
	spaFileServer := NewCustomFileServer(http.Dir(spaRoot), filepath.Join(spaRoot, "index.html"))

	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setNoStoreHeaders(w)
		spaFileServer.ServeHTTP(w, r)
	}))

	return SecurityHeaders(mux)
}

// setNoStoreHeaders prevents browsers from caching the SPA shell so auth-gated
// routes always revalidate through the frontend server.
func setNoStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}
