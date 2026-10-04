package tests

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"forum/internal/db"
)

// Sparse contract examples describe observable state. Expand their storage
// prerequisites explicitly; never use fixture responses as production handlers.
func seedNotificationContractState(t *testing.T, conn *sql.DB, c profileFixtureCase, clock string) int {
	t.Helper()
	var posts []struct {
		ID            int64
		Author        int64 `json:"author_id"`
		Status, Title string
	}
	if err := json.Unmarshal(c.State["posts"], &posts); len(c.State["posts"]) > 0 && err != nil {
		t.Fatal(err)
	}
	for _, p := range posts {
		if p.Title == "" {
			p.Title = "Fixture post"
		}
		if _, err := conn.Exec(`INSERT INTO posts(id,author_id,title,body,status) VALUES(?,?,?,'Fixture body',?)`, p.ID, p.Author, p.Title, p.Status); err != nil {
			t.Fatal(err)
		}
	}
	var notices []struct {
		ID        int64
		Type      string
		Created   string `json:"created_at"`
		Read      bool   `json:"is_read"`
		Recipient int64  `json:"recipient_id"`
		Actor     struct{ ID int64 }
		Target    db.NoticeTarget
	}
	if err := json.Unmarshal(c.State["notifications"], &notices); len(c.State["notifications"]) > 0 && err != nil {
		t.Fatal(err)
	}
	for _, n := range notices {
		recipient := n.Recipient
		if recipient == 0 {
			recipient = 42
		}
		if n.Target.Kind == "follow_request" && n.Target.State == "pending" {
			if _, err := conn.Exec(`INSERT INTO follows(id,follower_id,followed_id,state,created_at) VALUES(?,?,?,'pending',?) ON CONFLICT DO NOTHING`, *n.Target.FollowID, n.Actor.ID, recipient, clock); err != nil {
				t.Fatal(err)
			}
		}
		var state any
		if n.Target.Kind == "follow_request" {
			state = n.Target.State
		}
		if _, err := conn.Exec(`INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read) VALUES(?,?,?,?,?,?,?,?,?,?)`, n.ID, recipient, n.Actor.ID, n.Type, n.Target.PostID, n.Target.CommentID, n.Target.FollowID, state, n.Created, n.Read); err != nil {
			t.Fatal(err)
		}
	}
	var stored []struct {
		ID        int64
		Recipient int64 `json:"recipient_id"`
		Actor     int64 `json:"actor_id"`
		Post      int64 `json:"post_id"`
		Type      string
		Read      bool `json:"is_read"`
	}
	if err := json.Unmarshal(c.State["stored_notifications"], &stored); len(c.State["stored_notifications"]) > 0 && err != nil {
		t.Fatal(err)
	}
	for _, n := range stored {
		if n.Actor == 0 {
			n.Actor = 7
		}
		if n.Type == "" {
			n.Type = "post_like"
		}
		if _, err := conn.Exec(`INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,created_at,is_read) VALUES(?,?,?,?,?,?,?)`, n.ID, n.Recipient, n.Actor, n.Type, n.Post, clock, n.Read); err != nil {
			t.Fatal(err)
		}
	}
	if c.Name == "mark-all-preserves-hidden-read-state" {
		if _, err := conn.Exec(`INSERT INTO posts(id,author_id,title,body) VALUES(81,42,'Hidden','body'),(82,7,'Visible','body');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id) VALUES(601,99,7,'post_like',81),(701,99,7,'post_like',82)`); err != nil {
			t.Fatal(err)
		}
	}
	// A missing pending notice in a B11-only fixture is migration-backfilled state.
	if _, err := conn.Exec(`INSERT INTO sqlite_sequence(name,seq) SELECT 'notifications',500 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='notifications');
 UPDATE sqlite_sequence SET seq=MAX(seq,500) WHERE name='notifications';
 INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state,created_at)
 SELECT followed_id,follower_id,'follow_request',id,'pending',created_at FROM follows f WHERE state='pending'
 AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.follow_id=f.id)`); err != nil {
		t.Fatal(err)
	}
	if c.Name == "explicit-retry-after-decline-fresh-id" {
		if _, err := conn.Exec(`INSERT INTO notifications(id,recipient_id,actor_id,type,follow_id,follow_state,created_at,is_read) VALUES(501,42,7,'follow_request',201,'declined',?,1)`, clock); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestSocialNotificationValidationAndRecipientDenial(t *testing.T) {
	handler, conn := socialAPI(t)
	token := registerSocialUser(t, handler, "viewer@example.com")
	for _, tc := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/api/v1/notifications?per_page=51", "", 400, "BAD_REQUEST"},
		{"GET", "/api/v1/notifications?page=1&page=2", "", 400, "BAD_REQUEST"},
		{"GET", "/api/v1/notifications?recipient_id=42", "", 400, "BAD_REQUEST"},
		{"GET", "/api/v1/notifications", "{}", 400, "BAD_REQUEST"},
		{"PATCH", "/api/v1/notifications/read-all", "{}", 400, "BAD_REQUEST"},
		{"PATCH", "/api/v1/notifications/read-all?page=1", "", 400, "BAD_REQUEST"},
		{"PATCH", "/api/v1/notifications/+1/read", "", 400, "BAD_REQUEST"},
		{"PATCH", "/api/v1/notifications/9007199254740992/read", "", 400, "BAD_REQUEST"},
		{"PATCH", "/api/v1/notifications/1/extra/read", "", 404, "NOT_FOUND"},
		{"PATCH", "/api/v1/notifications/1/read", "", 404, "NOT_FOUND"},
	} {
		rec := socialRequest(t, handler, tc.method, tc.path, "", []byte(tc.body), token)
		assertSocialCode(t, rec, tc.status, tc.code)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("cacheable response")
		}
	}
	req := httptest.NewRequest("POST", "/api/v1/notifications/read-all", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, 405, "METHOD_NOT_ALLOWED")
	if rec.Header().Get("Allow") != "PATCH" {
		t.Fatal("wrong Allow")
	}
	assertSocialCode(t, socialRequest(t, handler, "GET", "/api/v1/notifications", "", nil, ""), 401, "UNAUTHORIZED")
	req = httptest.NewRequest("PATCH", "/api/v1/notifications/read-all", nil)
	req.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, 403, "ORIGIN_FORBIDDEN")
	req.Header.Set("Origin", "http://localhost:3000")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, 403, "CSRF_CHECK_FAILED")
	if _, err := conn.Exec(`UPDATE sessions SET is_valid=0 WHERE token=?`, token); err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1/notifications/read-all", "", nil, token), 401, "UNAUTHORIZED")
}
