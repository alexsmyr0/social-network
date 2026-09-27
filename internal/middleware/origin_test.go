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
