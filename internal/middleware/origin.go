package middleware

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// BrowserOriginAllowed compares parsed scheme, host and effective port. A
// present Origin never falls back to Referer; WebSockets require Origin.
func BrowserOriginAllowed(r *http.Request, configured string, refererFallback bool) bool {
	allowed, ok := parseBrowserURL(configured, false)
	if !ok {
		return false
	}
	values := r.Header.Values("Origin")
	fromReferer := false
	if len(values) == 0 && refererFallback {
		values = r.Header.Values("Referer")
		fromReferer = true
	}
	if len(values) != 1 {
		return false
	}
	actual, ok := parseBrowserURL(values[0], fromReferer)
	return ok && strings.EqualFold(actual.Scheme, allowed.Scheme) &&
		strings.EqualFold(actual.Hostname(), allowed.Hostname()) &&
		effectivePort(actual) == effectivePort(allowed)
}

func parseBrowserURL(raw string, allowPath bool) (*url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.User != nil || u.Hostname() == "" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		return nil, false
	}
	if !allowPath && (u.Path != "" || u.RawQuery != "" || u.Fragment != "") {
		return nil, false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, false
		}
	}
	return u, true
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		n, _ := strconv.Atoi(port)
		return strconv.Itoa(n)
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}
