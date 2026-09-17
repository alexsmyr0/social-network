package tests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type reactionResp struct {
	PostID        int64 `json:"post_id,omitempty"`
	CommentID     int64 `json:"comment_id,omitempty"`
	Reaction      int   `json:"reaction"` // 1, -1, or 0
	LikesCount    int   `json:"likes_count"`
	DislikesCount int   `json:"dislikes_count"`
}

/*--------------------
  TEST POST REACTIONS
 -------------------- */

func TestAPIPostsReactionToggle_LikeThenUnlike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)

	// like
	r1 := doPostReaction(t, h, token, "/api/v1/posts/1/like")
	if r1.PostID != 1 {
		t.Fatalf("expected post_id=1 got %d", r1.PostID)
	}
	if r1.Reaction != 1 {
		t.Fatalf("expected reaction=1 after like, got %d", r1.Reaction)
	}
	if r1.LikesCount != 1 || r1.DislikesCount != 0 {
		t.Fatalf("expected likes=1 dislikes=0 got likes=%d dislikes=%d", r1.LikesCount, r1.DislikesCount)
	}

	// unlike (toggle off)
	r2 := doPostReaction(t, h, token, "/api/v1/posts/1/like")
	if r2.Reaction != 0 {
		t.Fatalf("expected reaction=0 after unlike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 0 {
		t.Fatalf("expected likes=0 dislikes=0 got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}
}

func TestAPIPostsReactionToggle_DislikeThenUndislike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)

	// dislike
	r1 := doPostReaction(t, h, token, "/api/v1/posts/1/dislike")
	if r1.PostID != 1 {
		t.Fatalf("expected post_id=1 got %d", r1.PostID)
	}
	if r1.Reaction != -1 {
		t.Fatalf("expected reaction=-1 after dislike, got %d", r1.Reaction)
	}
	if r1.LikesCount != 0 || r1.DislikesCount != 1 {
		t.Fatalf("expected likes=0 dislikes=1 got likes=%d dislikes=%d", r1.LikesCount, r1.DislikesCount)
	}

	// undislike (toggle off)
	r2 := doPostReaction(t, h, token, "/api/v1/posts/1/dislike")
	if r2.Reaction != 0 {
		t.Fatalf("expected reaction=0 after undislike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 0 {
		t.Fatalf("expected likes=0 dislikes=0 got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}
}

func TestAPIPostsReactionToggle_SwitchLikeToDislike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)

	// like first
	r1 := doPostReaction(t, h, token, "/api/v1/posts/1/like")
	if r1.PostID != 1 {
		t.Fatalf("expected post_id=1 got %d", r1.PostID)
	}
	if r1.Reaction != 1 || r1.LikesCount != 1 || r1.DislikesCount != 0 {
		t.Fatalf("expected reaction=1 likes=1 dislikes=0 got reaction=%d likes=%d dislikes=%d",
			r1.Reaction, r1.LikesCount, r1.DislikesCount)
	}

	// then switch to dislike
	r2 := doPostReaction(t, h, token, "/api/v1/posts/1/dislike")
	if r2.Reaction != -1 {
		t.Fatalf("expected reaction=-1 after switching to dislike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 1 {
		t.Fatalf("expected likes=0 dislikes=1 after switch got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}

	// clicking dislike again should remove it
	r3 := doPostReaction(t, h, token, "/api/v1/posts/1/dislike")
	if r3.Reaction != 0 || r3.LikesCount != 0 || r3.DislikesCount != 0 {
		t.Fatalf("expected reaction=0 likes=0 dislikes=0 after toggle off got reaction=%d likes=%d dislikes=%d",
			r3.Reaction, r3.LikesCount, r3.DislikesCount)
	}
}

/*----------------------
  TEST COMMENT REACTIONS
 ----------------------- */

func TestAPICommentsReactionToggle_LikeThenUnlike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)
	commentID := createComment(t, h, token, 1, "hello comment")

	// like
	r1 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/like", commentID))
	if r1.CommentID != commentID {
		t.Fatalf("expected comment_id=%d got %d", commentID, r1.CommentID)
	}
	if r1.Reaction != 1 {
		t.Fatalf("expected reaction=1 after like, got %d", r1.Reaction)
	}
	if r1.LikesCount != 1 || r1.DislikesCount != 0 {
		t.Fatalf("expected likes=1 dislikes=0 got likes=%d dislikes=%d", r1.LikesCount, r1.DislikesCount)
	}

	// unlike (toggle off)
	r2 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/like", commentID))
	if r2.Reaction != 0 {
		t.Fatalf("expected reaction=0 after unlike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 0 {
		t.Fatalf("expected likes=0 dislikes=0 got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}
}

func TestAPICommentsReactionToggle_DislikeThenUndislike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)
	commentID := createComment(t, h, token, 1, "hello comment")

	// dislike
	r1 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/dislike", commentID))
	if r1.CommentID != commentID {
		t.Fatalf("expected comment_id=%d got %d", commentID, r1.CommentID)
	}
	if r1.Reaction != -1 {
		t.Fatalf("expected reaction=-1 after dislike, got %d", r1.Reaction)
	}
	if r1.LikesCount != 0 || r1.DislikesCount != 1 {
		t.Fatalf("expected likes=0 dislikes=1 got likes=%d dislikes=%d", r1.LikesCount, r1.DislikesCount)
	}

	// undislike (toggle off)
	r2 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/dislike", commentID))
	if r2.Reaction != 0 {
		t.Fatalf("expected reaction=0 after undislike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 0 {
		t.Fatalf("expected likes=0 dislikes=0 got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}
}

func TestAPICommentsReactionToggle_SwitchLikeToDislike(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)
	commentID := createComment(t, h, token, 1, "hello comment")

	// like first
	r1 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/like", commentID))
	if r1.CommentID != commentID {
		t.Fatalf("expected comment_id=%d got %d", commentID, r1.CommentID)
	}
	if r1.Reaction != 1 || r1.LikesCount != 1 || r1.DislikesCount != 0 {
		t.Fatalf("expected reaction=1 likes=1 dislikes=0 got reaction=%d likes=%d dislikes=%d",
			r1.Reaction, r1.LikesCount, r1.DislikesCount)
	}

	// then switch to dislike
	r2 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/dislike", commentID))
	if r2.Reaction != -1 {
		t.Fatalf("expected reaction=-1 after switching to dislike, got %d", r2.Reaction)
	}
	if r2.LikesCount != 0 || r2.DislikesCount != 1 {
		t.Fatalf("expected likes=0 dislikes=1 after switch got likes=%d dislikes=%d", r2.LikesCount, r2.DislikesCount)
	}

	// clicking dislike again should remove it
	r3 := doPostReaction(t, h, token, fmt.Sprintf("/api/v1/comments/%d/dislike", commentID))
	if r3.Reaction != 0 || r3.LikesCount != 0 || r3.DislikesCount != 0 {
		t.Fatalf("expected reaction=0 likes=0 dislikes=0 after toggle off got reaction=%d likes=%d dislikes=%d",
			r3.Reaction, r3.LikesCount, r3.DislikesCount)
	}
}

/*-----------------------
  TEST AUTH ENFORCEMENT
 ------------------------ */

func TestAPIPostsReaction_RequiresAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	doPostReactionExpectStatus(
		t,
		h,
		"/api/v1/posts/1/like",
		http.StatusUnauthorized,
	)

	doPostReactionExpectStatus(
		t,
		h,
		"/api/v1/posts/1/dislike",
		http.StatusUnauthorized,
	)
}

func TestAPICommentsReaction_RequiresAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// create user + comment first
	token := registerAndLogin(t, h)
	commentID := createComment(t, h, token, 1, "auth test comment")

	doPostReactionExpectStatus(
		t,
		h,
		fmt.Sprintf("/api/v1/comments/%d/like", commentID),
		http.StatusUnauthorized,
	)

	doPostReactionExpectStatus(
		t,
		h,
		fmt.Sprintf("/api/v1/comments/%d/dislike", commentID),
		http.StatusUnauthorized,
	)
}

/*-----------------------
  TEST METHOD ENFORCEMENT
 ------------------------ */

func TestAPIPostsReaction_MethodNotAllowed(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()
	token := registerAndLogin(t, h)

	doRequestExpectStatus(t, h, http.MethodGet, "/api/v1/posts/1/like", token, http.StatusMethodNotAllowed)
	doRequestExpectStatus(t, h, http.MethodGet, "/api/v1/posts/1/dislike", token, http.StatusMethodNotAllowed)
}

func TestAPICommentsReaction_MethodNotAllowed(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)
	commentID := createComment(t, h, token, 1, "method check comment")

	doRequestExpectStatus(t, h, http.MethodGet, fmt.Sprintf("/api/v1/comments/%d/like", commentID), token, http.StatusMethodNotAllowed)
	doRequestExpectStatus(t, h, http.MethodGet, fmt.Sprintf("/api/v1/comments/%d/dislike", commentID), token, http.StatusMethodNotAllowed)
}

/*--------
  TEST 404
 --------- */

func TestAPIPostsReaction_NotFound(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)

	doRequestExpectStatus(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts/9999/like",
		token,
		http.StatusNotFound,
	)

	doRequestExpectStatus(
		t,
		h,
		http.MethodPost,
		"/api/v1/posts/9999/dislike",
		token,
		http.StatusNotFound,
	)
}

func TestAPICommentsReaction_NotFound(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := registerAndLogin(t, h)

	doRequestExpectStatus(
		t,
		h,
		http.MethodPost,
		"/api/v1/comments/9999/like",
		token,
		http.StatusNotFound,
	)

	doRequestExpectStatus(
		t,
		h,
		http.MethodPost,
		"/api/v1/comments/9999/dislike",
		token,
		http.StatusNotFound,
	)
}

/*---------------------------
  TEST MULTI USER AGGREGATION
 ---------------------------- */

// Comments side not needed. It is the same logic
func TestAPIPostsReaction_MultiUserAggregation(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	tokenA := registerAndLoginAs(t, h, "alice")
	tokenB := registerAndLoginAs(t, h, "bob")

	// Alice likes post
	r1 := doPostReaction(t, h, tokenA, "/api/v1/posts/1/like")
	if r1.LikesCount != 1 {
		t.Fatalf("expected likes=1 got %d", r1.LikesCount)
	}

	// Bob likes same post
	r2 := doPostReaction(t, h, tokenB, "/api/v1/posts/1/like")
	if r2.LikesCount != 2 {
		t.Fatalf("expected likes=2 got %d", r2.LikesCount)
	}

	// Alice unlikes
	r3 := doPostReaction(t, h, tokenA, "/api/v1/posts/1/like")
	if r3.LikesCount != 1 {
		t.Fatalf("expected likes=1 after alice unlikes got %d", r3.LikesCount)
	}

	// Bob still has his like
	if r3.DislikesCount != 0 {
		t.Fatalf("expected dislikes=0 got %d", r3.DislikesCount)
	}
}

/*--------
  HELPERS
 --------- */

func createComment(t *testing.T, h http.Handler, token string, postID int64, body string) int64 {
	t.Helper()

	reqBody := map[string]any{
		"body": body,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		t.Fatalf("marshal comment body: %v", err)
	}

	url := fmt.Sprintf("/api/v1/posts/%d/comments", postID)
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewBuffer(jsonBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "session_token="+token)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("create comment failed: %d url=%s body=%s", rec.Code, url, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v body=%s", err, rec.Body.String())
	}

	var resp struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(env.Data, &resp); err != nil {
		t.Fatalf("unmarshal comment: %v data=%s", err, string(env.Data))
	}
	if resp.ID == 0 {
		t.Fatalf("expected non-zero comment id, got 0 data=%s", string(env.Data))
	}

	return resp.ID
}

func registerAndLogin(t *testing.T, h http.Handler) string {
	t.Helper()

	// Register
	regBody := `{"username":"reactor","email":"reactor@example.com","password":"password123","first_name":"Reactor","last_name":"User","age":25,"gender":"other"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}

	// Login
	loginBody := `{"username":"reactor","password":"password123"}`
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d body=%s", rec.Code, rec.Body.String())
	}

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected Set-Cookie")
	}
	return strings.Split(strings.Split(setCookie, ";")[0], "=")[1]
}

func doPostReaction(t *testing.T, h http.Handler, token, url string) reactionResp {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, url, nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d url=%s body=%s", rec.Code, url, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v body=%s", err, rec.Body.String())
	}

	var resp reactionResp
	if err := json.Unmarshal(env.Data, &resp); err != nil {
		t.Fatalf("unmarshal response: %v data=%s", err, string(env.Data))
	}

	return resp
}

func doPostReactionExpectStatus(
	t *testing.T,
	h http.Handler,
	url string,
	expectedStatus int,
) {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, url, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != expectedStatus {
		t.Fatalf("expected %d, got %d url=%s body=%s",
			expectedStatus, rec.Code, url, rec.Body.String())
	}
}

func doRequestExpectStatus(t *testing.T, h http.Handler, method, url, token string, expected int) {
	t.Helper()

	req := httptest.NewRequest(method, url, nil)
	if token != "" {
		req.Header.Set("Cookie", "session_token="+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != expected {
		t.Fatalf("expected %d, got %d method=%s url=%s body=%s",
			expected, rec.Code, method, url, rec.Body.String())
	}
}

func registerAndLoginAs(t *testing.T, h http.Handler, username string) string {
	t.Helper()

	regBody := fmt.Sprintf(
		`{"username":"%s","email":"%s@example.com","password":"password123","first_name":"%s","last_name":"User","age":25,"gender":"other"}`,
		username, username, username,
	)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(regBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}

	loginBody := fmt.Sprintf(`{"username":"%s","password":"password123"}`, username)
	req = httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d body=%s", rec.Code, rec.Body.String())
	}

	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatalf("expected Set-Cookie")
	}
	return strings.Split(strings.Split(setCookie, ";")[0], "=")[1]
}
