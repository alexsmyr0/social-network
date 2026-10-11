package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
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
)

// B19 drives real registered accounts through group content: posts and drafts,
// JPEG/PNG/GIF attachments, discussions, notices, departure, return and restart.
// The approved pack covers the access matrix; these tests cover the lifecycle
// and the gate's concurrency, preservation and bypass cases the pack cannot.

type contentWorld struct {
	t       *testing.T
	handler http.Handler
	conn    *sql.DB
	path    string
	token   map[string]string
	id      map[string]int64
	group   int64
	member  map[string]int64 // membership generation by account name
}

func (w *contentWorld) reopen() {
	w.handler, w.conn = openGroupAPI(w.t, w.path)
}

func (w *contentWorld) status(who, method, path, body string) int {
	w.t.Helper()
	contentType := ""
	var raw []byte
	if body != "" {
		contentType, raw = "application/json", []byte(body)
	}
	return socialRequest(w.t, w.handler, method, path, contentType, raw, w.token[who]).Code
}

func (w *contentWorld) call(who, method, path, body string, want int) json.RawMessage {
	w.t.Helper()
	return apiJSON(w.t, w.handler, w.token[who], method, path, body, want)
}

func (w *contentWorld) total(who, path string) int {
	w.t.Helper()
	response := socialRequest(w.t, w.handler, "GET", path, "", nil, w.token[who])
	if response.Code != 200 {
		w.t.Fatalf("GET %s -> %d %s", path, response.Code, response.Body.String())
	}
	var body struct {
		Meta struct{ Pagination struct{ Total int } }
	}
	json.Unmarshal(response.Body.Bytes(), &body)
	return body.Meta.Pagination.Total
}

// upload posts a multipart request whose attachment name matches its real type.
func (w *contentWorld) upload(who, path string, data []byte, fields map[string]string) *httptest.ResponseRecorder {
	w.t.Helper()
	name := "image.png"
	switch {
	case bytes.HasPrefix(data, []byte("GIF8")):
		name = "image.gif"
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8}):
		name = "photo.jpg"
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for key, value := range fields {
		form.WriteField(key, value)
	}
	part, _ := form.CreateFormFile("image", name)
	part.Write(data)
	form.Close()
	return socialRequest(w.t, w.handler, "POST", path, form.FormDataContentType(), body.Bytes(), w.token[who])
}

// unread is the viewer's unread notice count; resolved group invitations stay
// listed (read) after admission, so totals are not a content-notice measure.
func (w *contentWorld) unread(who string) int {
	w.t.Helper()
	var result struct {
		UnreadCount int `json:"unread_count"`
	}
	json.Unmarshal(w.call(who, "GET", "/api/v1/notifications", "", 200), &result)
	return result.UnreadCount
}

func (w *contentWorld) join(who string) {
	w.t.Helper()
	var invitation struct{ ID int64 }
	json.Unmarshal(w.call("owner", "POST", fmt.Sprintf("/api/v1/groups/%d/invitations", w.group), fmt.Sprintf(`{"user_id":%d}`, w.id[who]), 201), &invitation)
	var membership struct{ ID int64 }
	json.Unmarshal(w.call(who, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", invitation.ID), `{"decision":"accept"}`, 200), &membership)
	w.member[who] = membership.ID
}

// newContentWorld registers owner(1), ada(2, private profile), bob(3), cy(4) and
// dee(5); cy follows ada; owner's group admits ada and bob.
func newContentWorld(t *testing.T) *contentWorld {
	t.Helper()
	path := filepath.Join(t.TempDir(), "content.db")
	w := &contentWorld{t: t, path: path, token: map[string]string{}, id: map[string]int64{}, member: map[string]int64{}}
	w.reopen()
	for i, name := range []string{"owner", "ada", "bob", "cy", "dee"} {
		w.token[name] = registerSocialUser(t, w.handler, name+"@group-content.test")
		w.id[name] = int64(i + 1)
	}
	assertSocialCode(t, socialRequest(t, w.handler, "PATCH", "/api/v1/users/me/privacy", "application/json", []byte(`{"visibility":"private","expected_version":1}`), w.token["ada"]), 200, "")
	fixtureExec(t, w.conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(4,2,'accepted','2000-01-01T00:00:00Z')`)
	var group struct{ ID int64 }
	json.Unmarshal(w.call("owner", "POST", "/api/v1/groups", `{"title":"Chess Club","description":"Weekly games"}`, 201), &group)
	w.group = group.ID
	w.join("ada")
	w.join("bob")
	return w
}

func (w *contentWorld) postID(raw json.RawMessage) int64 {
	var post struct{ ID int64 }
	json.Unmarshal(raw, &post)
	return post.ID
}

func readFixtureImage(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("../../SPA/tests/fixtures/a07/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestGroupContentLifecycleMembershipControlsEveryReader(t *testing.T) {
	w := newContentWorld(t)
	group := fmt.Sprintf("%d", w.group)
	images := map[string][]byte{"image/png": readFixtureImage(t, "avatar.png"), "image/jpeg": readFixtureImage(t, "avatar.jpg"), "image/gif": readFixtureImage(t, "avatar.gif")}

	// A private author's group posts carry each supported image type and are
	// readable by members whatever the author's profile says.
	urls := map[string]string{}
	posts := map[string]int64{}
	for mime, data := range images {
		response := w.upload("ada", "/api/v1/posts", data, map[string]string{"group_id": group, "body": "hello " + mime, "category_ids": "1"})
		assertSocialCode(t, response, 201, "")
		var created struct {
			Data struct {
				ID       int64
				ImageURL string `json:"image_url"`
				Audience string
				Group    struct {
					ID    int64
					Title string
				}
			}
		}
		json.Unmarshal(response.Body.Bytes(), &created)
		if created.Data.Audience != "group" || created.Data.Group.ID != w.group || created.Data.Group.Title != "Chess Club" || !db.IsPrivateMediaURL(created.Data.ImageURL) {
			t.Fatalf("%s group post %s", mime, response.Body.String())
		}
		urls[mime], posts[mime] = created.Data.ImageURL, created.Data.ID
		for _, reader := range []string{"owner", "bob", "ada"} {
			read := socialRequest(t, w.handler, "GET", created.Data.ImageURL, "", nil, w.token[reader])
			if read.Code != 200 || !bytes.Equal(read.Body.Bytes(), data) || read.Header().Get("Content-Type") != mime {
				t.Fatalf("%s image for %s: %d %s", mime, reader, read.Code, read.Header().Get("Content-Type"))
			}
		}
		// Nonmember follower, outsider and anonymous cannot reach the post or its bytes.
		for _, outsider := range []string{"cy", "dee"} {
			assertSocialCode(t, socialRequest(t, w.handler, "GET", created.Data.ImageURL, "", nil, w.token[outsider]), 404, "")
			assertSocialCode(t, socialRequest(t, w.handler, "GET", fmt.Sprintf("/api/v1/posts/%d", created.Data.ID), "", nil, w.token[outsider]), 404, "")
		}
		assertSocialCode(t, socialRequest(t, w.handler, "GET", created.Data.ImageURL, "", nil, ""), 401, "")
	}
	pngPost := posts["image/png"]

	// Discussion: a member's image comment and reactions, with a notice for the author.
	comment := w.upload("bob", fmt.Sprintf("/api/v1/posts/%d/comments", pngPost), images["image/jpeg"], map[string]string{"body": "nice"})
	assertSocialCode(t, comment, 201, "")
	var commentResult struct {
		Data struct {
			ID       int64
			ImageURL string `json:"image_url"`
		}
	}
	json.Unmarshal(comment.Body.Bytes(), &commentResult)
	w.call("owner", "POST", fmt.Sprintf("/api/v1/posts/%d/like", pngPost), "", 200)
	w.call("owner", "POST", fmt.Sprintf("/api/v1/comments/%d/like", commentResult.Data.ID), "", 200)
	if w.unread("ada") != 2 || w.unread("bob") != 1 {
		t.Fatalf("unread notices ada=%d bob=%d, want 2 and 1", w.unread("ada"), w.unread("bob"))
	}

	// Drafts are author-only even among members.
	draft := w.call("ada", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"later","status":"draft"}`, group), 201)
	draftID := w.postID(draft)
	for _, other := range []string{"owner", "bob"} {
		w.call(other, "GET", fmt.Sprintf("/api/v1/posts/%d", draftID), "", 404)
		w.call(other, "GET", "/api/v1/posts/draft?group_id="+group, "", 200) // their own (none)
	}
	var latest struct {
		ID    int64
		Group struct{ ID int64 }
	}
	json.Unmarshal(w.call("ada", "GET", "/api/v1/posts/draft?group_id="+group, "", 200), &latest)
	if latest.ID != draftID || latest.Group.ID != w.group {
		t.Fatalf("latest group draft %+v want %d", latest, draftID)
	}

	// Publication changes keep the discussion: unpublish hides it, republish restores it.
	version := func(id int64) int64 {
		var p struct{ Version int64 }
		json.Unmarshal(w.call("ada", "GET", fmt.Sprintf("/api/v1/posts/%d", id), "", 200), &p)
		return p.Version
	}
	w.call("ada", "PATCH", fmt.Sprintf("/api/v1/posts/%d", pngPost), fmt.Sprintf(`{"expected_version":%d,"status":"draft"}`, version(pngPost)), 200)
	w.call("bob", "GET", fmt.Sprintf("/api/v1/posts/%d/comments", pngPost), "", 404)
	w.call("ada", "PATCH", fmt.Sprintf("/api/v1/posts/%d", pngPost), fmt.Sprintf(`{"expected_version":%d,"status":"published"}`, version(pngPost)), 200)
	var thread []struct{ ID int64 }
	json.Unmarshal(w.call("bob", "GET", fmt.Sprintf("/api/v1/posts/%d/comments", pngPost), "", 200), &thread)
	if len(thread) != 1 || thread[0].ID != commentResult.Data.ID {
		t.Fatalf("publication change lost the discussion: %+v", thread)
	}

	check := func(label string, bobMember bool) {
		t.Helper()
		want := map[bool]int{true: 200, false: 404}[bobMember]
		for _, path := range []string{
			fmt.Sprintf("/api/v1/posts/%d", pngPost), fmt.Sprintf("/api/v1/posts/%d/comments", pngPost), fmt.Sprintf("/api/v1/comments/%d", commentResult.Data.ID),
			urls["image/png"], commentResult.Data.ImageURL, fmt.Sprintf("/api/v1/posts/%d/nav", pngPost), "/api/v1/posts?group_id=" + group,
		} {
			if got := w.status("bob", "GET", path, ""); got != want {
				t.Errorf("%s: bob GET %s -> %d, want %d", label, path, got, want)
			}
		}
		// Aggregates are filtered before counting: home feed, categories, histories.
		homeWant := 0
		if bobMember {
			homeWant = 3
		}
		if got := w.total("bob", "/api/v1/posts"); got != homeWant {
			t.Errorf("%s: bob home feed total %d want %d", label, got, homeWant)
		}
		var categories []struct{ Posts []struct{ ID int64 } }
		json.Unmarshal(w.call("bob", "GET", "/api/v1/categories/view", "", 200), &categories)
		seen := 0
		for _, c := range categories {
			seen += len(c.Posts)
		}
		if bobMember != (seen == 3) || (!bobMember && seen != 0) {
			t.Errorf("%s: bob sees %d categorized posts", label, seen)
		}
		var activity struct {
			Comments struct{ Items []struct{ ID int64 } }
			Liked    struct{ Items []struct{ ID int64 } } `json:"liked_posts"`
		}
		json.Unmarshal(w.call("bob", "GET", "/api/v1/users/activity", "", 200), &activity)
		if bobMember != (len(activity.Comments.Items) == 1) {
			t.Errorf("%s: bob's own comment activity has %d items", label, len(activity.Comments.Items))
		}
		if got := w.unread("bob"); got != map[bool]int{true: 1, false: 0}[bobMember] {
			t.Errorf("%s: bob sees %d notices", label, got)
		}
		// Ada and the owner are unaffected and still see bob's retained comment.
		for _, reader := range []string{"ada", "owner"} {
			w.call(reader, "GET", fmt.Sprintf("/api/v1/comments/%d", commentResult.Data.ID), "", 200)
		}
	}
	check("member", true)

	// Removal: every read and write path closes, retained contributions stay.
	w.call("owner", "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", w.member["bob"]), "", 204)
	check("removed", false)
	for _, write := range [][3]string{
		{"POST", fmt.Sprintf("/api/v1/posts/%d/comments", pngPost), `{"body":"still here?"}`},
		{"POST", fmt.Sprintf("/api/v1/posts/%d/like", pngPost), ""},
		{"POST", fmt.Sprintf("/api/v1/comments/%d/like", commentResult.Data.ID), ""},
		{"PATCH", fmt.Sprintf("/api/v1/comments/%d", commentResult.Data.ID), `{"expected_version":1,"body":"edit"}`},
		{"DELETE", fmt.Sprintf("/api/v1/comments/%d?expected_version=1", commentResult.Data.ID), ""},
		{"POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"back door"}`, group)},
		{"POST", "/api/v1/posts/draft", fmt.Sprintf(`{"group_id":%s,"body":"back door"}`, group)},
	} {
		if got := w.status("bob", write[0], write[1], write[2]); got != 404 {
			t.Errorf("removed member %s %s -> %d, want 404", write[0], write[1], got)
		}
	}
	assertSocialCode(t, w.upload("bob", "/api/v1/posts", images["image/png"], map[string]string{"group_id": group, "body": "upload"}), 404, "")
	if n := count(t, w.conn, `SELECT COUNT(*) FROM media_pending`); n != 0 {
		t.Errorf("a refused upload left %d staged media rows", n)
	}

	// The retained comment and its image survive sweeps and restarts for the remaining members.
	if err := db.CleanupMedia(context.Background(), w.conn, true); err != nil {
		t.Fatal(err)
	}
	for restart := 0; restart < 2; restart++ {
		w.reopen()
		check(fmt.Sprintf("removed after restart %d", restart+1), false)
		read := socialRequest(t, w.handler, "GET", commentResult.Data.ImageURL, "", nil, w.token["ada"])
		if read.Code != 200 || !bytes.Equal(read.Body.Bytes(), images["image/jpeg"]) {
			t.Fatalf("departed author's attachment after restart %d: %d", restart+1, read.Code)
		}
	}

	// A fresh admission restores access, and hidden notices come back as they were.
	w.join("bob")
	check("returned", true)
}

func TestGroupContentRejectsForgedScopeAndAssociations(t *testing.T) {
	w := newContentWorld(t)
	group := fmt.Sprintf("%d", w.group)
	personal := w.postID(w.call("ada", "POST", "/api/v1/posts", `{"body":"personal","audience":"public"}`, 201))
	grouped := w.postID(w.call("ada", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"grouped"}`, group), 201))
	otherGroup := w.postID(w.call("dee", "POST", "/api/v1/posts", `{"body":"elsewhere"}`, 201))

	// Group scope is create-only and exclusive of personal audience controls.
	for _, body := range []string{
		`{"expected_version":1,"group_id":0}`, fmt.Sprintf(`{"expected_version":1,"group_id":%s}`, group), `{"expected_version":1,"group_id":null}`, `{"expected_version":1,"group_id":"abc"}`,
	} {
		w.call("ada", "PATCH", fmt.Sprintf("/api/v1/posts/%d", grouped), body, 400)
		w.call("ada", "PATCH", fmt.Sprintf("/api/v1/posts/%d", personal), body, 400)
	}
	w.call("ada", "PATCH", fmt.Sprintf("/api/v1/posts/%d", grouped), `{"expected_version":1,"selected_follower_ids":[]}`, 400)
	w.call("ada", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"x","selected_follower_ids":[]}`, group), 400)
	w.call("ada", "PUT", fmt.Sprintf("/api/v1/posts/draft/%d", w.postID(w.call("ada", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"d","status":"draft"}`, group), 201))), fmt.Sprintf(`{"expected_version":1,"group_id":%s}`, group), 400)
	if n := count(t, w.conn, `SELECT COUNT(*) FROM posts WHERE group_id IS NOT NULL`); n != 2 {
		t.Fatalf("forged scope changed group posts: %d", n)
	}
	// An outsider cannot place content into a group by naming it; neither can a
	// multipart request, a draft or a nonexistent group reveal anything different.
	w.call("dee", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"in"}`, group), 404)
	w.call("dee", "POST", "/api/v1/posts", `{"group_id":9999,"body":"in"}`, 404)
	assertSocialCode(t, w.upload("dee", "/api/v1/posts", readFixtureImage(t, "avatar.png"), map[string]string{"group_id": group, "body": "in"}), 404, "")
	assertSocialCode(t, w.upload("ada", "/api/v1/posts", readFixtureImage(t, "avatar.png"), map[string]string{"group_id": "0", "body": "in"}), 400, "INVALID_ID")
	assertSocialCode(t, w.upload("ada", "/api/v1/posts", readFixtureImage(t, "avatar.png"), map[string]string{"group_id": "7x", "body": "in"}), 400, "")

	// A comment's parent must be a comment on the same post, whatever its group.
	groupComment := w.postID(w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", grouped), `{"body":"group reply"}`, 201))
	personalComment := w.postID(w.call("cy", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", personal), `{"body":"personal reply"}`, 201))
	w.call("cy", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", personal), fmt.Sprintf(`{"body":"forged","parent_comment_id":%d}`, groupComment), 404)
	w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", grouped), fmt.Sprintf(`{"body":"forged","parent_comment_id":%d}`, personalComment), 404)
	w.call("dee", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", otherGroup), fmt.Sprintf(`{"body":"forged","parent_comment_id":%d}`, groupComment), 404)
	if n := count(t, w.conn, `SELECT COUNT(*) FROM comments`); n != 2 {
		t.Fatalf("forged parents committed comments: %d", n)
	}

	// A group post never becomes readable through its stored audience, a follow or
	// the author's public profile; the personal post stays under personal rules.
	fixtureExec(t, w.conn, `UPDATE users SET profile_visibility='public' WHERE id=2`)
	w.call("cy", "GET", fmt.Sprintf("/api/v1/posts/%d", grouped), "", 404)
	w.call("cy", "GET", fmt.Sprintf("/api/v1/posts/%d", personal), "", 200)
	var profile []struct{ ID int64 }
	json.Unmarshal(w.call("cy", "GET", "/api/v1/users/2/posts", "", 200), &profile)
	if len(profile) != 1 || profile[0].ID != personal {
		t.Fatalf("profile posts for a nonmember follower: %+v", profile)
	}
	json.Unmarshal(w.call("bob", "GET", "/api/v1/users/2/posts", "", 200), &profile)
	if len(profile) != 2 {
		t.Fatalf("a member sees the author's group and public posts: %+v", profile)
	}
}

// TestGroupContentConcurrentRemovalCommitsNoUnauthorizedMutation fires the
// member's write and the creator's removal together: every outcome must equal one
// serial order, so a write is either fully committed before the removal or is a
// 404 that left no row, vote, notice or signal behind.
func TestGroupContentConcurrentRemovalCommitsNoUnauthorizedMutation(t *testing.T) {
	pack := loadGroupPack(t)
	type op struct {
		name           string
		viewer         int64
		request        groupRequest
		table, rowSQL  string
		successStatus  int
		multipartImage bool
	}
	ops := []op{
		{name: "create-post", viewer: 7, request: groupRequest{Method: "POST", Path: "/api/v1/posts", Body: json.RawMessage(`{"body":"x","group_id":301}`)}, table: "posts", rowSQL: `SELECT COUNT(*) FROM posts WHERE id>=122`, successStatus: 201},
		{name: "create-draft", viewer: 7, request: groupRequest{Method: "POST", Path: "/api/v1/posts/draft", Body: json.RawMessage(`{"body":"x","group_id":301}`)}, table: "posts", rowSQL: `SELECT COUNT(*) FROM posts WHERE id>=122`, successStatus: 200},
		{name: "edit-own-post", viewer: 7, request: groupRequest{Method: "PATCH", Path: "/api/v1/posts/111", Body: json.RawMessage(`{"expected_version":1,"body":"edited"}`)}, table: "posts", rowSQL: `SELECT COUNT(*) FROM posts WHERE id=111 AND body='edited'`, successStatus: 200},
		{name: "publish-own-draft", viewer: 7, request: groupRequest{Method: "PATCH", Path: "/api/v1/posts/113", Body: json.RawMessage(`{"expected_version":1,"status":"published"}`)}, table: "posts", rowSQL: `SELECT COUNT(*) FROM posts WHERE id=113 AND status='published'`, successStatus: 200},
		{name: "delete-own-post", viewer: 7, request: groupRequest{Method: "DELETE", Path: "/api/v1/posts/111?expected_version=1"}, table: "posts", rowSQL: `SELECT COUNT(*) FROM posts WHERE id=111`, successStatus: 204},
		{name: "comment-reply", viewer: 7, request: groupRequest{Method: "POST", Path: "/api/v1/posts/112/comments", Body: json.RawMessage(`{"body":"x","parent_comment_id":213}`)}, table: "comments", rowSQL: `SELECT COUNT(*) FROM comments WHERE id>=214`, successStatus: 201},
		{name: "edit-own-comment", viewer: 7, request: groupRequest{Method: "PATCH", Path: "/api/v1/comments/211", Body: json.RawMessage(`{"expected_version":1,"body":"edited"}`)}, table: "comments", rowSQL: `SELECT COUNT(*) FROM comments WHERE id=211 AND body='edited'`, successStatus: 200},
		{name: "like-comment", viewer: 7, request: groupRequest{Method: "POST", Path: "/api/v1/comments/213/like"}, table: "reactions", rowSQL: `SELECT COUNT(*) FROM reactions`, successStatus: 200},
	}
	for _, o := range ops {
		t.Run(o.name, func(t *testing.T) {
			committed, refused := 0, 0
			for round := 0; round < 24; round++ {
				handler, conn := socialAPI(t)
				seedGroupFixture(t, conn, pack.State, pack.Clock)
				signals := captureGroupSignals(t)
				before := count(t, conn, o.rowSQL)
				var wg sync.WaitGroup
				start := make(chan struct{})
				var writeReply, removeReply *httptest.ResponseRecorder
				wg.Add(2)
				// A small random head start for either side exercises both serial orders.
				writeDelay, removeDelay := time.Duration(rand.Intn(400))*time.Microsecond, time.Duration(rand.Intn(400))*time.Microsecond
				go func() {
					defer wg.Done()
					<-start
					time.Sleep(writeDelay)
					viewer := o.viewer
					writeReply = runGroupRequest(t, handler, conn, &viewer, o.request)
				}()
				go func() {
					defer wg.Done()
					<-start
					time.Sleep(removeDelay)
					viewer := int64(42)
					removeReply = runGroupRequest(t, handler, conn, &viewer, groupRequest{Method: "DELETE", Path: "/api/v1/group-memberships/502"})
				}()
				close(start)
				wg.Wait()
				if removeReply.Code != 204 {
					t.Fatalf("removal -> %d %s", removeReply.Code, removeReply.Body.String())
				}
				if count(t, conn, `SELECT COUNT(*) FROM group_memberships WHERE id=502`) != 0 {
					t.Fatal("member was not removed")
				}
				after := count(t, conn, o.rowSQL)
				switch writeReply.Code {
				case o.successStatus:
					committed++
				case 404:
					refused++
					if after != before {
						t.Fatalf("round %d: a 404 write changed %s rows %d -> %d", round, o.table, before, after)
					}
					for _, s := range signals.sorted() {
						if strings.HasPrefix(s, "notification.new") {
							t.Fatalf("round %d: refused write sent %s", round, s)
						}
					}
				default:
					t.Fatalf("round %d: write -> %d %s", round, writeReply.Code, writeReply.Body.String())
				}
				// Whatever the order, the removal leaves the author with no access.
				viewer := o.viewer
				if probe := runGroupRequest(t, handler, conn, &viewer, groupRequest{Method: "GET", Path: "/api/v1/posts/111"}); probe.Code != 404 {
					t.Fatalf("round %d: removed author still reads the group (%d)", round, probe.Code)
				}
				assertGroupInvariants(t, conn)
			}
			t.Logf("%s: %d committed before removal, %d refused after", o.name, committed, refused)
		})
	}
}

// TestGroupContentNoticesFollowCurrentMembership covers the notice rules the pack
// states one case at a time: no notice for a nonmember recipient, hidden notices
// keep their stored state, read-all skips them, and a fresh admission restores them.
func TestGroupContentNoticesFollowCurrentMembership(t *testing.T) {
	w := newContentWorld(t)
	group := fmt.Sprintf("%d", w.group)
	post := w.postID(w.call("bob", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%s,"body":"bob's post"}`, group), 201))
	comment := w.postID(w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", post), `{"body":"bob's own comment"}`, 201))

	w.call("owner", "POST", fmt.Sprintf("/api/v1/posts/%d/like", post), "", 200)
	w.call("ada", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", post), `{"body":"ada replies"}`, 201)
	if w.unread("bob") != 2 {
		t.Fatalf("member's unread notices: %d", w.unread("bob"))
	}

	// Bob leaves. New activity on his retained content creates no notice for him.
	w.call("bob", "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", w.member["bob"]), "", 204)
	w.call("owner", "POST", fmt.Sprintf("/api/v1/comments/%d/like", comment), "", 200)
	w.call("owner", "POST", fmt.Sprintf("/api/v1/posts/%d/dislike", post), "", 200)
	w.call("ada", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", post), `{"body":"nobody home"}`, 201)
	const contentNotices = `SELECT COUNT(*) FROM notifications WHERE recipient_id=3 AND type NOT LIKE 'group_%'`
	if n := count(t, w.conn, contentNotices); n != 2 {
		t.Fatalf("content notices stored for bob: %d, want the 2 from before he left", n)
	}
	// Stored notices are hidden from every read; read-all and read-one cannot touch them.
	if w.unread("bob") != 0 {
		t.Fatal("departed member counts hidden group notices as unread")
	}
	w.call("bob", "PATCH", "/api/v1/notifications/read-all", "", 204)
	if n := count(t, w.conn, contentNotices+` AND is_read=0`); n != 2 {
		t.Fatalf("read-all marked %d hidden notices read", 2-n)
	}
	var stored int64
	w.conn.QueryRow(`SELECT MIN(id) FROM notifications WHERE recipient_id=3 AND type NOT LIKE 'group_%'`).Scan(&stored)
	w.call("bob", "PATCH", fmt.Sprintf("/api/v1/notifications/%d/read", stored), "", 404)
	if n := count(t, w.conn, contentNotices+` AND is_read=0`); n != 2 {
		t.Fatal("read-one marked a hidden notice read")
	}
	// The invitation history stays listable: it exposes only public group metadata.
	w.call("bob", "GET", "/api/v1/notifications", "", 200)

	// Fresh admission: the stored, still-unread notices reappear.
	w.join("bob")
	if w.unread("bob") != 2 {
		t.Fatalf("returned member has %d unread, want the 2 stored notices back", w.unread("bob"))
	}
}

// TestGroupContentSocketsInvalidateEveryOpenView checks the existing signals:
// content changes refresh every authenticated socket, a removal refreshes the
// removed member, and a socket that missed everything recovers by refetching.
func TestGroupContentSocketsInvalidateEveryOpenView(t *testing.T) {
	requireLocalTCPListener(t)
	handler, db0, hub := socialAPIWithHub(t)
	wireSocialSocketHooks(t, hub)
	w := &contentWorld{t: t, handler: handler, conn: db0, token: map[string]string{}, id: map[string]int64{}, member: map[string]int64{}}
	for i, name := range []string{"owner", "ada", "bob"} {
		w.token[name] = registerSocialUser(t, handler, name+"@sockets.test")
		w.id[name] = int64(i + 1)
	}
	var group struct{ ID int64 }
	json.Unmarshal(w.call("owner", "POST", "/api/v1/groups", `{"title":"Go","description":"Gophers"}`, 201), &group)
	w.group = group.ID
	w.join("ada")
	w.join("bob")
	srv := httptest.NewServer(handler)
	defer srv.Close()
	sockets := map[string]*socialSocketProbe{}
	for name := range w.token {
		sockets[name] = openSocialSocket(t, srv, w.token[name])
	}
	expectAll := func(label string) {
		t.Helper()
		for name, probe := range sockets {
			t.Logf("%s: %s", label, name)
			probe.expect(t, "social.invalidate")
		}
	}
	post := w.postID(w.call("ada", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%d,"body":"hello"}`, w.group), 201))
	expectAll("post created")
	w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", post), `{"body":"hi"}`, 201)
	sockets["ada"].expect(t, "social.invalidate", "notification.new")
	sockets["owner"].expect(t, "social.invalidate")
	sockets["bob"].expect(t, "social.invalidate")
	// A refused write by a removed member sends nothing.
	w.call("owner", "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", w.member["bob"]), "", 204)
	for _, name := range []string{"owner", "ada", "bob"} {
		sockets[name].expect(t, "social.invalidate")
	}
	w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/comments", post), `{"body":"closed"}`, 404)
	w.call("bob", "POST", fmt.Sprintf("/api/v1/posts/%d/like", post), "", 404)
	w.call("bob", "POST", "/api/v1/posts", fmt.Sprintf(`{"group_id":%d,"body":"closed"}`, w.group), 404)
	for _, probe := range sockets {
		probe.silent(t)
	}
	// The removed member's reconnect/refetch is the whole recovery: 404 now.
	w.call("bob", "GET", fmt.Sprintf("/api/v1/posts/%d", post), "", 404)
	w.call("ada", "GET", fmt.Sprintf("/api/v1/posts/%d", post), "", 200)
}

// TestGroupMediaAliasesNeverBypassMembership tries every other spelling of a
// group post's attachment: only the checked canonical URL, for a current member,
// serves bytes.
func TestGroupMediaAliasesNeverBypassMembership(t *testing.T) {
	w := newContentWorld(t)
	response := w.upload("ada", "/api/v1/posts", readFixtureImage(t, "avatar.png"), map[string]string{"group_id": fmt.Sprint(w.group), "body": "pic"})
	assertSocialCode(t, response, 201, "")
	var created struct {
		Data struct {
			ImageURL string `json:"image_url"`
		}
	}
	json.Unmarshal(response.Body.Bytes(), &created)
	url := created.Data.ImageURL
	var objectKey string
	if err := w.conn.QueryRow(`SELECT object_key FROM media_objects`).Scan(&objectKey); err != nil {
		t.Fatal(err)
	}
	id := strings.TrimPrefix(url, "/api/v1/media/")
	aliases := []string{
		url + "/", url + "?x=1", url + ".png", "/api/v1/media/0" + id, "/api/v1/media/%" + fmt.Sprintf("%02X", id[0]) + id[1:],
		"/api/v1/media//" + id, "/api/v1/../v1/media/" + id,
		"/static/uploads/" + objectKey, "/api/v1/static/uploads/" + objectKey, "/static/uploads/dm/" + objectKey,
		"/media/" + objectKey, "/api/v1/media/" + objectKey,
	}
	for _, alias := range aliases {
		for _, reader := range []string{"ada", "owner", "cy", "dee"} {
			if got := socialRequest(t, w.handler, "GET", alias, "", nil, w.token[reader]); got.Code == 200 && bytes.Equal(got.Body.Bytes(), readFixtureImage(t, "avatar.png")) && alias != url+"?x=1" {
				t.Errorf("%s served private bytes for %s via %s", reader, url, alias)
			}
		}
	}
	// A query string does not change the decision: members read, others do not.
	for reader, want := range map[string]int{"ada": 200, "owner": 200, "cy": 404, "dee": 404} {
		if got := socialRequest(t, w.handler, "GET", url+"?x=1", "", nil, w.token[reader]).Code; got != want {
			t.Errorf("%s with a query -> %d, want %d", reader, got, want)
		}
	}
	for _, reader := range []string{"cy", "dee"} {
		assertSocialCode(t, socialRequest(t, w.handler, "GET", url, "", nil, w.token[reader]), 404, "")
	}
	assertSocialCode(t, socialRequest(t, w.handler, "GET", url, "", nil, ""), 401, "")
}
