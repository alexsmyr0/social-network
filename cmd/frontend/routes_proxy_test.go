package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestAPIProxyPreservesPathAndCookie verifies that the REST proxy still forwards
// the original request path and session cookie to the backend unchanged.
func TestAPIProxyPreservesPathAndCookie(t *testing.T) {
	requireLocalTCPListener(t)

	originalBackendURL := backendBaseURL
	defer func() {
		backendBaseURL = originalBackendURL
	}()

	var receivedPath string
	var receivedCookie string

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedCookie = r.Header.Get("Cookie")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("proxied"))
	}))
	defer backend.Close()

	backendBaseURL = backend.URL
	mux := NewMux()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Cookie", "session=abc123")
	res := httptest.NewRecorder()

	mux.ServeHTTP(res, req)

	if res.Code != http.StatusTeapot {
		t.Fatalf("expected status %d, got %d", http.StatusTeapot, res.Code)
	}

	if receivedPath != "/api/v1/users/me" {
		t.Fatalf("expected backend path /api/v1/users/me, got %q", receivedPath)
	}

	if !strings.Contains(receivedCookie, "session=abc123") {
		t.Fatalf("expected session cookie to be proxied, got %q", receivedCookie)
	}
}

// TestWebSocketProxyPreservesPathAndCookie verifies the D09-specific requirement
// that the frontend can proxy a WebSocket upgrade request to /ws without
// dropping the session cookie used for backend authentication.
func TestWebSocketProxyPreservesPathAndCookie(t *testing.T) {
	requireLocalTCPListener(t)

	originalBackendURL := backendBaseURL
	defer func() {
		backendBaseURL = originalBackendURL
	}()

	type proxiedRequest struct {
		path   string
		cookie string
	}

	backendSeen := make(chan proxiedRequest, 1)
	webSocketKey := "dGhlIHNhbXBsZSBub25jZQ=="

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
			return
		}

		backendSeen <- proxiedRequest{
			path:   r.URL.Path,
			cookie: r.Header.Get("Cookie"),
		}

		// A ResponseRecorder cannot exercise upgrade handling, so this test uses a
		// real server and writes a minimal valid 101 response on the hijacked
		// connection to confirm the proxy completed the handshake path.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "websocket hijacking unsupported", http.StatusInternalServerError)
			return
		}

		conn, rw, err := hijacker.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()

		_, _ = fmt.Fprintf(
			rw,
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",
			webSocketAcceptKey(webSocketKey),
		)
		_ = rw.Flush()
	}))
	defer backend.Close()

	backendBaseURL = backend.URL
	frontend := httptest.NewServer(NewMux())
	defer frontend.Close()

	frontendURL, err := url.Parse(frontend.URL)
	if err != nil {
		t.Fatalf("parse frontend url: %v", err)
	}

	conn, err := net.Dial("tcp", frontendURL.Host)
	if err != nil {
		t.Fatalf("dial frontend server: %v", err)
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

	// The raw HTTP request keeps this test focused on proxying the browser
	// upgrade handshake rather than on any later D04 chat-client behavior.
	_, err = fmt.Fprintf(
		conn,
		"GET /ws HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\nCookie: session=abc123\r\n\r\n",
		frontendURL.Host,
		webSocketKey,
	)
	if err != nil {
		t.Fatalf("write websocket upgrade request: %v", err)
	}

	res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatalf("read websocket upgrade response: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected status %d, got %d", http.StatusSwitchingProtocols, res.StatusCode)
	}

	select {
	case proxied := <-backendSeen:
		if proxied.path != "/ws" {
			t.Fatalf("expected backend path /ws, got %q", proxied.path)
		}

		if !strings.Contains(proxied.cookie, "session=abc123") {
			t.Fatalf("expected session cookie to be proxied, got %q", proxied.cookie)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for backend websocket request")
	}
}

// webSocketAcceptKey returns the RFC 6455 accept value for a client handshake
// key so the backend test server can complete a valid upgrade response.
func webSocketAcceptKey(clientKey string) string {
	hash := sha1.Sum([]byte(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(hash[:])
}
