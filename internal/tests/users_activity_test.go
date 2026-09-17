package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUserActivity_RequiresAuth(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/activity", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestUserActivity_ReturnsCreatedLikedDislikedAndComments(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	token := loginAndGetToken(t, h, "testuser", "password123")

	likedPostID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Activity liked post",
		"body":         "body",
		"category_ids": []int64{1},
	})

	dislikedPostID := createPostAndGetID(t, h, token, map[string]any{
		"title":        "Activity disliked post",
		"body":         "body",
		"category_ids": []int64{1},
	})

	reactToPost(t, h, token, likedPostID, "like")
	reactToPost(t, h, token, dislikedPostID, "dislike")

	commentID := createComment(t, h, token, likedPostID, "Activity comment")
	reactToComment(t, h, token, commentID, "like")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/activity?page=1&per_page=20", nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var env apiEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.Error != nil {
		t.Fatalf("unexpected error: %+v", env.Error)
	}

	var data struct {
		CreatedPosts struct {
			Items []struct {
				ID    int64  `json:"id"`
				Title string `json:"title"`
			} `json:"items"`
			Pagination struct {
				Page       int `json:"page"`
				PerPage    int `json:"per_page"`
				Total      int `json:"total"`
				TotalPages int `json:"total_pages"`
			} `json:"pagination"`
		} `json:"created_posts"`
		LikedPosts struct {
			Items []struct {
				ID int64 `json:"id"`
			} `json:"items"`
			Pagination struct {
				Total int `json:"total"`
			} `json:"pagination"`
		} `json:"liked_posts"`
		DislikedPosts struct {
			Items []struct {
				ID int64 `json:"id"`
			} `json:"items"`
			Pagination struct {
				Total int `json:"total"`
			} `json:"pagination"`
		} `json:"disliked_posts"`
		Comments struct {
			Items []struct {
				ID         int64 `json:"id"`
				PostID     int64 `json:"post_id"`
				Likes      int   `json:"likes"`
				Dislikes   int   `json:"dislikes"`
				MyReaction int   `json:"my_reaction"`
				Post       struct {
					ID         int64  `json:"id"`
					Title      string `json:"title"`
					Likes      int    `json:"likes"`
					Dislikes   int    `json:"dislikes"`
					MyReaction int    `json:"my_reaction"`
					Categories []struct {
						ID   int64  `json:"id"`
						Name string `json:"name"`
					} `json:"categories"`
				} `json:"post"`
			} `json:"items"`
			Pagination struct {
				Total int `json:"total"`
			} `json:"pagination"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(env.Data, &data); err != nil {
		t.Fatalf("unmarshal data: %v data=%s", err, string(env.Data))
	}

	if data.CreatedPosts.Pagination.Page != 1 || data.CreatedPosts.Pagination.PerPage != 20 {
		t.Fatalf(
			"unexpected created_posts pagination values: page=%d per_page=%d",
			data.CreatedPosts.Pagination.Page,
			data.CreatedPosts.Pagination.PerPage,
		)
	}
	if data.CreatedPosts.Pagination.Total < 3 {
		t.Fatalf("expected at least 3 created posts (seed + 2 new), got %d", data.CreatedPosts.Pagination.Total)
	}

	if data.LikedPosts.Pagination.Total != 1 || len(data.LikedPosts.Items) != 1 {
		t.Fatalf(
			"expected liked_posts total/items to be 1/1, got %d/%d",
			data.LikedPosts.Pagination.Total,
			len(data.LikedPosts.Items),
		)
	}
	if data.LikedPosts.Items[0].ID != likedPostID {
		t.Fatalf("expected liked post id=%d, got %d", likedPostID, data.LikedPosts.Items[0].ID)
	}

	if data.DislikedPosts.Pagination.Total != 1 || len(data.DislikedPosts.Items) != 1 {
		t.Fatalf(
			"expected disliked_posts total/items to be 1/1, got %d/%d",
			data.DislikedPosts.Pagination.Total,
			len(data.DislikedPosts.Items),
		)
	}
	if data.DislikedPosts.Items[0].ID != dislikedPostID {
		t.Fatalf("expected disliked post id=%d, got %d", dislikedPostID, data.DislikedPosts.Items[0].ID)
	}

	if data.Comments.Pagination.Total != 1 || len(data.Comments.Items) != 1 {
		t.Fatalf(
			"expected comments total/items to be 1/1, got %d/%d",
			data.Comments.Pagination.Total,
			len(data.Comments.Items),
		)
	}

	comment := data.Comments.Items[0]
	if comment.ID != commentID {
		t.Fatalf("expected comment id=%d, got %d", commentID, comment.ID)
	}
	if comment.PostID != likedPostID {
		t.Fatalf("expected comment post_id=%d, got %d", likedPostID, comment.PostID)
	}
	if comment.Post.ID != likedPostID {
		t.Fatalf("expected nested post.id=%d, got %d", likedPostID, comment.Post.ID)
	}
	if comment.Post.Title == "" {
		t.Fatalf("expected nested post title in comment activity")
	}
	if len(comment.Post.Categories) == 0 {
		t.Fatalf("expected nested post categories in comment activity")
	}
	if comment.Likes != 1 || comment.Dislikes != 0 {
		t.Fatalf("expected comment reaction counts 1 like / 0 dislikes, got %d / %d", comment.Likes, comment.Dislikes)
	}
	if comment.MyReaction != 1 {
		t.Fatalf("expected comment my_reaction=1, got %d", comment.MyReaction)
	}
	if comment.Post.Likes != 1 || comment.Post.Dislikes != 0 {
		t.Fatalf("expected nested post reaction counts 1 like / 0 dislikes, got %d / %d", comment.Post.Likes, comment.Post.Dislikes)
	}
	if comment.Post.MyReaction != 1 {
		t.Fatalf("expected nested post my_reaction=1, got %d", comment.Post.MyReaction)
	}
}

func reactToPost(t *testing.T, h http.Handler, token string, postID int64, reaction string) {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/%s", postID, reaction), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("reaction failed: %d body=%s", rec.Code, rec.Body.String())
	}
}

func reactToComment(t *testing.T, h http.Handler, token string, commentID int64, reaction string) {
	t.Helper()

	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/v1/comments/%d/%s", commentID, reaction), nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("comment reaction failed: %d body=%s", rec.Code, rec.Body.String())
	}
}
