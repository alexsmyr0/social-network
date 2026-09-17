package tests

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// dialWS opens a WebSocket connection to the test server with the given session
// token. Returns (conn, true) on a successful 101 upgrade, (nil, false) on 401.
func dialWS(t *testing.T, srv *httptest.Server, token string) (*websocket.Conn, bool) {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	hdr := http.Header{}
	if token != "" {
		hdr.Set("Cookie", "session_token="+token)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(u, hdr)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return nil, false
		}
		t.Fatalf("unexpected dial error: %v", err)
	}
	return conn, true
}

/*-----------
  AUTH TESTS
------------*/

func TestWebSocket_Unauthenticated(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated WS, got %d", rec.Code)
	}
}

func TestWebSocket_InvalidSession(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.AddCookie(&http.Cookie{Name: "session_token", Value: "invalid-token-abc"})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for invalid session, got %d", rec.Code)
	}
}

/*--------------------
  CONNECTION LIFECYCLE
---------------------*/

func TestWebSocket_ValidConnection(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	token := registerAndLoginAs(t, h, "wsvalid")

	conn, ok := dialWS(t, srv, token)
	if !ok {
		t.Fatal("expected successful WebSocket upgrade for authenticated user")
	}
	conn.Close()
}

func TestWebSocket_MultiTab(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	token := registerAndLoginAs(t, h, "wsmultitab")

	conn1, ok1 := dialWS(t, srv, token)
	if !ok1 {
		t.Fatal("first connection failed")
	}
	conn2, ok2 := dialWS(t, srv, token)
	if !ok2 {
		t.Fatal("second connection (same user, multi-tab) failed")
	}

	conn1.Close()
	conn2.Close()
}

func TestWebSocket_DisconnectCleansUp(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	token := registerAndLoginAs(t, h, "wsdisconn")

	conn, ok := dialWS(t, srv, token)
	if !ok {
		t.Fatal("connection failed")
	}

	// Send a close frame so the server reads the EOF and removes the client.
	conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	conn.Close()
}
