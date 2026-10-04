package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"forum/internal/db"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestSocialContentHTTPRoutePrivacyMatrix(t *testing.T) {
	handler, conn := socialAPI(t)
	tokens := []string{""}
	for _, email := range []string{"owner@privacy.test", "follower@privacy.test", "pending@privacy.test", "outsider@privacy.test"} {
		tokens = append(tokens, registerSocialUser(t, handler, email))
	}
	_, err := conn.Exec(`UPDATE users SET nickname='Publicly approved name',profile_visibility='private' WHERE id=1;
 INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01');INSERT INTO follows(follower_id,followed_id,state)VALUES(3,1,'pending');
 INSERT INTO posts(id,author_id,title,body,status,created_at)VALUES(10,1,'hidden title','hidden post body','published','2000-01-01'),(11,1,'hidden draft','hidden draft body','draft','2000-01-02'),(12,4,'public title','public post body','published','2000-01-03');
 INSERT INTO post_categories(post_id,category_id)VALUES(10,1),(11,1),(12,1);
 INSERT INTO comments(id,post_id,user_id,body)VALUES(20,10,4,'hidden comment body'),(21,12,1,'public comment body');
 INSERT INTO reactions(user_id,post_id,value)VALUES(4,10,1),(3,10,-1);`)
	if err != nil {
		t.Fatal(err)
	}
	reads := []string{"/posts/10", "/posts/10/comments", "/posts/10/nav?category_id=1", "/comments/20"}
	for viewer := 1; viewer <= 4; viewer++ {
		for _, path := range reads {
			r := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, tokens[viewer])
			want := 404
			if viewer <= 2 {
				want = 200
			}
			assertSocialCode(t, r, want, "")
		}
		draft := socialRequest(t, handler, "GET", "/api/v1/posts/11", "", nil, tokens[viewer])
		want := 404
		if viewer == 1 {
			want = 200
		}
		assertSocialCode(t, draft, want, "")
		for _, path := range []string{"/posts?per_page=1", "/posts?category_id=1", "/categories/1", "/categories/view", "/posts/liked", "/posts/disliked", "/posts/mine", "/users/activity", "/posts/12/nav?category_id=1"} {
			r := socialRequest(t, handler, "GET", "/api/v1"+path, "", nil, tokens[viewer])
			assertSocialCode(t, r, 200, "")
			if viewer >= 3 {
				for _, secret := range []string{"hidden title", "hidden post body", "hidden draft", "hidden comment body"} {
					if strings.Contains(r.Body.String(), secret) {
						t.Fatalf("viewer %d path %s leaked %s: %s", viewer, path, secret, r.Body.String())
					}
				}
			}
		}
		thread := socialRequest(t, handler, "GET", "/api/v1/posts/12/comments", "", nil, tokens[viewer])
		assertSocialCode(t, thread, 200, "")
		if !strings.Contains(thread.Body.String(), "Publicly approved name") {
			t.Fatal("private commenter hidden in public thread")
		}
	}
	for viewer := 3; viewer <= 4; viewer++ {
		for _, tc := range []struct{ method, path, body string }{{"POST", "/posts/10/comments", `{"body":"denied"}`}, {"POST", "/posts/10/like", ""}, {"POST", "/posts/10/dislike", ""}, {"POST", "/comments/20/like", ""}, {"POST", "/comments/20/dislike", ""}, {"PATCH", "/posts/10", `{"body":"denied"}`}, {"DELETE", "/posts/10", ""}, {"PATCH", "/comments/20", `{"body":"denied"}`}, {"DELETE", "/comments/20", ""}} {
			r := socialRequest(t, handler, tc.method, "/api/v1"+tc.path, "application/json", []byte(tc.body), tokens[viewer])
			assertSocialCode(t, r, 404, "")
		}
	}
	// Ownership cannot be inferred through editing a public foreign post/comment.
	for _, path := range []string{"/posts/12", "/comments/21"} {
		r := socialRequest(t, handler, "DELETE", "/api/v1"+path, "", nil, tokens[2])
		assertSocialCode(t, r, 404, "")
	}
	if _, err := conn.Exec(`DELETE FROM follows WHERE follower_id=2;`); err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, "POST", "/api/v1/posts/10/like", "", nil, tokens[2]), 404, "")
}
func contentUpload(t *testing.T, handler http.Handler, token, path string, data []byte, fields map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := form.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	file, err := form.CreateFormFile("image", "image.png")
	if err != nil {
		t.Fatal(err)
	}
	file.Write(data)
	form.Close()
	return socialRequest(t, handler, "POST", path, form.FormDataContentType(), body.Bytes(), token)
}
func TestSocialMediaHTTPValidationPrivacyAndDMOwnership(t *testing.T) {
	handler, conn := socialAPI(t)
	owner := registerSocialUser(t, handler, "owner@media.test")
	viewer := registerSocialUser(t, handler, "viewer@media.test")
	other := registerSocialUser(t, handler, "other@media.test")
	png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	created := contentUpload(t, handler, owner, "/api/v1/posts", png, map[string]string{"title": "image", "body": "body", "category_ids": "1"})
	assertSocialCode(t, created, 201, "")
	var result struct{ Data db.Post }
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.ImageURL == nil || !db.IsPrivateMediaURL(*result.Data.ImageURL) {
		t.Fatalf("wrong private URL %s", created.Body.String())
	}
	url := *result.Data.ImageURL
	read := socialRequest(t, handler, "GET", url, "", nil, viewer)
	if read.Code != 200 || !bytes.Equal(read.Body.Bytes(), png) || read.Header().Get("Cache-Control") != "no-store" || read.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("media read %d %s", read.Code, read.Body.String())
	}
	assertSocialCode(t, socialRequest(t, handler, "GET", url, "", nil, ""), 401, "")
	assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1/users/me/privacy", "application/json", []byte(`{"visibility":"private","expected_version":1}`), owner), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "GET", url, "", nil, viewer), 404, "")
	assertSocialCode(t, socialRequest(t, handler, "GET", url, "", nil, owner), 200, "")
	for _, path := range []string{"/static/uploads/guess.png", "/static/uploads/dm/guess.png", "/static/uploads/../favicon.ico", "//static/uploads/guess.png", "/static/%75ploads/guess.png", "/static/x/../uploads/guess.png", "/api/v1/media/%31", "/api/v1/media/../users/me", "/api/v1/media/999999999999999999999"} {
		for _, token := range []string{"", viewer} {
			want := 404
			if token == "" {
				want = 401
			}
			assertSocialCode(t, socialRequest(t, handler, "GET", path, "", nil, token), want, "")
		}
	}
	bad := contentUpload(t, handler, owner, "/api/v1/posts", []byte("\x89PNG\r\n\x1a\ncorrupt"), map[string]string{"title": "bad", "body": "bad", "category_ids": "1"})
	assertSocialCode(t, bad, 422, "INVALID_IMAGE")
	tooLarge := contentUpload(t, handler, owner, "/api/v1/posts", make([]byte, (5<<20)+1), map[string]string{"title": "bad", "body": "bad", "category_ids": "1"})
	assertSocialCode(t, tooLarge, 413, "PAYLOAD_TOO_LARGE")
	// A failed DB insert cleans both staged manifest and private bytes.
	if _, err := conn.Exec(`CREATE TRIGGER fail_post BEFORE INSERT ON posts BEGIN SELECT RAISE(ABORT,'failure');END;`); err != nil {
		t.Fatal(err)
	}
	failed := contentUpload(t, handler, owner, "/api/v1/posts", png, map[string]string{"title": "fail", "body": "fail", "category_ids": "1"})
	assertSocialCode(t, failed, 500, "")
	var pending int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM media_pending`).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("failed staging=%d %v", pending, err)
	}
	conn.Exec(`DROP TRIGGER fail_post`)
	dm := contentUpload(t, handler, owner, "/api/v1/chats/2/images", png, nil)
	assertSocialCode(t, dm, 200, "")
	var staged struct {
		Data struct {
			URL string `json:"image_url"`
		}
	}
	json.Unmarshal(dm.Body.Bytes(), &staged)
	assertSocialCode(t, socialRequest(t, handler, "GET", staged.Data.URL, "", nil, viewer), 404, "")
	assertSocialCode(t, socialRequest(t, handler, "GET", staged.Data.URL, "", nil, owner), 200, "")
	invalidDMClaim := socialRequest(t, handler, "PATCH", fmt.Sprintf("/api/v1/posts/%d", result.Data.ID), "application/json", []byte(fmt.Sprintf(`{"image_url":%q}`, staged.Data.URL)), owner)
	assertSocialCode(t, invalidDMClaim, 404, "")
	assertSocialCode(t, socialRequest(t, handler, "GET", staged.Data.URL, "", nil, owner), 200, "")
	_, err = db.CreateMessage(db.WithSocialViewer(context.Background(), 1), conn, db.CreateMessageRequest{SenderID: 1, RecipientID: 2, ImagePath: staged.Data.URL})
	if err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, "GET", staged.Data.URL, "", nil, viewer), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "GET", staged.Data.URL, "", nil, other), 404, "")
	history := socialRequest(t, handler, "GET", "/api/v1/chats/1/messages", "", nil, viewer)
	assertSocialCode(t, history, 200, "")
	var internalName string
	conn.QueryRow(`SELECT username FROM users WHERE id=1`).Scan(&internalName)
	if strings.Contains(history.Body.String(), internalName) {
		t.Fatal("DM username leak")
	}
	roster := socialRequest(t, handler, "GET", "/api/v1/chats", "", nil, viewer)
	assertSocialCode(t, roster, 200, "")
	var rows struct{ Data []map[string]any }
	json.Unmarshal(roster.Body.Bytes(), &rows)
	for _, r := range rows.Data {
		if r["user_id"] == float64(1) {
			if _, exposed := r["is_online"]; exposed {
				t.Fatal("private outsider presence leak")
			}
		}
	}
	spoof := socialRequest(t, handler, "POST", "/api/v1/posts", "application/json", []byte(fmt.Sprintf(`{"title":"spoof","body":"body","category_ids":[1],"image_url":%q}`, url)), viewer)
	assertSocialCode(t, spoof, 404, "")
}
