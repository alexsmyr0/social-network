package db

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func mustExec(t *testing.T, database *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := database.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func TestContentPrivacyEveryProjectionAndMutation(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	mustExec(t, database, `UPDATE users SET nickname='Approved name',profile_visibility='private' WHERE id=1;
 INSERT INTO follows(id,follower_id,followed_id,state,accepted_at) VALUES(1,2,1,'accepted','2000-01-01');
 INSERT INTO posts(id,author_id,title,body,status,created_at) VALUES(10,1,'secret','private body','published','2000-01-01'),(11,1,'draft','draft body','draft','2000-01-02'),(12,3,'public','public body','published','2000-01-03');
 INSERT INTO post_categories(post_id,category_id) VALUES(10,1),(11,1),(12,1);
 INSERT INTO comments(id,post_id,user_id,body) VALUES(20,10,3,'hidden comment'),(21,12,1,'public thread comment');
 INSERT INTO reactions(user_id,post_id,value) VALUES(3,10,1),(3,12,-1);`)
	for _, tc := range []struct {
		viewer  int64
		visible bool
	}{{1, true}, {2, true}, {3, false}} {
		v := WithSocialViewer(ctx, tc.viewer)
		p, err := GetPost(v, database, 10)
		if tc.visible {
			if err != nil || p.Author != "Approved name" {
				t.Fatalf("viewer %d post=%+v err=%v", tc.viewer, p, err)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("denied detail %v", err)
		}
		list, err := ListPosts(v, database, ListPostsParams{Page: 1, PerPage: 1}, tc.viewer)
		if err != nil {
			t.Fatal(err)
		}
		want := 1
		if tc.visible {
			want = 2
		}
		if list.Total != want || len(list.Posts) != 1 || list.Posts[0].ID != 12 {
			t.Fatalf("filtered pagination %+v", list)
		}
		cat, err := ListPostsByCategory(v, database, ListPostsByCategoryParams{CategoryID: 1, Page: 1, PerPage: 10}, tc.viewer)
		if err != nil || cat.Total != want {
			t.Fatalf("category %+v %v", cat, err)
		}
		cats, err := ListCategoriesWithPosts(v, database, tc.viewer)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cats {
			if c.ID == 1 && len(c.Posts) != want {
				t.Fatalf("summary %+v", c)
			}
		}
		nav, err := GetPostNavigationByCategory(v, database, 12, 1)
		if err != nil {
			t.Fatal(err)
		}
		if tc.visible {
			if nav.PrevID == nil || *nav.PrevID != 10 {
				t.Fatalf("nav %+v", nav)
			}
		} else if nav.PrevID != nil {
			t.Fatalf("denied navigation %+v", nav)
		}
		_, err = GetPost(v, database, 11)
		if tc.viewer == 1 {
			if err != nil {
				t.Fatal(err)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("foreign draft %v", err)
		}
		comments, err := ListCommentsByPost(v, database, ListCommentsParams{PostID: 10, Page: 1, PerPage: 10}, tc.viewer)
		if tc.visible {
			if err != nil || comments.Total != 1 {
				t.Fatalf("comments %+v %v", comments, err)
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("denied comments %v", err)
		}
		publicComment, err := GetCommentWithAuthor(v, database, 21)
		if err != nil || publicComment.Username != "Approved name" {
			t.Fatalf("private commenter in public thread %+v %v", publicComment, err)
		}
	}
	v := WithSocialViewer(ctx, 3)
	if _, _, err := CountReactionsForPost(v, database, 10); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied reaction count %v", err)
	}
	if _, _, err := CountReactionsForComment(v, database, 20); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied comment count %v", err)
	}
	for _, value := range []int{1, -1} {
		if _, err := ToggleDiscussionReaction(v, database, 3, 10, value, "post"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("denied reaction %v", err)
		}
		if _, err := ToggleDiscussionReaction(v, database, 3, 20, value, "comment"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("denied comment reaction %v", err)
		}
	}
	if _, err := WriteDiscussionComment(v, database, 3, 10, 0, CommentInput{Body: testText("denied")}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied create %v", err)
	}
	body := "denied"
	if _, err := WriteDiscussionComment(v, database, 3, 0, 20, CommentInput{ExpectedVersion: 1, Body: &body}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied own comment update %v", err)
	}
	if err := DeleteDiscussionComment(v, database, 3, 20, 1); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied own comment delete %v", err)
	}
	if err := UpdatePostContent(v, database, 10, UpdatePostInput{Body: &body}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied update %v", err)
	}
	if err := DeletePost(v, database, 10); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("denied delete %v", err)
	}
	liked, err := ListPostsByUserReaction(v, database, ListPostsByUserReactionParams{UserID: 3, Page: 1, PerPage: 10, Reaction: 1}, 3)
	if err != nil || liked.Total != 0 {
		t.Fatalf("hidden likes %+v %v", liked, err)
	}
	disliked, err := ListPostsByUserReaction(v, database, ListPostsByUserReactionParams{UserID: 3, Page: 1, PerPage: 10, Reaction: -1}, 3)
	if err != nil || disliked.Total != 1 {
		t.Fatalf("dislikes %+v %v", disliked, err)
	}
	history, err := SocialActivity(v, database, 3, 1, 10, nil)
	if err != nil || history.Comments.Total != 0 || len(history.Comments.Comments) != 0 {
		t.Fatalf("hidden activity %+v %v", history, err)
	}
	mustExec(t, database, `DELETE FROM follows WHERE id=1`)
	if _, err := GetPost(WithSocialViewer(ctx, 2), database, 10); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("revoked access %v", err)
	}
	mustExec(t, database, `UPDATE users SET profile_visibility='public' WHERE id=1`)
	if _, err := GetPost(v, database, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteDiscussionComment(v, database, 3, 12, 0, CommentInput{ParentCommentID: pointerID(20), Body: testText("wrong parent")}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("cross-post parent %v", err)
	}
}
func pointerID(id int64) *int64 { return &id }
func testText(s string) *string { return &s }
func TestContentNotificationFailureRollsBackAndStaysSilent(t *testing.T) {
	database := profileTestDB(t)
	ctx := WithSocialViewer(context.Background(), 2)
	mustExec(t, database, `INSERT INTO posts(id,author_id,title,body) VALUES(10,1,'post','body');CREATE TRIGGER fail_content_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected notice failure');END;`)
	calls := 0
	SetNotificationHook(func(int64) { calls++ })
	t.Cleanup(func() { SetNotificationHook(nil) })
	if _, err := WriteDiscussionComment(ctx, database, 2, 10, 0, CommentInput{Body: testText("rollback")}); err == nil {
		t.Fatal("comment committed without notice")
	}
	if _, err := ToggleDiscussionReaction(ctx, database, 2, 10, 1, "post"); err == nil {
		t.Fatal("reaction committed without notice")
	}
	for _, table := range []string{"comments", "reactions", "notifications"} {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count=%d err=%v", table, count, err)
		}
	}
	if calls != 0 {
		t.Fatalf("rollback signaled %d", calls)
	}
	mustExec(t, database, `DROP TRIGGER fail_content_notice`)
	if _, err := WriteDiscussionComment(ctx, database, 2, 10, 0, CommentInput{Body: testText("committed")}); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteDiscussionComment(ctx, database, 2, 10, 0, CommentInput{Body: testText("dedup")}); err != nil {
		t.Fatal(err)
	}
	if _, err := ToggleDiscussionReaction(ctx, database, 2, 10, 1, "post"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("committed signals %d", calls)
	}
}

func TestContentMutationsObserveCommittedPrivacyWhileWaitingForWriter(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	mustExec(t, database, `INSERT INTO posts(id,author_id,title,body)VALUES(10,1,'post','body')`)
	privacy, err := BeginSocialWrite(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	defer privacy.Rollback()
	if _, err := privacy.ExecContext(ctx, `UPDATE users SET profile_visibility='private' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 2)
	started := make(chan struct{}, 2)
	viewer := WithSocialViewer(ctx, 2)
	go func() {
		started <- struct{}{}
		_, err := WriteDiscussionComment(viewer, database, 2, 10, 0, CommentInput{Body: testText("must not survive")})
		result <- err
	}()
	go func() {
		started <- struct{}{}
		_, err := ToggleDiscussionReaction(viewer, database, 2, 10, 1, "post")
		result <- err
	}()
	<-started
	<-started
	if err := privacy.Commit(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := <-result; !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("permission checked before serialized writer %v", err)
		}
	}
	for _, table := range []string{"comments", "reactions", "notifications"} {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("unauthorized %s=%d err=%v", table, count, err)
		}
	}
}
