package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSPARouting(t *testing.T) {
	requireLocalTCPListener(t)

	// Setup test directories and files in a temporary workspace
	tmpDir, err := os.MkdirTemp("", "frontend-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	spaDir := filepath.Join(tmpDir, "SPA")
	staticDir := filepath.Join(tmpDir, "web/static")
	errorDir := filepath.Join(tmpDir, "web/errors")
	os.MkdirAll(spaDir, 0755)
	os.MkdirAll(staticDir, 0755)
	os.MkdirAll(errorDir, 0755)

	indexContent := "<html>SPA Shell</html>"
	os.WriteFile(filepath.Join(spaDir, "index.html"), []byte(indexContent), 0644)
	jsContent := "console.log('hi');"
	os.WriteFile(filepath.Join(spaDir, "main.js"), []byte(jsContent), 0644)
	faviconContent := "fake-favicon"
	os.WriteFile(filepath.Join(staticDir, "favicon.ico"), []byte(faviconContent), 0644)

	// Mock backend for proxy testing
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer backend.Close()

	// Redirect NewMux to use our mock backend
	oldBackendURL := backendBaseURL
	backendBaseURL = backend.URL
	defer func() { backendBaseURL = oldBackendURL }()

	// Change working directory so NewMux can find ./web/... and ./SPA
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(oldWD)

	// Now use the real Mux!
	mux := NewMux()

	tests := []struct {
		name                string
		path                string
		accept              string
		expectedStatus      int
		expectedContentType string
		expectedBody        string
	}{
		{
			name:                "Root",
			path:                "/",
			expectedStatus:      http.StatusOK,
			expectedContentType: "text/html; charset=utf-8",
			expectedBody:        indexContent,
		},
		{
			name:                "Existing JS",
			path:                "/main.js",
			expectedStatus:      http.StatusOK,
			expectedContentType: "text/javascript; charset=utf-8",
			expectedBody:        jsContent,
		},
		{
			name:                "SPA Deep Link",
			path:                "/login",
			expectedStatus:      http.StatusOK,
			expectedContentType: "text/html; charset=utf-8",
			expectedBody:        indexContent,
		},
		{
			name:                "SPA Deep Link with HTML accept",
			path:                "/posts/123",
			accept:              "text/html,application/xhtml+xml",
			expectedStatus:      http.StatusOK,
			expectedContentType: "text/html; charset=utf-8",
			expectedBody:        indexContent,
		},
		{
			name:                "API Proxy (Proxy gate check)",
			path:                "/api/v1/posts",
			expectedStatus:      http.StatusOK,
			expectedContentType: "application/json",
			expectedBody:        `{"status":"ok"}`,
		},
		{
			name:                "Favicon",
			path:                "/favicon.ico",
			expectedStatus:      http.StatusOK,
			expectedContentType: "icon",
			expectedBody:        faviconContent,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.path, nil)
			if tt.accept != "" {
				req.Header.Set("Accept", tt.accept)
			}
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if rr.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, rr.Code)
			}

			actualCT := rr.Header().Get("Content-Type")
			if tt.expectedContentType != "" && !strings.Contains(actualCT, tt.expectedContentType) {
				t.Errorf("expected Content-Type to contain %q, got %q", tt.expectedContentType, actualCT)
			}

			if tt.expectedBody != "" && rr.Body.String() != tt.expectedBody {
				t.Errorf("expected body %q, got %q", tt.expectedBody, rr.Body.String())
			}
		})
	}
}

func TestSecurityHeaders(t *testing.T) {
	requireLocalTCPListener(t)

	tmpDir, err := os.MkdirTemp("", "frontend-sec-headers-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	spaDir := filepath.Join(tmpDir, "SPA")
	staticDir := filepath.Join(tmpDir, "web/static")
	errorDir := filepath.Join(tmpDir, "web/errors")
	os.MkdirAll(spaDir, 0755)
	os.MkdirAll(staticDir, 0755)
	os.MkdirAll(errorDir, 0755)

	os.WriteFile(filepath.Join(spaDir, "index.html"), []byte("<html>SPA Shell</html>"), 0644)
	os.WriteFile(filepath.Join(spaDir, "main.js"), []byte("console.log('hi');"), 0644)
	os.WriteFile(filepath.Join(staticDir, "test.css"), []byte("body {}"), 0644)
	os.WriteFile(filepath.Join(staticDir, "favicon.ico"), []byte("fake-favicon"), 0644)
	os.WriteFile(filepath.Join(errorDir, "404.html"), []byte("404 Not Found"), 0644)

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	}))
	defer backend.Close()

	oldBackendURL := backendBaseURL
	backendBaseURL = backend.URL
	defer func() { backendBaseURL = oldBackendURL }()

	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(oldWD)

	mux := NewMux()

	expectedCSP := "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';"
	expectedXFO := "DENY"
	expectedXCTO := "nosniff"
	expectedRP := "strict-origin-when-cross-origin"

	paths := []string{
		"/",
		"/login",
		"/main.js",
		"/static/test.css",
		"/favicon.ico",
		"/errors/404.html",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest("GET", path, nil)
			rr := httptest.NewRecorder()
			mux.ServeHTTP(rr, req)

			if csp := rr.Header().Get("Content-Security-Policy"); csp != expectedCSP {
				t.Errorf("path %s: expected CSP %q, got %q", path, expectedCSP, csp)
			}
			if xfo := rr.Header().Get("X-Frame-Options"); xfo != expectedXFO {
				t.Errorf("path %s: expected X-Frame-Options %q, got %q", path, expectedXFO, xfo)
			}
			if xcto := rr.Header().Get("X-Content-Type-Options"); xcto != expectedXCTO {
				t.Errorf("path %s: expected X-Content-Type-Options %q, got %q", path, expectedXCTO, xcto)
			}
			if rp := rr.Header().Get("Referrer-Policy"); rp != expectedRP {
				t.Errorf("path %s: expected Referrer-Policy %q, got %q", path, expectedRP, rp)
			}
		})
	}
}
