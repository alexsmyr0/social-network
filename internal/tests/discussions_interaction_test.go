package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"forum/internal/db"
	"forum/internal/router"
	"forum/internal/ws"
)

type signalLog struct {
	mu            sync.Mutex
	invalidations int
	notices       []int64
}

func recordSignals(t *testing.T) *signalLog {
	log := &signalLog{}
	db.SetSocialInvalidationHook(func([]int64) { log.mu.Lock(); log.invalidations++; log.mu.Unlock() })
	db.SetNotificationHook(func(id int64) { log.mu.Lock(); log.notices = append(log.notices, id); log.mu.Unlock() })
	t.Cleanup(func() { db.SetSocialInvalidationHook(nil); db.SetNotificationHook(nil) })
	return log
}
func (l *signalLog) counts() (int, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.invalidations, len(l.notices)
}

// threeUsers returns tokens for users 1 (post author), 2 and 3 plus public post 10.
func threeUsers(t *testing.T) (http.Handler, *sql.DB, [4]string) {
	t.Helper()
	handler, conn := socialAPI(t)
	var tokens [4]string
	for i := 1; i <= 3; i++ {
		tokens[i] = registerSocialUser(t, handler, fmt.Sprintf("user%d@interactions.test", i))
		fixtureExec(t, conn, `UPDATE users SET nickname=? WHERE id=?`, fmt.Sprintf("User %d", i), i)
	}
	fixtureExec(t, conn, `INSERT INTO posts(id,author_id,body,status)VALUES(10,1,'post','published');INSERT INTO posts(id,author_id,body,status)VALUES(11,1,'other post','published')`)
	return handler, conn, tokens
}

func commentID(t *testing.T, rec *httptest.ResponseRecorder) (int64, int64) {
	t.Helper()
	var out struct{ Data struct{ ID, Version int64 } }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, rec.Body.String())
	}
	return out.Data.ID, out.Data.Version
}

func count(t *testing.T, conn *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDiscussionCommentLifecycleOwnershipAndVersions(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	signals := recordSignals(t)
	call := func(token, method, path, body string) *httptest.ResponseRecorder {
		contentType := ""
		if body != "" {
			contentType = "application/json"
		}
		return socialRequest(t, handler, method, "/api/v1"+path, contentType, []byte(body), token)
	}
	top := call(tok[2], "POST", "/posts/10/comments", `{"body":"  first\r\nline  "}`)
	assertSocialCode(t, top, 201, "")
	parent, version := commentID(t, top)
	if version != 1 || !strings.Contains(top.Body.String(), `"parent_comment_id":null`) || !strings.Contains(top.Body.String(), `"body":"first\nline"`) {
		t.Fatalf("created comment shape: %s", top.Body.String())
	}
	if invalidations, notices := signals.counts(); invalidations != 1 || notices != 1 {
		t.Fatalf("create signals: invalidations=%d notices=%d", invalidations, notices)
	}
	reply := call(tok[3], "POST", "/posts/10/comments", fmt.Sprintf(`{"body":"reply","parent_comment_id":%d}`, parent))
	assertSocialCode(t, reply, 201, "")
	child, _ := commentID(t, reply)
	// Parent validation: other post, missing, inactive commenter.
	for _, body := range []string{fmt.Sprintf(`{"body":"x","parent_comment_id":%d}`, parent), `{"body":"x","parent_comment_id":999}`} {
		path := "/posts/11/comments"
		if strings.Contains(body, "999") {
			path = "/posts/10/comments"
		}
		assertSocialCode(t, call(tok[3], "POST", path, body), 404, "NOT_FOUND")
	}
	fixtureExec(t, conn, `UPDATE users SET is_active=0 WHERE id=2`)
	assertSocialCode(t, call(tok[3], "POST", "/posts/10/comments", fmt.Sprintf(`{"body":"x","parent_comment_id":%d}`, parent)), 404, "")
	thread := call(tok[1], "GET", "/posts/10/comments", "")
	if strings.Contains(thread.Body.String(), `"first`) || total(t, map[string]any{"meta": jsonMap(t, thread)["meta"]}) != 1 {
		t.Fatalf("inactive commenter stays in thread: %s", thread.Body.String())
	}
	fixtureExec(t, conn, `UPDATE users SET is_active=1 WHERE id=2`)
	// Ownership: post owner and other users can neither edit nor delete.
	for _, actor := range []int{1, 3} {
		assertSocialCode(t, call(tok[actor], "PATCH", fmt.Sprintf("/comments/%d", parent), `{"expected_version":1,"body":"nope"}`), 404, "")
		assertSocialCode(t, call(tok[actor], "DELETE", fmt.Sprintf("/comments/%d?expected_version=1", parent), ""), 404, "")
	}
	// Version rules: edit, stale conflict (after access), exact no-op.
	invalidationsBefore, _ := signals.counts()
	edit := call(tok[2], "PATCH", fmt.Sprintf("/comments/%d", parent), `{"expected_version":1,"body":"edited"}`)
	assertSocialCode(t, edit, 200, "")
	if _, v := commentID(t, edit); v != 2 {
		t.Fatalf("edit version %d", v)
	}
	stale := call(tok[2], "PATCH", fmt.Sprintf("/comments/%d", parent), `{"expected_version":1,"body":"again"}`)
	assertSocialCode(t, stale, 409, "STALE_CONTENT")
	if !strings.Contains(stale.Body.String(), `"message":"Content changed; refresh and retry"`) || strings.Contains(stale.Body.String(), "edited") {
		t.Fatalf("conflict must carry the exact message and no content: %s", stale.Body.String())
	}
	if after, _ := signals.counts(); after != invalidationsBefore+1 {
		t.Fatalf("effective edit should signal once, saw %d", after-invalidationsBefore)
	}
	noop := call(tok[2], "PATCH", fmt.Sprintf("/comments/%d", parent), `{"expected_version":2,"body":" edited "}`)
	assertSocialCode(t, noop, 200, "")
	if _, v := commentID(t, noop); v != 2 {
		t.Fatalf("no-op advanced version to %d", v)
	}
	if after, _ := signals.counts(); after != invalidationsBefore+1 {
		t.Fatal("no-op emitted a signal")
	}
	// Content completeness and strict input.
	assertSocialCode(t, call(tok[2], "PATCH", fmt.Sprintf("/comments/%d", parent), `{"expected_version":2,"body":"  "}`), 400, "CONTENT_REQUIRED")
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"empty create", `{}`, 400, "CONTENT_REQUIRED"},
		{"null body", `{"body":null}`, 400, "BAD_REQUEST"},
		{"too long", `{"body":"` + strings.Repeat("🙂", 10001) + `"}`, 400, "TOO_LONG"},
		{"max length", `{"body":"` + strings.Repeat("🙂", 10000) + `"}`, 201, ""},
		{"control", `{"body":"a\u0007b"}`, 400, "INVALID_TEXT"},
		{"lone carriage return", `{"body":"a\rb"}`, 400, "INVALID_TEXT"},
		{"unknown key", `{"body":"x","user_id":3}`, 400, "BAD_REQUEST"},
		{"repeated key", `{"body":"x","body":"y"}`, 400, "BAD_REQUEST"},
		{"parent string", `{"body":"x","parent_comment_id":"1"}`, 400, "BAD_REQUEST"},
		{"parent zero", `{"body":"x","parent_comment_id":0}`, 400, "BAD_REQUEST"},
		{"remote image", `{"body":"x","image_url":"https://example.test/a.png"}`, 404, "NOT_FOUND"},
		{"invalid UTF-8", string([]byte{'{', '"', 'b', 'o', 'd', 'y', '"', ':', '"', 0xff, '"', '}'}), 400, "BAD_REQUEST"},
		{"array", `[]`, 400, "BAD_REQUEST"},
	} {
		if rec := call(tok[3], "POST", "/posts/10/comments", tc.body); rec.Code != tc.status || !strings.Contains(rec.Body.String(), tc.code) {
			t.Errorf("%s: %d %.200s", tc.name, rec.Code, rec.Body.String())
		}
	}
	for _, tc := range []struct {
		name, body string
		code       string
	}{
		{"missing version", `{"body":"x"}`, "BAD_REQUEST"},
		{"string version", `{"expected_version":"2","body":"x"}`, "BAD_REQUEST"},
		{"fraction version", `{"expected_version":2.0,"body":"x"}`, "BAD_REQUEST"},
		{"zero version", `{"expected_version":0,"body":"x"}`, "BAD_REQUEST"},
		{"no change field", `{"expected_version":2}`, "BAD_REQUEST"},
		{"parent reassignment", `{"expected_version":2,"parent_comment_id":null}`, "BAD_REQUEST"},
		{"post reassignment", `{"expected_version":2,"post_id":11}`, "BAD_REQUEST"},
		{"remote image", `{"expected_version":2,"image_url":"https://example.test/a.png"}`, "NOT_FOUND"},
	} {
		if rec := call(tok[2], "PATCH", fmt.Sprintf("/comments/%d", parent), tc.body); !strings.Contains(rec.Body.String(), tc.code) || rec.Code < 400 {
			t.Errorf("edit %s: %d %.200s", tc.name, rec.Code, rec.Body.String())
		}
	}
	oversized := call(tok[2], "POST", "/posts/10/comments", `{"body":"`+strings.Repeat("a", 70000)+`"}`)
	assertSocialCode(t, oversized, 413, "PAYLOAD_TOO_LARGE")
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "text/plain", []byte("x"), tok[2]), 415, "")
	// Delete needs the exact version; descendants, reactions and notices cascade.
	assertSocialCode(t, call(tok[3], "POST", fmt.Sprintf("/comments/%d/like", parent), ""), 200, "")
	assertSocialCode(t, call(tok[2], "DELETE", fmt.Sprintf("/comments/%d", parent), ""), 400, "BAD_REQUEST")
	assertSocialCode(t, call(tok[2], "DELETE", fmt.Sprintf("/comments/%d?expected_version=1", parent), ""), 409, "STALE_CONTENT")
	assertSocialCode(t, call(tok[2], "DELETE", fmt.Sprintf("/comments/%d?expected_version=2", parent), ""), 204, "")
	if count(t, conn, `SELECT COUNT(*) FROM comments WHERE id IN (?,?)`, parent, child) != 0 || count(t, conn, `SELECT COUNT(*) FROM reactions WHERE comment_id IS NOT NULL`) != 0 || count(t, conn, `SELECT COUNT(*) FROM notifications WHERE comment_id=?`, parent) != 0 {
		t.Fatal("deleting a comment left descendants, reactions or notices")
	}
	assertSocialCode(t, call(tok[2], "GET", fmt.Sprintf("/comments/%d", parent), ""), 404, "")
}

func jsonMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func discussionMultipart(t *testing.T, handler http.Handler, token, method, path string, fields map[string]string, image []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for key, value := range fields {
		form.WriteField(key, value)
	}
	if image != nil {
		name := "image.png"
		if bytes.HasPrefix(image, []byte("GIF8")) {
			name = "image.gif"
		}
		part, _ := form.CreateFormFile("image", name)
		part.Write(image)
	}
	form.Close()
	return socialRequest(t, handler, method, "/api/v1"+path, form.FormDataContentType(), body.Bytes(), token)
}

func TestDiscussionImageOnlyCommentsReplacementAndCleanup(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	gif, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.gif")
	if err != nil {
		t.Skip("no gif fixture")
	}
	made := discussionMultipart(t, handler, tok[2], "POST", "/posts/10/comments", map[string]string{"body": ""}, png)
	assertSocialCode(t, made, 201, "")
	id, _ := commentID(t, made)
	data := jsonMap(t, made)["data"].(map[string]any)
	url := data["image_url"].(string)
	if data["body"] != "" || !db.IsPrivateMediaURL(url) {
		t.Fatalf("image-only comment: %v", data)
	}
	if rec := socialRequest(t, handler, "GET", url, "", nil, tok[3]); rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), png) {
		t.Fatalf("attachment bytes %d", rec.Code)
	}
	path := fmt.Sprintf("/comments/%d", id)
	// Removing the only content fails and preserves the image; invalid replacement too.
	assertSocialCode(t, discussionMultipart(t, handler, tok[2], "PATCH", path, map[string]string{"expected_version": "1", "remove_image": "true"}, nil), 400, "CONTENT_REQUIRED")
	assertSocialCode(t, discussionMultipart(t, handler, tok[2], "PATCH", path, map[string]string{"expected_version": "1"}, []byte("not an image")), 422, "INVALID_IMAGE")
	assertSocialCode(t, discussionMultipart(t, handler, tok[2], "PATCH", path, map[string]string{"expected_version": "1", "remove_image": "true"}, png), 400, "BAD_REQUEST")
	if rec := socialRequest(t, handler, "GET", url, "", nil, tok[3]); rec.Code != 200 {
		t.Fatal("failed edits lost the original attachment")
	}
	// A stale replacement leaves no orphan staging or bytes behind.
	objects := count(t, conn, `SELECT COUNT(*) FROM media_objects`)
	assertSocialCode(t, discussionMultipart(t, handler, tok[2], "PATCH", path, map[string]string{"expected_version": "9"}, gif), 409, "STALE_CONTENT")
	if count(t, conn, `SELECT COUNT(*) FROM media_objects`) != objects || count(t, conn, `SELECT COUNT(*) FROM media_pending`) != 0 {
		t.Fatal("stale replacement leaked staged media")
	}
	// Replacement swaps the attachment and sweeps the old bytes after commit.
	replaced := discussionMultipart(t, handler, tok[2], "PATCH", path, map[string]string{"expected_version": "1"}, gif)
	assertSocialCode(t, replaced, 200, "")
	newURL := jsonMap(t, replaced)["data"].(map[string]any)["image_url"].(string)
	if newURL == url || socialRequest(t, handler, "GET", url, "", nil, tok[2]).Code != 404 || socialRequest(t, handler, "GET", newURL, "", nil, tok[2]).Code != 200 {
		t.Fatalf("replacement did not swap attachments: %s -> %s", url, newURL)
	}
	if count(t, conn, `SELECT COUNT(*) FROM media_objects`) != objects {
		t.Fatal("old attachment object was not removed")
	}
	// Retaining the same URL is a no-op; text plus removal succeeds and removes the object.
	retained := socialRequest(t, handler, "PATCH", "/api/v1"+path, "application/json", []byte(fmt.Sprintf(`{"expected_version":2,"image_url":%q}`, newURL)), tok[2])
	assertSocialCode(t, retained, 200, "")
	if jsonMap(t, retained)["data"].(map[string]any)["version"].(float64) != 2 {
		t.Fatal("retaining the same attachment changed the version")
	}
	assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1"+path, "application/json", []byte(`{"expected_version":2,"body":"now text","image_url":null}`), tok[2]), 200, "")
	if count(t, conn, `SELECT COUNT(*) FROM media_objects`) != objects-1 || socialRequest(t, handler, "GET", newURL, "", nil, tok[2]).Code != 404 {
		t.Fatal("removed attachment survived")
	}
	// Another resource's attachment can never be adopted by URL.
	other := discussionMultipart(t, handler, tok[3], "POST", "/posts/10/comments", map[string]string{"body": ""}, png)
	assertSocialCode(t, other, 201, "")
	foreignURL := jsonMap(t, other)["data"].(map[string]any)["image_url"].(string)
	assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1"+path, "application/json", []byte(fmt.Sprintf(`{"expected_version":3,"image_url":%q}`, foreignURL)), tok[2]), 404, "")
	// Deleting the comment sweeps its remaining attachment.
	otherID, _ := commentID(t, other)
	assertSocialCode(t, socialRequest(t, handler, "DELETE", fmt.Sprintf("/api/v1/comments/%d?expected_version=1", otherID), "", nil, tok[3]), 204, "")
	if socialRequest(t, handler, "GET", foreignURL, "", nil, tok[3]).Code != 404 || count(t, conn, `SELECT COUNT(*) FROM media_objects`) != objects-1 {
		t.Fatal("deleted comment's attachment survived")
	}
}

func TestDiscussionReactionsNoticesAndExcerpts(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	signals := recordSignals(t)
	call := func(token, method, path string) *httptest.ResponseRecorder {
		return socialRequest(t, handler, method, "/api/v1"+path, "", nil, token)
	}
	reaction := func(rec *httptest.ResponseRecorder, want int, likes, dislikes float64) {
		t.Helper()
		assertSocialCode(t, rec, 200, "")
		data := jsonMap(t, rec)["data"].(map[string]any)
		if data["reaction"].(float64) != float64(want) || data["likes_count"] != likes || data["dislikes_count"] != dislikes {
			t.Fatalf("reaction state %v, want %d/%v/%v", data, want, likes, dislikes)
		}
	}
	reaction(call(tok[2], "POST", "/posts/10/like"), 1, 1, 0)
	reaction(call(tok[2], "POST", "/posts/10/like"), 0, 0, 0)
	reaction(call(tok[2], "POST", "/posts/10/like"), 1, 1, 0)
	reaction(call(tok[3], "POST", "/posts/10/dislike"), -1, 1, 1)
	reaction(call(tok[2], "POST", "/posts/10/dislike"), -1, 0, 2)
	// Dedup: the like→remove→like sequence keeps one durable like notice for the author.
	if count(t, conn, `SELECT COUNT(*) FROM notifications WHERE recipient_id=1 AND actor_id=2 AND type='post_like'`) != 1 {
		t.Fatal("repeated like produced duplicate notices")
	}
	if _, notices := signals.counts(); notices != 3 {
		t.Fatalf("new-notice frames %d, want like + switch-to-dislike + user 3 dislike only", notices)
	}
	// Self reactions and self comments create no notice.
	before := count(t, conn, `SELECT COUNT(*) FROM notifications`)
	reaction(call(tok[1], "POST", "/posts/10/like"), 1, 1, 2)
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(`{"body":"mine"}`), tok[1]), 201, "")
	if count(t, conn, `SELECT COUNT(*) FROM notifications`) != before {
		t.Fatal("self action created a notice")
	}
	// A comment like produces an excerpt capped at 20 code points; image-only is "".
	long := strings.Repeat("é", 30)
	made := socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(`{"body":"`+long+`"}`), tok[2])
	cid, _ := commentID(t, made)
	reaction(call(tok[3], "POST", fmt.Sprintf("/comments/%d/like", cid)), 1, 1, 0)
	notices := jsonMap(t, call(tok[2], "GET", "/notifications"))["data"].(map[string]any)["notifications"].([]any)
	found := false
	for _, raw := range notices {
		target := raw.(map[string]any)["target"].(map[string]any)
		if target["kind"] == "comment" {
			found = true
			if target["excerpt"] != strings.Repeat("é", 20) || target["title"] != nil {
				t.Fatalf("comment notice target %v", target)
			}
		}
	}
	if !found {
		t.Fatal("comment reaction notice missing")
	}
	// Non-numeric, repeated and body-carrying reaction requests are rejected.
	assertSocialCode(t, call(tok[2], "POST", "/posts/abc/like"), 400, "")
	assertSocialCode(t, call(tok[2], "POST", "/posts/10/like?x=1"), 400, "")
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/like", "application/json", []byte(`{}`), tok[2]), 400, "")
	assertSocialCode(t, call(tok[2], "POST", "/posts/999/like"), 404, "")
	assertSocialCode(t, call(tok[2], "POST", "/comments/999/like"), 404, "")
	// Deleting the target removes its reaction notices.
	assertSocialCode(t, socialRequest(t, handler, "DELETE", fmt.Sprintf("/api/v1/comments/%d?expected_version=1", cid), "", nil, tok[2]), 204, "")
	if count(t, conn, `SELECT COUNT(*) FROM notifications WHERE comment_id=?`, cid) != 0 {
		t.Fatal("comment notice outlived its comment")
	}
}

// Losing access after a request passed its early guard must not commit anything:
// a writer holding SQLite's social write lock removes access, the request waits,
// then re-checks under the lock.
func TestDiscussionConcurrentPermissionLossCommitsNothing(t *testing.T) {
	losses := map[string]string{
		"unfollow":          `DELETE FROM follows WHERE follower_id=3 AND followed_id=1`,
		"unpublish":         `UPDATE posts SET status='draft' WHERE id=10`,
		"audience selected": `UPDATE posts SET audience='selected' WHERE id=10`,
		"owner private":     `UPDATE users SET profile_visibility='private' WHERE id=1; DELETE FROM follows WHERE follower_id=3 AND followed_id=1`,
	}
	for name, loss := range losses {
		for _, action := range []struct{ method, path, body string }{
			{"POST", "/posts/10/comments", `{"body":"late"}`},
			{"POST", "/posts/10/like", ""},
			{"POST", "/comments/20/dislike", ""},
			{"PATCH", "/comments/21", `{"expected_version":1,"body":"late edit"}`},
			{"DELETE", "/comments/21?expected_version=1", ""},
		} {
			t.Run(name+" "+action.method+" "+action.path, func(t *testing.T) {
				handler, conn, tok := threeUsers(t)
				fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(3,1,'accepted','2000-01-01');UPDATE posts SET audience='followers';
 INSERT INTO comments(id,post_id,user_id,body)VALUES(20,10,1,'by owner'),(21,10,3,'by follower')`)
				signals := recordSignals(t)
				before := publishingStateSnapshot(t, conn)
				lock, err := db.BeginSocialWrite(context.Background(), conn)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := lock.Exec(loss); err != nil {
					t.Fatal(err)
				}
				done := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					contentType := ""
					if action.body != "" {
						contentType = "application/json"
					}
					done <- socialRequest(t, handler, action.method, "/api/v1"+action.path, contentType, []byte(action.body), tok[3])
				}()
				time.Sleep(200 * time.Millisecond)
				select {
				case rec := <-done:
					t.Fatalf("request finished while the write lock was held: %d", rec.Code)
				default:
				}
				if err := lock.Commit(); err != nil {
					t.Fatal(err)
				}
				rec := <-done
				if rec.Code != 404 {
					t.Fatalf("%d %s, want 404 after permission loss", rec.Code, rec.Body.String())
				}
				after := publishingStateSnapshot(t, conn)
				for _, table := range []string{"comments", "reactions", "notifications", "media_objects"} {
					if before[table] != after[table] {
						t.Fatalf("%s changed after permission loss", table)
					}
				}
				if invalidations, notices := signals.counts(); invalidations != 0 || notices != 0 {
					t.Fatalf("rejected write signalled: %d/%d", invalidations, notices)
				}
			})
		}
	}
}

// Parallel writers race an unfollow: every committed row must correspond to a
// successful response, and nothing succeeds once the unfollow has returned.
func TestDiscussionParallelWritersAgainstUnfollow(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(3,1,'accepted','2000-01-01');UPDATE posts SET audience='followers'`)
	var followID int64
	conn.QueryRow(`SELECT id FROM follows WHERE follower_id=3`).Scan(&followID)
	var mu sync.Mutex
	created := 0
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var rec *httptest.ResponseRecorder
			if i%2 == 0 {
				rec = socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(fmt.Sprintf(`{"body":"parallel %d"}`, i)), tok[3])
			} else {
				rec = socialRequest(t, handler, "POST", "/api/v1/posts/10/like", "", nil, tok[3])
			}
			if rec.Code != 200 && rec.Code != 201 && rec.Code != 404 && rec.Code != 503 {
				t.Errorf("unexpected %d %s", rec.Code, rec.Body.String())
			}
			if rec.Code == 201 {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}(i)
		if i == 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				assertSocialCode(t, socialRequest(t, handler, "DELETE", fmt.Sprintf("/api/v1/follows/%d", followID), "", nil, tok[3]), 204, "")
			}()
		}
	}
	wg.Wait()
	if got := count(t, conn, `SELECT COUNT(*) FROM comments WHERE user_id=3`); got != created {
		t.Fatalf("%d comments committed for %d successful responses", got, created)
	}
	// After the unfollow every attempt is rejected and the rows stay put.
	rows := count(t, conn, `SELECT (SELECT COUNT(*) FROM comments)+(SELECT COUNT(*) FROM reactions)+(SELECT COUNT(*) FROM notifications)`)
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(`{"body":"after"}`), tok[3]), 404, "")
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/like", "", nil, tok[3]), 404, "")
	if count(t, conn, `SELECT (SELECT COUNT(*) FROM comments)+(SELECT COUNT(*) FROM reactions)+(SELECT COUNT(*) FROM notifications)`) != rows {
		t.Fatal("write committed after the unfollow returned")
	}
}

// Comments, versions, reactions, notices and attachment bytes survive a restart,
// and repeated startup neither sweeps live comment media nor rewrites content.
func TestDiscussionStateSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "restart.db")
	open := func() (http.Handler, *sql.DB) {
		conn, err := db.InitDB(context.Background(), path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return router.NewRouter(conn, ws.NewHub()), conn
	}
	handler, conn := open()
	owner := registerSocialUser(t, handler, "owner@restart.test")
	member := registerSocialUser(t, handler, "member@restart.test")
	fixtureExec(t, conn, `INSERT INTO posts(id,author_id,title,body,status)VALUES(10,1,'untitled?','body','published');UPDATE posts SET title=NULL WHERE id=10`)
	png, _ := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	made := discussionMultipart(t, handler, member, "POST", "/posts/10/comments", map[string]string{"body": ""}, png)
	assertSocialCode(t, made, 201, "")
	id, _ := commentID(t, made)
	url := jsonMap(t, made)["data"].(map[string]any)["image_url"].(string)
	assertSocialCode(t, socialRequest(t, handler, "PATCH", fmt.Sprintf("/api/v1/comments/%d", id), "application/json", []byte(`{"expected_version":1,"body":"edited"}`), member), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "POST", fmt.Sprintf("/api/v1/comments/%d/like", id), "", nil, owner), 200, "")
	conn.Close()
	for round := 0; round < 2; round++ {
		handler, conn = open()
		got := socialRequest(t, handler, "GET", fmt.Sprintf("/api/v1/comments/%d", id), "", nil, member)
		assertSocialCode(t, got, 200, "")
		data := jsonMap(t, got)["data"].(map[string]any)
		if data["version"].(float64) != 2 || data["body"] != "edited" || data["likes"].(float64) != 1 || data["image_url"] != url {
			t.Fatalf("restart %d lost comment state: %v", round, data)
		}
		if rec := socialRequest(t, handler, "GET", url, "", nil, owner); rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), png) {
			t.Fatalf("restart %d lost attachment bytes: %d", round, rec.Code)
		}
		notices := jsonMap(t, socialRequest(t, handler, "GET", "/api/v1/notifications", "", nil, member))["data"].(map[string]any)["notifications"].([]any)
		if len(notices) != 1 || notices[0].(map[string]any)["target"].(map[string]any)["title"] != nil {
			t.Fatalf("restart %d notices: %v", round, notices)
		}
		conn.Close()
	}
}

func TestDiscussionStrictRoutesMethodsAndQueries(t *testing.T) {
	handler, _, tok := threeUsers(t)
	for _, tc := range []struct{ method, path, allow string }{
		{"PUT", "/comments/1", "GET, PATCH, DELETE"},
		{"DELETE", "/posts/10/comments", "GET, POST"},
		{"GET", "/posts/10/like", "POST"},
		{"POST", "/posts/10/nav", "GET"},
		{"POST", "/posts/liked", "GET"},
		{"PATCH", "/posts/disliked", "GET"},
		{"POST", "/users/1/posts", "GET"},
		{"DELETE", "/users/1/comments", "GET"},
		{"POST", "/users/activity", "GET"},
		{"POST", "/categories", "GET"},
		{"DELETE", "/categories/1", "GET"},
		{"PATCH", "/categories/view", "GET"},
		{"GET", "/comments/1/like", "POST"},
	} {
		rec := socialRequest(t, handler, tc.method, "/api/v1"+tc.path, "", nil, tok[1])
		if rec.Code != 405 || rec.Header().Get("Allow") != tc.allow {
			t.Errorf("%s %s = %d Allow=%q, want 405 %q", tc.method, tc.path, rec.Code, rec.Header().Get("Allow"), tc.allow)
		}
	}
	for _, path := range []string{
		"/posts/10/comments?page=0", "/posts/10/comments?page=1000001", "/posts/10/comments?per_page=51", "/posts/10/comments?per_page=0",
		"/posts/10/comments?page=1&page=2", "/posts/10/comments?sort=newest", "/posts/10/comments?page=1e2", "/posts/10/comments?page=-1",
		"/posts/liked?user_id=2", "/posts/disliked?owner=2", "/posts/liked?page=x",
		"/users/1/posts?status=draft", "/users/1/comments?per_page=500",
		"/users/activity?status=bogus", "/users/activity?status=draft&status=all", "/users/activity?user_id=2",
		"/categories?x=1", "/categories/1?x=1", "/categories/view?page=1",
		"/posts/10/nav?feed=bad", "/posts/10/nav?category_id=0", "/posts/10/nav?category_id=1&category_id=2", "/posts/10/nav?x=1",
		"/comments/1?x=1", "/posts/abc/comments", "/comments/0", "/comments/01x", "/categories/zero", "/users/0/posts",
	} {
		if rec := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, tok[1]); rec.Code != 400 {
			t.Errorf("GET %s = %d %.120s, want 400", path, rec.Code, rec.Body.String())
		}
	}
	for _, path := range []string{"/categories/1/", "/categories/1/extra", "/comments/1/", "/posts/10/comments/extra", "/posts/10/unknown"} {
		if rec := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, tok[1]); rec.Code != 404 {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
	}
	// Structurally valid unknown resources are 404; anonymous callers are 401.
	for _, path := range []string{"/posts/999/comments", "/comments/999", "/categories/999", "/posts/999/nav", "/users/999/posts", "/users/999/comments"} {
		if rec := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, tok[1]); rec.Code != 404 {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
		if rec := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, ""); rec.Code != 401 {
			t.Errorf("anonymous GET %s = %d, want 401", path, rec.Code)
		}
	}
	// Pages beyond the end are empty with current totals.
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(`{"body":"one"}`), tok[2]), 201, "")
	beyond := jsonMap(t, socialRequest(t, handler, "GET", "/api/v1/posts/10/comments?page=9&per_page=1", "", nil, tok[1]))
	pagination := beyond["meta"].(map[string]any)["pagination"].(map[string]any)
	if len(beyond["data"].([]any)) != 0 || pagination["total"].(float64) != 1 || pagination["total_pages"].(float64) != 1 {
		t.Fatalf("beyond-last page: %v", beyond)
	}
	empty := jsonMap(t, socialRequest(t, handler, "GET", "/api/v1/posts/11/comments", "", nil, tok[1]))
	if data, ok := empty["data"].([]any); !ok || len(data) != 0 || empty["meta"].(map[string]any)["pagination"].(map[string]any)["total_pages"].(float64) != 0 {
		t.Fatalf("empty thread: %v", empty)
	}
}

// Comment threads are oldest first; profile history is newest first; categories
// and navigation order by (created_at, id) and honor the Following filter.
func TestDiscussionOrderingNavigationAndFollowingFilter(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01');
 DELETE FROM posts;
 INSERT INTO posts(id,author_id,body,status,created_at)VALUES(30,1,'a','published','2026-01-01T00:00:00Z'),(31,1,'b','published','2026-01-02T00:00:00Z'),(32,3,'c','published','2026-01-03T00:00:00Z'),(33,1,'d','published','2026-01-04T00:00:00Z'),(34,1,'draft','draft','2026-01-02T12:00:00Z'),(35,1,'e','published','2026-01-04T00:00:00Z');
 INSERT INTO post_categories(post_id,category_id)VALUES(30,1),(31,1),(32,1),(33,2);
 INSERT INTO comments(id,post_id,user_id,body,created_at)VALUES(40,30,2,'oldest','2026-01-01T00:00:00Z'),(41,30,3,'middle','2026-01-02T00:00:00Z'),(42,30,2,'tie','2026-01-02T00:00:00Z'),(43,31,2,'newest','2026-01-05T00:00:00Z')`)
	ids := func(rec *httptest.ResponseRecorder) []int {
		t.Helper()
		assertSocialCode(t, rec, 200, "")
		out := []int{}
		for _, raw := range jsonMap(t, rec)["data"].([]any) {
			out = append(out, int(raw.(map[string]any)["id"].(float64)))
		}
		return out
	}
	get := func(token, path string) *httptest.ResponseRecorder {
		return socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, token)
	}
	if got := fmt.Sprint(ids(get(tok[1], "/posts/30/comments"))); got != "[40 41 42]" {
		t.Fatalf("thread order %s", got)
	}
	if got := fmt.Sprint(ids(get(tok[1], "/users/2/comments"))); got != "[43 42 40]" {
		t.Fatalf("profile comment order %s", got)
	}
	if got := fmt.Sprint(ids(get(tok[1], "/users/1/posts"))); got != "[35 33 31 30]" {
		t.Fatalf("profile post order %s (drafts are never listed, even for the owner)", got)
	}
	nav := func(token, path string) (any, any, any) {
		rec := get(token, path)
		assertSocialCode(t, rec, 200, "")
		data := jsonMap(t, rec)["data"].(map[string]any)
		return data["category_id"], data["prev_id"], data["next_id"]
	}
	if c, p, n := nav(tok[1], "/posts/31/nav"); c != nil || p != float64(30) || n != float64(32) {
		t.Fatalf("uncategorized nav: %v %v %v", c, p, n)
	}
	if c, p, n := nav(tok[1], "/posts/31/nav?category_id=1"); c != float64(1) || p != float64(30) || n != float64(32) {
		t.Fatalf("category nav: %v %v %v", c, p, n)
	}
	if _, p, n := nav(tok[2], "/posts/31/nav?feed=following"); p != float64(30) || n != float64(33) {
		t.Fatalf("following nav (post 32 is not followed): %v %v", p, n)
	}
	if _, p, n := nav(tok[1], "/posts/33/nav"); p != float64(32) || n != float64(35) {
		t.Fatalf("equal timestamps break ties by id: %v %v", p, n)
	}
	// The source must itself match: an uncategorized-for-filter, draft or unfollowed post is a 404.
	for _, path := range []string{"/posts/33/nav?category_id=1", "/posts/34/nav", "/posts/32/nav?feed=following", "/posts/30/nav?category_id=999"} {
		if rec := get(tok[2], path); rec.Code != 404 {
			t.Errorf("%s = %d, want 404", path, rec.Code)
		}
	}
}

// Audience loss and unpublishing hide discussions without deleting them; the same
// comments, reactions and counts return with access, and private histories follow.
func TestDiscussionRetentionAcrossAccessLossAndRestoration(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(3,1,'accepted','2000-01-01');UPDATE posts SET audience='followers' WHERE id=10`)
	get := func(token, path string) *httptest.ResponseRecorder {
		return socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, token)
	}
	made := socialRequest(t, handler, "POST", "/api/v1/posts/10/comments", "application/json", []byte(`{"body":"kept"}`), tok[3])
	cid, _ := commentID(t, made)
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/like", "", nil, tok[3]), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "POST", fmt.Sprintf("/api/v1/comments/%d/like", cid), "", nil, tok[1]), 200, "")
	rows := func() [3]int {
		return [3]int{count(t, conn, `SELECT COUNT(*) FROM comments`), count(t, conn, `SELECT COUNT(*) FROM reactions`), count(t, conn, `SELECT COUNT(*) FROM notifications`)}
	}
	stored := rows()
	for name, change := range map[string][2]string{
		"unfollow":    {`DELETE FROM follows WHERE follower_id=3`, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(3,1,'accepted','2000-01-01')`},
		"unpublish":   {`UPDATE posts SET status='draft' WHERE id=10`, `UPDATE posts SET status='published' WHERE id=10`},
		"audience":    {`UPDATE posts SET audience='selected' WHERE id=10`, `UPDATE posts SET audience='followers' WHERE id=10`},
		"deactivated": {`UPDATE users SET is_active=0 WHERE id=1`, `UPDATE users SET is_active=1 WHERE id=1`},
	} {
		fixtureExec(t, conn, change[0])
		for _, path := range []string{"/posts/10/comments", fmt.Sprintf("/comments/%d", cid), "/users/3/comments", "/users/activity", "/posts/liked"} {
			rec := get(tok[3], path)
			if name == "deactivated" && rec.Code == 401 {
				continue
			}
			var hidden bool
			switch {
			case rec.Code == 404:
				hidden = true
			case path == "/users/activity":
				sections := jsonMap(t, rec)["data"].(map[string]any)
				hidden = sections["liked_posts"].(map[string]any)["pagination"].(map[string]any)["total"].(float64) == 0 && sections["comments"].(map[string]any)["pagination"].(map[string]any)["total"].(float64) == 0
			default:
				hidden = rec.Code == 200 && total(t, jsonMap(t, rec)) == 0
			}
			if !hidden {
				t.Fatalf("%s: %s still disclosed: %d %.200s", name, path, rec.Code, rec.Body.String())
			}
		}
		if got := rows(); got != stored {
			t.Fatalf("%s deleted retained data: %v -> %v", name, stored, got)
		}
		fixtureExec(t, conn, change[1])
		restored := jsonMap(t, get(tok[3], fmt.Sprintf("/comments/%d", cid)))["data"].(map[string]any)
		if restored["body"] != "kept" || restored["likes"].(float64) != 1 || restored["my_reaction"].(float64) != 0 {
			t.Fatalf("%s: restored comment %v", name, restored)
		}
		if liked := get(tok[3], "/posts/liked"); total(t, jsonMap(t, liked)) != 1 {
			t.Fatalf("%s: liked history not restored: %s", name, liked.Body.String())
		}
	}
}

// Activity filters apply to created posts only; every section keeps owner-only
// semantics and drafts never appear in profile or liked lists.
func TestDiscussionActivityStatusFilterAndJPEGComments(t *testing.T) {
	handler, conn, tok := threeUsers(t)
	fixtureExec(t, conn, `INSERT INTO posts(id,author_id,body,status)VALUES(12,2,'my draft','draft'),(13,2,'my published','published')`)
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/13/like", "", nil, tok[2]), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/13/comments", "application/json", []byte(`{"body":"mine"}`), tok[2]), 201, "")
	sections := func(query string) map[string]any {
		rec := socialRequest(t, handler, "GET", "/api/v1/users/activity"+query, "", nil, tok[2])
		assertSocialCode(t, rec, 200, "")
		return jsonMap(t, rec)["data"].(map[string]any)
	}
	totals := func(data map[string]any) [4]int {
		var out [4]int
		for i, name := range []string{"created_posts", "liked_posts", "disliked_posts", "comments"} {
			out[i] = int(data[name].(map[string]any)["pagination"].(map[string]any)["total"].(float64))
		}
		return out
	}
	if got := totals(sections("")); got != [4]int{2, 1, 0, 1} {
		t.Fatalf("all: %v", got)
	}
	if got := totals(sections("?status=draft")); got != [4]int{1, 1, 0, 1} {
		t.Fatalf("draft: %v", got)
	}
	if got := totals(sections("?status=published")); got != [4]int{1, 1, 0, 1} {
		t.Fatalf("published: %v", got)
	}
	if got := totals(sections("?per_page=1&page=2")); got != [4]int{2, 1, 0, 1} || len(sections("?per_page=1&page=2")["created_posts"].(map[string]any)["items"].([]any)) != 1 {
		t.Fatalf("paging keeps totals: %v", got)
	}
	if rec := socialRequest(t, handler, "GET", "/api/v1/users/2/posts", "", nil, tok[3]); total(t, jsonMap(t, rec)) != 1 || strings.Contains(rec.Body.String(), "my draft") {
		t.Fatalf("drafts leaked into a profile: %s", rec.Body.String())
	}
	jpg, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.jpg")
	if err != nil {
		t.Fatal(err)
	}
	rec := discussionMultipartJPEG(t, handler, tok[3], jpg)
	assertSocialCode(t, rec, 201, "")
	url := jsonMap(t, rec)["data"].(map[string]any)["image_url"].(string)
	if read := socialRequest(t, handler, "GET", url, "", nil, tok[2]); read.Code != 200 || !bytes.Equal(read.Body.Bytes(), jpg) || read.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("jpeg attachment: %d %s", read.Code, read.Header().Get("Content-Type"))
	}
}

func discussionMultipartJPEG(t *testing.T, handler http.Handler, token string, jpg []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, _ := form.CreateFormFile("image", "photo.jpg")
	part.Write(jpg)
	form.Close()
	return socialRequest(t, handler, "POST", "/api/v1/posts/13/comments", form.FormDataContentType(), body.Bytes(), token)
}
