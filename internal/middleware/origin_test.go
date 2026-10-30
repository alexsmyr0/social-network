package middleware

import (
	"net/http/httptest"
	"testing"
)

func TestBrowserOriginAllowed(t *testing.T) {
	for _, tc := range []struct {
		name, origin, referer, configured string
		fallback                          bool
		want                              bool
	}{
		{"exact origin", "https://social.example", "", "https://social.example", false, true},
		{"effective default port", "https://social.example:443", "", "https://social.example", false, true},
		{"normalized numeric port", "https://social.example:0443", "", "https://social.example", false, true},
		{"wrong port", "https://social.example:444", "", "https://social.example", false, false},
		{"wrong scheme", "http://social.example", "", "https://social.example", false, false},
		{"referer fallback", "", "https://social.example/register", "https://social.example", true, true},
		{"no websocket fallback", "", "https://social.example/register", "https://social.example", false, false},
		{"bad origin never falls back", "null", "https://social.example/register", "https://social.example", true, false},
		{"origin path rejected", "https://social.example/register", "", "https://social.example", false, false},
		{"userinfo rejected", "https://attacker@social.example", "", "https://social.example", false, false},
		{"loopback IPv4 alias", "http://127.0.0.1:3000", "", "http://localhost:3000", false, true},
		{"loopback IPv6 alias", "http://[::1]:3000", "", "http://localhost:3000", false, true},
		{"loopback alias referer", "", "http://127.0.0.1:3000/register", "http://localhost:3000", true, true},
		{"localhost for loopback IP", "http://localhost:3000", "", "http://127.0.0.1:3000", false, true},
		{"loopback alias wrong port", "http://127.0.0.1:3001", "", "http://localhost:3000", false, false},
		{"loopback alias wrong scheme", "https://127.0.0.1:3000", "", "http://localhost:3000", false, false},
		{"LAN address is not loopback", "http://192.168.1.20:3000", "", "http://localhost:3000", false, false},
		{"loopback never admits a public origin", "https://social.example", "", "http://localhost:3000", false, false},
		{"public origin never admits loopback", "https://127.0.0.1", "", "https://social.example", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://backend.example/api/v1/users/login", nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				req.Header.Set("Referer", tc.referer)
			}
			if got := BrowserOriginAllowed(req, tc.configured, tc.fallback); got != tc.want {
				t.Fatalf("BrowserOriginAllowed = %v, want %v", got, tc.want)
			}
		})
	}
}
