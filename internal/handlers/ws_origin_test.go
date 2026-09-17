// internal/handlers/ws_origin_test.go
//
// #55 — WebSocket Origin gate. checkWSOrigin is defense-in-depth against CSWSH
// on top of SameSite=Lax + the in-handler session check.
package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func reqWithOrigin(host, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://"+host+"/ws", nil)
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func TestCheckWSOrigin(t *testing.T) {
	// Pin the configured frontend origin for the cross-origin case.
	t.Setenv("FRONTEND_URL", "http://localhost:3000")

	cases := []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{"absent origin (native client) allowed", "api.example.com", "", true},
		{"same-origin allowed", "api.example.com", "http://api.example.com", true},
		{"configured frontend origin allowed", "api.example.com", "http://localhost:3000", true},
		{"foreign origin rejected", "api.example.com", "http://evil.example.com", false},
		{"malformed origin rejected", "api.example.com", "://not a url", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkWSOrigin(reqWithOrigin(tc.host, tc.origin)); got != tc.want {
				t.Errorf("checkWSOrigin(host=%q, origin=%q) = %v, want %v", tc.host, tc.origin, got, tc.want)
			}
		})
	}
}

func TestAllowedWSOrigin_Default(t *testing.T) {
	t.Setenv("FRONTEND_URL", "")
	if got := allowedWSOrigin(); got != "http://localhost:3000" {
		t.Errorf("allowedWSOrigin() default = %q, want http://localhost:3000", got)
	}
}
