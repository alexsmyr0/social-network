package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMediaAliasesAlwaysProxyBeforeMuxCanonicalization(t *testing.T) {
	requireLocalTCPListener(t)
	original := backendBaseURL
	t.Cleanup(func() { backendBaseURL = original })
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "session_token=probe" {
			t.Error("cookie not preserved")
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(401)
		w.Write([]byte("backend auth"))
	}))
	defer backend.Close()
	backendBaseURL = backend.URL
	mux := NewMux()
	for _, path := range []string{"/static/uploads/probe.png", "/static/uploads/dm/probe.png", "/static/%75ploads/probe.png", "//static/uploads/probe.png", "/static/x/../uploads/probe.png", "/static/uploads/../favicon.ico", "/api/v1/media/%31", "/api/v1/media/../users/me"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Cookie", "session_token=probe")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		if rec.Code != 401 || rec.Body.String() != "backend auth" || rec.Header().Get("Location") != "" {
			t.Fatalf("raw static fallback %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
}
func TestPrivateStaticFSDeniesUploadsSymlinkAliasesAndDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "uploads"), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "uploads", "secret.png"), []byte("secret"), 0600)
	os.WriteFile(filepath.Join(root, "public.css"), []byte("safe"), 0600)
	for _, link := range []struct{ name, target string }{{"alias.png", "uploads/secret.png"}, {"aliasdir", "uploads"}, {"escape", "../"}} {
		if err := os.Symlink(link.target, filepath.Join(root, link.name)); err != nil {
			t.Fatal(err)
		}
	}
	fs := privateStaticFS{root: root}
	for _, path := range []string{"/uploads/secret.png", "/alias.png", "/aliasdir/secret.png", "/escape", "/", "/uploads", "/../outside"} {
		file, err := fs.Open(path)
		if err == nil {
			file.Close()
			t.Fatalf("static alias opened %s", path)
		}
	}
	file, err := fs.Open("/public.css")
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	for _, path := range []string{"/static/uploads/a.png", "/static/%75ploads/a.png", "/api/v1/media/1"} {
		if !sensitiveMediaPath(path) {
			t.Fatalf("unprotected %s", path)
		}
	}
	if sensitiveMediaPath("/static/public.css") || strings.Contains(root, "secret") {
		t.Fatal("unrelated asset intercepted")
	}
}
