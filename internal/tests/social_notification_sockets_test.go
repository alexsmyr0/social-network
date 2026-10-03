package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"forum/internal/db"
	"forum/internal/router"
	"forum/internal/ws"
	"github.com/gorilla/websocket"
)

type socialSocketProbe struct {
	conn   *websocket.Conn
	events chan string
}

func openSocialSocket(t *testing.T, srv *httptest.Server, token string) *socialSocketProbe {
	t.Helper()
	headers := http.Header{"Origin": {"http://localhost:3000"}, "Cookie": {"session_token=" + token}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", headers)
	if err != nil {
		t.Fatal(err)
	}
	probe := &socialSocketProbe{conn: conn, events: make(chan string, 64)}
	t.Cleanup(func() { conn.Close() })
	go func() {
		defer close(probe.events)
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var event map[string]json.RawMessage
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Error(err)
				return
			}
			var kind string
			if err := json.Unmarshal(event["type"], &kind); err != nil {
				t.Error(err)
				return
			}
			if kind == "presence.snapshot" || kind == "presence.update" {
				continue
			}
			if (kind == "notification.new" || kind == "social.invalidate") && len(event) != 1 {
				t.Errorf("protected payload in signal: %s", raw)
			}
			probe.events <- kind
		}
	}()
	return probe
}
func (p *socialSocketProbe) expect(t *testing.T, kinds ...string) {
	t.Helper()
	for _, kind := range kinds {
		select {
		case got, ok := <-p.events:
			if !ok || got != kind {
				t.Fatalf("socket event=%q open=%v want %s", got, ok, kind)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("socket waiting for %s", kind)
		}
	}
}
func (p *socialSocketProbe) silent(t *testing.T) {
	t.Helper()
	select {
	case got, ok := <-p.events:
		t.Fatalf("unexpected socket event=%s open=%v", got, ok)
	case <-time.After(100 * time.Millisecond):
	}
}
func (p *socialSocketProbe) closed(t *testing.T) {
	t.Helper()
	select {
	case got, ok := <-p.events:
		if ok {
			t.Fatalf("revoked socket delivered %s", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("revoked socket stayed open")
	}
}
func wireSocialSocketHooks(t *testing.T, hub *ws.Hub) {
	t.Helper()
	db.SetNotificationHook(hub.NotifyNotification)
	db.SetSocialInvalidationHook(hub.InvalidateSocial)
	t.Cleanup(func() { db.SetNotificationHook(nil); db.SetSocialInvalidationHook(nil) })
}
func socialUnread(t *testing.T, handler http.Handler, token string, want int) {
	t.Helper()
	rec := socialRequest(t, handler, "GET", "/api/v1/notifications", "", nil, token)
	assertSocialCode(t, rec, 200, "")
	var result struct {
		Data struct {
			Unread int `json:"unread_count"`
		}
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result.Data.Unread != want {
		t.Fatalf("unread=%d want %d err=%v body=%s", result.Data.Unread, want, err, rec.Body.String())
	}
}

func TestSocialNotificationSocketsDeliveryRecoveryAndRevocation(t *testing.T) {
	requireLocalTCPListener(t)
	handler, conn, hub := socialAPIWithHub(t)
	wireSocialSocketHooks(t, hub)
	owner := registerSocialUser(t, handler, "owner@example.com")
	sender := registerSocialUser(t, handler, "sender@example.com")
	observer := registerSocialUser(t, handler, "observer@example.com")
	secondRec := loginSocialUser(t, handler, "owner@example.com", "")
	assertSocialCode(t, secondRec, 200, "")
	ownerSecond := secondRec.Result().Cookies()[0].Value
	if _, err := db.ChangePrivacy(context.Background(), conn, 1, "private", 1); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()
	firstSocket := openSocialSocket(t, srv, owner)
	secondSocket := openSocialSocket(t, srv, ownerSecond)
	senderSocket := openSocialSocket(t, srv, sender)
	observerSocket := openSocialSocket(t, srv, observer)
	// Failure inside the notice write rolls back the follow and produces no frames.
	if _, err := conn.Exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	rec := socialRequest(t, handler, "POST", "/api/v1/follows", "application/json", []byte(`{"user_id":1}`), sender)
	assertSocialCode(t, rec, 500, "INTERNAL_SERVER_ERROR")
	firstSocket.silent(t)
	secondSocket.silent(t)
	senderSocket.silent(t)
	observerSocket.silent(t)
	if _, err := conn.Exec(`DROP TRIGGER fail_notice`); err != nil {
		t.Fatal(err)
	}
	// Hook checks persistence through a separate DB connection before enqueueing.
	db.SetNotificationHook(func(recipient int64) {
		var count int
		if err := conn.QueryRow(`SELECT COUNT(*) FROM notifications n JOIN follows f ON f.id=n.follow_id WHERE n.recipient_id=?`, recipient).Scan(&count); err != nil || count == 0 {
			t.Errorf("signal before commit: count=%d err=%v", count, err)
		}
		hub.NotifyNotification(recipient)
	})
	rec = socialRequest(t, handler, "POST", "/api/v1/follows", "application/json", []byte(`{"user_id":1}`), sender)
	assertSocialCode(t, rec, 201, "")
	var response struct{ Data db.Follow }
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	firstSocket.expect(t, "notification.new", "social.invalidate")
	secondSocket.expect(t, "notification.new", "social.invalidate")
	senderSocket.expect(t, "social.invalidate")
	observerSocket.silent(t)
	socialUnread(t, handler, owner, 1)
	socialUnread(t, handler, sender, 0)
	rec = socialRequest(t, handler, "POST", "/api/v1/follows", "application/json", []byte(`{"user_id":1}`), sender)
	assertSocialCode(t, rec, 200, "")
	firstSocket.silent(t)
	secondSocket.silent(t)
	senderSocket.silent(t)
	rec = socialRequest(t, handler, "PATCH", "/api/v1/notifications/read-all", "", nil, owner)
	assertSocialCode(t, rec, 204, "")
	firstSocket.expect(t, "social.invalidate")
	secondSocket.expect(t, "social.invalidate")
	senderSocket.silent(t)
	socialUnread(t, handler, ownerSecond, 0)
	rec = socialRequest(t, handler, "POST", "/api/v1/users/logout", "", nil, owner)
	assertSocialCode(t, rec, 200, "")
	firstSocket.closed(t)
	// A separate session still receives comment/reaction notifications and DM frames.
	db.SetNotificationHook(hub.NotifyNotification)
	if _, err := conn.Exec(`INSERT INTO posts(id,author_id,title,body) VALUES(81,1,'Kept post','body')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreateComment(context.Background(), conn, db.CreateCommentInput{PostID: 81, UserID: 2, Body: "Comment"}); err != nil {
		t.Fatal(err)
	}
	secondSocket.expect(t, "notification.new")
	if _, err := db.ToggleReaction(context.Background(), conn, 2, 81, 1, "post"); err != nil {
		t.Fatal(err)
	}
	secondSocket.expect(t, "notification.new")
	if _, err := conn.Exec(`INSERT INTO comments(id,post_id,user_id,body) VALUES(99,81,1,'Owner comment')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ToggleReaction(context.Background(), conn, 2, 99, 1, "comment"); err != nil {
		t.Fatal(err)
	}
	secondSocket.expect(t, "notification.new")
	if err := senderSocket.conn.WriteJSON(map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 1, "body": "Compatible message"}}); err != nil {
		t.Fatal(err)
	}
	senderSocket.expect(t, "dm.message")
	secondSocket.expect(t, "dm.message")
	socialUnread(t, handler, ownerSecond, 3)
	// Disconnect, then receive a new request while offline; REST is authoritative.
	secondSocket.conn.Close()
	secondSocket.closed(t)
	f, _, err := db.CreateFollow(context.Background(), conn, 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	observerSocket.expect(t, "social.invalidate")
	secondSocket = openSocialSocket(t, srv, ownerSecond)
	socialUnread(t, handler, ownerSecond, 4)
	// Reconnect does not replay events. Read state changes refresh both tabs.
	secondSocket.silent(t)
	var noticeID int64
	if err := conn.QueryRow(`SELECT id FROM notifications WHERE follow_id=?`, f.ID).Scan(&noticeID); err != nil {
		t.Fatal(err)
	}
	rec = socialRequest(t, handler, "PATCH", fmt.Sprintf("/api/v1/notifications/%d/read", noticeID), "", nil, ownerSecond)
	assertSocialCode(t, rec, 204, "")
	secondSocket.expect(t, "social.invalidate")
	socialUnread(t, handler, ownerSecond, 3)
	// Auto-accept reconciliation commits before the global privacy invalidation.
	change, err := db.ChangePrivacy(context.Background(), conn, 1, "public", 2)
	if err != nil || !change.Changed {
		t.Fatal(change, err)
	}
	secondSocket.expect(t, "social.invalidate")
	senderSocket.expect(t, "social.invalidate")
	observerSocket.expect(t, "social.invalidate")
	page, err := db.ListSocialNotifications(context.Background(), conn, 1, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range page.Notifications {
		if n.Type == "follow_request" && (n.Target.State != "accepted" || len(n.Actions) != 0 || !n.IsRead) {
			t.Fatal("auto-accept left actionable notice", n)
		}
	}
	// An idle token revoked outside HTTP must not receive queued outbound work.
	if _, err := conn.Exec(`UPDATE sessions SET is_valid=0 WHERE token=?`, observer); err != nil {
		t.Fatal(err)
	}
	hub.InvalidateSocial([]int64{3})
	observerSocket.closed(t)
	// Restart backend and reopen persistent SQLite; session and unread state survive.
	secondSocket.conn.Close()
	senderSocket.conn.Close()
	secondSocket.closed(t)
	senderSocket.closed(t)
	srv.Close()
	var dbPath string
	if err := conn.QueryRow(`PRAGMA database_list`).Scan(new(int), new(string), &dbPath); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	reopened, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restartedHub := ws.NewHub()
	wireSocialSocketHooks(t, restartedHub)
	restarted := router.NewRouter(reopened, restartedHub)
	nextServer := httptest.NewServer(restarted)
	defer nextServer.Close()
	nextSocket := openSocialSocket(t, nextServer, ownerSecond)
	socialUnread(t, restarted, ownerSecond, 3)
	rec = socialRequest(t, restarted, "PATCH", "/api/v1/notifications/read-all", "", nil, ownerSecond)
	assertSocialCode(t, rec, 204, "")
	nextSocket.expect(t, "social.invalidate")
	socialUnread(t, restarted, ownerSecond, 0)
	// Inactive accounts also lose outbound access while their socket is idle.
	if _, err := reopened.Exec(`UPDATE users SET is_active=0 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	restartedHub.NotifyNotification(1)
	nextSocket.closed(t)
}
