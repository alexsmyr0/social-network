package tests

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const (
	roleOwner = iota + 1
	roleSelected
	roleFollower
	rolePending
	roleOutsider
)

var discussionRoleNames = map[int]string{roleOwner: "owner", roleSelected: "selected", roleFollower: "follower", rolePending: "pending", roleOutsider: "outsider"}

// discussionWorld: user 1 owns post 10; 2 is a selected accepted follower, 3 an
// unselected accepted follower, 4 a pending requester and 5 an outsider.
type discussionWorld struct {
	t       *testing.T
	handler http.Handler
	conn    *sql.DB
	token   map[int]string
	// Seeded IDs.
	ownerComment, selectedComment int64
	commentImage                  string
	notice                        map[int]int64
	baseline                      struct{ comments, reactions, notifications int64 }
}

func newDiscussionWorld(t *testing.T) *discussionWorld {
	t.Helper()
	handler, conn := socialAPI(t)
	w := &discussionWorld{t: t, handler: handler, conn: conn, token: map[int]string{}, notice: map[int]int64{}}
	for role := roleOwner; role <= roleOutsider; role++ {
		w.token[role] = registerSocialUser(t, handler, fmt.Sprintf("%s@discussions.test", discussionRoleNames[role]))
		fixtureExec(t, conn, `UPDATE users SET nickname=? WHERE id=?`, strings.Title(discussionRoleNames[role])+" Person", role)
	}
	fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01'),(3,1,'accepted','2000-01-01');
 INSERT INTO follows(follower_id,followed_id,state)VALUES(4,1,'pending');
 INSERT INTO posts(id,author_id,title,body,status,created_at)VALUES(10,1,'SECRET-TITLE','SECRET-POST-BODY','published','2026-01-01T00:00:00Z');
 INSERT INTO post_categories(post_id,category_id)VALUES(10,1)`)
	png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	created := contentUpload(t, handler, w.token[roleOwner], "/api/v1/posts/10/comments", png, map[string]string{"body": "SECRET-OWNER-COMMENT"})
	assertSocialCode(t, created, 201, "")
	var made struct {
		Data struct {
			ID       int64
			ImageURL string `json:"image_url"`
		}
	}
	if err := json.Unmarshal(created.Body.Bytes(), &made); err != nil || made.Data.ImageURL == "" {
		t.Fatalf("seed comment: %v %s", err, created.Body.String())
	}
	w.ownerComment, w.commentImage = made.Data.ID, made.Data.ImageURL
	fixtureExec(t, conn, `INSERT INTO comments(id,post_id,user_id,body)VALUES(21,10,2,'SECRET-SELECTED-COMMENT'),(22,10,3,'SECRET-FOLLOWER-COMMENT'),(23,10,4,'SECRET-PENDING-COMMENT'),(24,10,5,'SECRET-OUTSIDER-COMMENT');
 INSERT INTO reactions(user_id,post_id,value)VALUES(2,10,1),(3,10,1),(4,10,1),(5,10,1);
 INSERT INTO reactions(user_id,comment_id,value)VALUES(1,21,1);
 INSERT INTO notifications(recipient_id,actor_id,type,post_id)VALUES(2,1,'post_like',10),(3,1,'post_like',10),(4,1,'post_like',10),(5,1,'post_like',10);
 INSERT INTO notifications(recipient_id,actor_id,type,comment_id)VALUES(2,1,'comment_like',21)`)
	w.selectedComment = 21
	for role := roleSelected; role <= roleOutsider; role++ {
		if err := conn.QueryRow(`SELECT id FROM notifications WHERE recipient_id=? AND type='post_like'`, role).Scan(new(int64)); err != nil {
			t.Fatal(err)
		}
		var id int64
		conn.QueryRow(`SELECT id FROM notifications WHERE recipient_id=? AND type='post_like'`, role).Scan(&id)
		w.notice[role] = id
	}
	conn.QueryRow(`SELECT MAX(id) FROM comments`).Scan(&w.baseline.comments)
	conn.QueryRow(`SELECT MAX(id) FROM reactions`).Scan(&w.baseline.reactions)
	conn.QueryRow(`SELECT MAX(id) FROM notifications`).Scan(&w.baseline.notifications)
	return w
}

func (w *discussionWorld) scenario(profile, audience string) {
	w.t.Helper()
	fixtureExec(w.t, w.conn, `DELETE FROM post_selected_followers;UPDATE users SET profile_visibility=? WHERE id=1;UPDATE posts SET audience=? WHERE id=10`, profile, audience)
	if audience == "selected" {
		fixtureExec(w.t, w.conn, `INSERT INTO post_selected_followers(post_id,follow_id)SELECT 10,id FROM follows WHERE follower_id=2 AND followed_id=1`)
	}
}

// reset removes rows a mutation attempt created and restores edited comments.
func (w *discussionWorld) reset() {
	w.t.Helper()
	fixtureExec(w.t, w.conn, `DELETE FROM comments WHERE id>?;DELETE FROM reactions;DELETE FROM notifications;
 UPDATE comments SET content_version=1,body='SECRET-SELECTED-COMMENT' WHERE id=21;
 UPDATE comments SET content_version=1,body='SECRET-FOLLOWER-COMMENT' WHERE id=22;
 UPDATE comments SET content_version=1,body='SECRET-PENDING-COMMENT' WHERE id=23;
 UPDATE comments SET content_version=1,body='SECRET-OUTSIDER-COMMENT' WHERE id=24;
 INSERT INTO reactions(user_id,post_id,value)VALUES(2,10,1),(3,10,1),(4,10,1),(5,10,1);
 INSERT INTO reactions(user_id,comment_id,value)VALUES(1,21,1);
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id)VALUES(?,2,1,'post_like',10),(?,3,1,'post_like',10),(?,4,1,'post_like',10),(?,5,1,'post_like',10);
 INSERT INTO notifications(recipient_id,actor_id,type,comment_id)VALUES(2,1,'comment_like',21)`, w.baseline.comments, w.notice[roleSelected], w.notice[roleFollower], w.notice[rolePending], w.notice[roleOutsider])
}

func (w *discussionWorld) do(role int, method, path string, body string) *httptest.ResponseRecorder {
	w.t.Helper()
	contentType := ""
	if body != "" {
		contentType = "application/json"
	}
	return socialRequest(w.t, w.handler, method, "/api/v1"+path, contentType, []byte(body), w.token[role])
}

func (w *discussionWorld) json(rec *httptest.ResponseRecorder) map[string]any {
	w.t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		w.t.Fatalf("bad JSON %s: %v", rec.Body.String(), err)
	}
	return out
}

// allowedFor mirrors the approved access matrix; the owner always has access.
func discussionAllowed(profile, audience string, role int) bool {
	switch role {
	case roleOwner:
		return true
	case roleSelected:
		return true
	case roleFollower:
		return audience != "selected"
	}
	return profile == "public" && audience == "public"
}

func total(t *testing.T, body map[string]any) int {
	t.Helper()
	meta, _ := body["meta"].(map[string]any)
	pagination, _ := meta["pagination"].(map[string]any)
	n, ok := pagination["total"].(float64)
	if !ok {
		t.Fatalf("missing total in %v", body)
	}
	return int(n)
}

func assertNoSecrets(t *testing.T, label, text string) {
	t.Helper()
	for _, secret := range []string{"SECRET-"} {
		if strings.Contains(text, secret) {
			t.Fatalf("%s leaked restricted content: %s", label, text)
		}
	}
}

// TestDiscussionAudienceMatrixAcrossEverySurface traverses detail, thread, comment,
// attachment, navigation, categories, profile, private-history and notice surfaces
// for every profile × audience × relationship combination, then attempts every
// mutation. Counts, excerpts, titles and image bytes must follow the matrix exactly.
func TestDiscussionAudienceMatrixAcrossEverySurface(t *testing.T) {
	w := newDiscussionWorld(t)
	for _, profile := range []string{"public", "private"} {
		for _, audience := range []string{"public", "followers", "selected"} {
			w.scenario(profile, audience)
			for role := roleOwner; role <= roleOutsider; role++ {
				name := fmt.Sprintf("%s/%s/%s", profile, audience, discussionRoleNames[role])
				t.Run(name, func(t *testing.T) {
					allowed := discussionAllowed(profile, audience, role)
					want := 404
					if allowed {
						want = 200
					}
					// Direct URLs, including attachment bytes.
					for _, path := range []string{"/posts/10", "/posts/10/comments", fmt.Sprintf("/comments/%d", w.ownerComment), "/comments/21", "/posts/10/nav?category_id=1", "/posts/10/nav", w.commentImage[len("/api/v1"):]} {
						rec := w.do(role, "GET", path, "")
						if rec.Code != want {
							t.Fatalf("GET %s = %d %s, want %d", path, rec.Code, rec.Body.String(), want)
						}
						if !allowed {
							assertNoSecrets(t, path, rec.Body.String())
						}
					}
					following := w.do(role, "GET", "/posts/10/nav?feed=following", "")
					if wantFollowing := map[bool]int{true: 200, false: 404}[allowed && (role == roleSelected || role == roleFollower)]; following.Code != wantFollowing {
						t.Fatalf("Following navigation = %d, want %d", following.Code, wantFollowing)
					}
					if allowed {
						thread := w.do(role, "GET", "/posts/10/comments", "")
						if got := total(t, w.json(thread)); got != 5 {
							t.Fatalf("thread total %d, want all 5 comments", got)
						}
					}
					// Aggregates must filter before counting.
					view := w.json(w.do(role, "GET", "/categories/view", ""))
					for _, category := range view["data"].([]any) {
						entry := category.(map[string]any)
						if entry["id"].(float64) == 1 {
							posts := len(entry["posts"].([]any))
							if (posts == 1) != allowed || posts > 1 {
								t.Fatalf("category 1 lists %d posts, allowed=%v", posts, allowed)
							}
						}
					}
					// Profile content: a teaser is a 404, never an empty list or count.
					fullProfile := profile == "public" || role <= roleFollower
					profilePosts := w.do(role, "GET", "/users/1/posts", "")
					profileComments := w.do(role, "GET", "/users/1/comments", "")
					if !fullProfile {
						if profilePosts.Code != 404 || profileComments.Code != 404 {
							t.Fatalf("teaser profile content = %d/%d, want 404", profilePosts.Code, profileComments.Code)
						}
					} else {
						if profilePosts.Code != 200 || profileComments.Code != 200 {
							t.Fatalf("profile content = %d/%d", profilePosts.Code, profileComments.Code)
						}
						wantCount := map[bool]int{true: 1, false: 0}[allowed]
						if got := total(t, w.json(profilePosts)); got != wantCount {
							t.Fatalf("profile posts total %d, want %d", got, wantCount)
						}
						if got := total(t, w.json(profileComments)); got != wantCount {
							t.Fatalf("profile comments total %d, want %d", got, wantCount)
						}
						if !allowed {
							assertNoSecrets(t, "profile content", profilePosts.Body.String()+profileComments.Body.String())
						}
					}
					other := w.do(role, "GET", "/users/2/comments", "")
					assertSocialCode(t, other, 200, "")
					if got, wantCount := total(t, w.json(other)), map[bool]int{true: 1, false: 0}[allowed]; got != wantCount {
						t.Fatalf("subject comments total %d, want %d", got, wantCount)
					}
					// Private histories are owner-only and omit inaccessible parents.
					activity := w.do(role, "GET", "/users/activity", "")
					assertSocialCode(t, activity, 200, "")
					sections := w.json(activity)["data"].(map[string]any)
					count := func(name string) int {
						return int(sections[name].(map[string]any)["pagination"].(map[string]any)["total"].(float64))
					}
					wantOwn := map[bool]int{true: 1, false: 0}[allowed]
					wantLiked := wantOwn
					wantCreated := 0
					if role == roleOwner {
						wantCreated, wantLiked = 1, 0
					}
					if count("created_posts") != wantCreated || count("liked_posts") != wantLiked || count("comments") != wantOwn || count("disliked_posts") != 0 {
						t.Fatalf("activity counts %v, want created=%d liked=%d comments=%d", sections, wantCreated, wantLiked, wantOwn)
					}
					if !allowed {
						assertNoSecrets(t, "activity", activity.Body.String())
					}
					liked := w.do(role, "GET", "/posts/liked", "")
					assertSocialCode(t, liked, 200, "")
					if got := total(t, w.json(liked)); got != wantLiked {
						t.Fatalf("liked total %d, want %d", got, wantLiked)
					}
					// Notices: list, total, unread badge and read-one follow current access.
					if role != roleOwner {
						notices := w.do(role, "GET", "/notifications", "")
						assertSocialCode(t, notices, 200, "")
						body := w.json(notices)
						if got := total(t, body); got != wantOwn+map[bool]int{true: map[bool]int{true: 1, false: 0}[role == roleSelected], false: 0}[allowed] {
							t.Fatalf("notice total %d for allowed=%v", got, allowed)
						}
						if unread := int(body["data"].(map[string]any)["unread_count"].(float64)); unread != total(t, body) {
							t.Fatalf("unread badge %d != visible total %d", unread, total(t, body))
						}
						if !allowed {
							assertNoSecrets(t, "notices", notices.Body.String())
							assertSocialCode(t, w.do(role, "PATCH", fmt.Sprintf("/notifications/%d/read", w.notice[role]), ""), 404, "")
						}
					}
					// Mutations: denied actors change nothing; allowed ones succeed.
					before := publishingStateSnapshot(t, w.conn)
					writes := []struct {
						method, path, body string
						ok                 int
					}{
						{"POST", "/posts/10/comments", `{"body":"attempt"}`, 201},
						{"POST", "/posts/10/like", "", 200},
						{"POST", "/posts/10/dislike", "", 200},
						{"POST", "/comments/21/like", "", 200},
						{"POST", "/comments/21/dislike", "", 200},
					}
					for _, mutation := range writes {
						rec := w.do(role, mutation.method, mutation.path, mutation.body)
						expect := mutation.ok
						if !allowed {
							expect = 404
						}
						if rec.Code != expect {
							t.Fatalf("%s %s = %d %s, want %d", mutation.method, mutation.path, rec.Code, rec.Body.String(), expect)
						}
					}
					foreign := w.do(role, "PATCH", fmt.Sprintf("/comments/%d", w.ownerComment), `{"expected_version":1,"body":"hijack"}`)
					if role == roleOwner {
						assertSocialCode(t, foreign, 200, "")
					} else {
						assertSocialCode(t, foreign, 404, "")
					}
					ownEdit := w.do(role, "PATCH", fmt.Sprintf("/comments/%d", 20+role-1), `{"expected_version":1,"body":"own edit"}`)
					switch {
					case role == roleOwner:
						assertSocialCode(t, ownEdit, 404, "")
					case allowed:
						assertSocialCode(t, ownEdit, 200, "")
					default:
						assertSocialCode(t, ownEdit, 404, "")
					}
					if !allowed {
						if after := publishingStateSnapshot(t, w.conn); fmt.Sprint(before) != fmt.Sprint(after) {
							t.Fatalf("denied actor mutated content")
						}
					}
					w.reset()
					fixtureExec(t, w.conn, `UPDATE comments SET content_version=1,body='SECRET-OWNER-COMMENT' WHERE id=?`, w.ownerComment)
				})
			}
		}
	}
}
