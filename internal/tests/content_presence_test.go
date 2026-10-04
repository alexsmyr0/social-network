package tests

import (
	"encoding/json"
	"fmt"
	"forum/internal/router"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSocialPresenceSnapshotsRefreshWithCurrentProfilePermission(t *testing.T) {
	requireLocalTCPListener(t)
	_, database, hub := socialAPIWithHub(t)
	handler := router.NewRouter(database, hub)
	wireSocialSocketHooks(t, hub)
	privateToken := registerSocialUser(t, handler, "private@presence.test")
	viewerToken := registerSocialUser(t, handler, "viewer@presence.test")
	assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1/users/me/privacy", "application/json", []byte(`{"visibility":"private","expected_version":1}`), privateToken), 200, "")
	srv := httptest.NewServer(handler)
	defer srv.Close()
	connect := func(token string) *websocket.Conn {
		t.Helper()
		h := http.Header{"Origin": {"http://localhost:3000"}, "Cookie": {"session_token=" + token}}
		c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", h)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	private := connect(privateToken)
	defer private.Close()
	viewer := connect(viewerToken)
	snapshot := func(wantPrivate bool) {
		t.Helper()
		viewer.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			_, raw, err := viewer.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var frame struct {
				Type    string
				Payload struct {
					Users []struct {
						ID int64 `json:"user_id"`
					}
				}
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				t.Fatal(err)
			}
			if frame.Type != "presence.snapshot" {
				continue
			}
			found := false
			for _, u := range frame.Payload.Users {
				if u.ID == 1 {
					found = true
				}
			}
			if found != wantPrivate {
				t.Fatalf("private presence exposed=%v want=%v snapshot=%s", found, wantPrivate, raw)
			}
			return
		}
	}
	snapshot(false)
	follow := socialRequest(t, handler, "POST", "/api/v1/follows", "application/json", []byte(`{"user_id":1}`), viewerToken)
	assertSocialCode(t, follow, 201, "")
	var result struct{ Data struct{ ID int64 } }
	json.Unmarshal(follow.Body.Bytes(), &result)
	snapshot(false)
	accept := socialRequest(t, handler, "PATCH", fmt.Sprintf("/api/v1/follow-requests/%d", result.Data.ID), "application/json", []byte(`{"decision":"accept"}`), privateToken)
	assertSocialCode(t, accept, 200, "")
	snapshot(true)
	remove := socialRequest(t, handler, "DELETE", fmt.Sprintf("/api/v1/follows/%d", result.Data.ID), "", nil, viewerToken)
	assertSocialCode(t, remove, 204, "")
	snapshot(false)
}
