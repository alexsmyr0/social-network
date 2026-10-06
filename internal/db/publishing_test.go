package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func publishingString(s string) *string { return &s }
func TestPublishingAudienceMatrix(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	mustExec(t, database, `INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(1,2,1,'accepted','2000-01-01')`)
	for _, profile := range []string{"public", "private"} {
		for _, audience := range []string{"public", "followers", "selected"} {
			for _, role := range []string{"outsider", "pending", "accepted", "selected"} {
				t.Run(profile+"/"+audience+"/"+role, func(t *testing.T) {
					mustExec(t, database, `DELETE FROM posts;DELETE FROM follows WHERE follower_id=3;UPDATE users SET profile_visibility=? WHERE id=1`, profile)
					if role == "pending" {
						mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state) VALUES(3,1,'pending')`)
					}
					if role == "accepted" || role == "selected" {
						mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at) VALUES(3,1,'accepted','2000-01-01')`)
					}
					ids := []int64{2}
					if role == "selected" {
						ids = append(ids, 3)
					}
					in := PublishingInput{Body: publishingString("body"), Audience: &audience}
					if audience == "selected" {
						in.HasSelections = true
						in.SelectedFollowerIDs = ids
					}
					p, err := WritePublishingPost(ctx, database, 1, 0, in, false)
					if err != nil {
						t.Fatal(err)
					}
					allowed := (profile == "public" || role == "accepted" || role == "selected") && (audience == "public" || audience == "followers" && (role == "accepted" || role == "selected") || audience == "selected" && role == "selected")
					read, err := GetPost(WithSocialViewer(ctx, 3), database, p.ID)
					if allowed {
						if err != nil {
							t.Fatal(err)
						}
						wire, _ := json.Marshal(read)
						if strings.Contains(string(wire), "selected_follower_ids") {
							t.Fatal("selection disclosure")
						}
					} else if !errors.Is(err, sql.ErrNoRows) {
						t.Fatalf("denied %v", err)
					}
					feed, err := PublishingFeed(ctx, database, 3, 1, 1, "all", "all", 0, false)
					want := 0
					if allowed {
						want = 1
					}
					if err != nil || feed.Total != want || len(feed.Posts) != want {
						t.Fatalf("feed %+v %v", feed, err)
					}
					owner, err := GetPost(WithSocialViewer(ctx, 1), database, p.ID)
					if err != nil || owner.SelectedFollowerIDs == nil || owner.NullableTitle != nil {
						t.Fatalf("owner %+v %v", owner, err)
					}
				})
			}
		}
	}
}
func TestPublishingLifecycleVersionsAndSelectionPruning(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	mustExec(t, database, `INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(1,2,1,'accepted','2000-01-01')`)
	signals := 0
	SetSocialInvalidationHook(func(ids []int64) { signals++ })
	t.Cleanup(func() { SetSocialInvalidationHook(nil) })
	p, err := WritePublishingPost(ctx, database, 1, 0, PublishingInput{}, true)
	if err != nil {
		t.Fatal(err)
	}
	if p.Version != 1 || p.Title != "" || p.Body != "" || p.Status != "draft" {
		t.Fatalf("empty draft %+v", p)
	}
	_, err = WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: 1, Status: publishingString("published")}, false)
	var field *ContentFieldError
	if !errors.As(err, &field) || field.Code != "CONTENT_REQUIRED" {
		t.Fatalf("empty publish %v", err)
	}
	p, err = WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: 1, Body: publishingString("ready"), Status: publishingString("published"), Audience: publishingString("selected"), HasSelections: true, SelectedFollowerIDs: []int64{2}}, false)
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `INSERT INTO comments(id,post_id,user_id,body)VALUES(10,?,3,'reply');INSERT INTO reactions(user_id,post_id,value)VALUES(3,?,1)`, p.ID, p.ID)
	priorSignals := signals
	unchanged, err := WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: p.Version, Body: &p.Body}, false)
	if err != nil || unchanged.Version != p.Version || signals != priorSignals {
		t.Fatalf("noop %+v %v signals=%d", unchanged, err, signals)
	}
	if _, err := WritePublishingPost(ctx, database, 2, p.ID, PublishingInput{ExpectedVersion: 999, Body: &p.Body}, false); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("foreign version disclosure %v", err)
	}
	if _, err := WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: 1, Body: &p.Body}, false); !errors.Is(err, ErrStaleContent) {
		t.Fatalf("stale %v", err)
	}
	if _, err := RemoveFollow(ctx, database, 2, 1); err != nil {
		t.Fatal(err)
	}
	p, err = GetPost(WithSocialViewer(ctx, 1), database, p.ID)
	if err != nil || p.Version != 3 || len(*p.SelectedFollowerIDs) != 0 {
		t.Fatalf("pruning %+v %v", p, err)
	}
	follow, _, err := CreateFollow(ctx, database, 2, 1)
	if err != nil || follow.ID == 1 {
		t.Fatalf("new identity %+v %v", follow, err)
	}
	if _, err := GetPost(WithSocialViewer(ctx, 2), database, p.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("refollow restored grant %v", err)
	}
	for _, audience := range []string{"public", "followers", "selected", "followers", "public"} {
		in := PublishingInput{ExpectedVersion: p.Version, Audience: &audience}
		if audience == "selected" {
			in.HasSelections = true
			in.SelectedFollowerIDs = []int64{2}
		}
		p, err = WritePublishingPost(ctx, database, 1, p.ID, in, false)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, status := range []string{"draft", "published"} {
		p, err = WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: p.Version, Status: &status}, false)
		if err != nil {
			t.Fatal(err)
		}
		_, e := GetPost(WithSocialViewer(ctx, 2), database, p.ID)
		if status == "draft" && !errors.Is(e, sql.ErrNoRows) || status == "published" && e != nil {
			t.Fatalf("publication visibility %v", e)
		}
	}
	var comments, reactions int
	if err := database.QueryRow(`SELECT (SELECT COUNT(*) FROM comments),(SELECT COUNT(*) FROM reactions)`).Scan(&comments, &reactions); err != nil || comments != 1 || reactions != 1 {
		t.Fatalf("discussion lost %d %d %v", comments, reactions, err)
	}
	if err := DeletePublishingPost(ctx, database, 1, p.ID, p.Version, false); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT (SELECT COUNT(*) FROM comments)+(SELECT COUNT(*) FROM reactions)`).Scan(&comments); err != nil || comments != 0 {
		t.Fatal("delete did not cascade")
	}
}
func TestPublishingSelectionConstraintsAndOverflow(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	mustExec(t, database, `INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(1,2,1,'accepted','2000-01-01');INSERT INTO follows(id,follower_id,followed_id,state)VALUES(2,3,1,'pending');INSERT INTO posts(id,author_id,body,audience)VALUES(10,1,'body','selected'),(11,1,'body','public'),(12,3,'body','selected')`)
	for _, pair := range [][2]int64{{10, 2}, {11, 1}, {12, 1}} {
		if _, err := database.Exec(`INSERT INTO post_selected_followers(post_id,follow_id)VALUES(?,?)`, pair[0], pair[1]); err == nil {
			t.Fatalf("invalid grant survived %v", pair)
		}
	}
	mustExec(t, database, `INSERT INTO post_selected_followers VALUES(10,1)`)
	for _, query := range []string{`UPDATE post_selected_followers SET follow_id=2 WHERE post_id=10`, `UPDATE post_selected_followers SET post_id=11 WHERE post_id=10`, `UPDATE post_selected_followers SET post_id=12 WHERE post_id=10`} {
		if _, err := database.Exec(query); err == nil {
			t.Fatal("raw update committed an invalid grant")
		}
	}
	mustExec(t, database, `DELETE FROM post_selected_followers;UPDATE users SET is_active=0 WHERE id=2`)
	if _, err := database.Exec(`INSERT INTO post_selected_followers VALUES(10,1)`); err == nil {
		t.Fatal("inactive grant committed")
	}
	mustExec(t, database, `UPDATE users SET is_active=1 WHERE id=2;INSERT INTO post_selected_followers VALUES(10,1);UPDATE posts SET content_version=9007199254740991 WHERE id=10`)
	if _, err := RemoveFollow(ctx, database, 2, 1); err == nil {
		t.Fatal("overflow committed unfollow")
	}
	var count int
	database.QueryRow(`SELECT COUNT(*) FROM follows WHERE id=1`).Scan(&count)
	if count != 1 {
		t.Fatal("overflow lost follow")
	}
	if _, err := database.Exec(`UPDATE follows SET followed_id=3 WHERE id=1`); err == nil {
		t.Fatal("reassigned grant")
	}
	if _, err := database.Exec(`UPDATE posts SET audience='public' WHERE id=10`); err == nil {
		t.Fatal("public retained grants")
	}
}
func TestPublishingAudienceUnfollowRace(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	for i := 0; i < 20; i++ {
		mustExec(t, database, `DELETE FROM posts;DELETE FROM follows;INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01')`)
		var follow int64
		database.QueryRow(`SELECT id FROM follows`).Scan(&follow)
		p, err := WritePublishingPost(ctx, database, 1, 0, PublishingInput{Body: publishingString("race")}, false)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		errs := make(chan error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, err := WritePublishingPost(ctx, database, 1, p.ID, PublishingInput{ExpectedVersion: p.Version, Audience: publishingString("selected"), HasSelections: true, SelectedFollowerIDs: []int64{2}}, false)
			errs <- err
		}()
		go func() { defer wg.Done(); <-start; _, err := RemoveFollow(ctx, database, 2, follow); errs <- err }()
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			var field *ContentFieldError
			if err != nil && !errors.As(err, &field) {
				t.Fatal(err)
			}
		}
		var grants int
		if err := database.QueryRow(`SELECT COUNT(*) FROM post_selected_followers`).Scan(&grants); err != nil || grants != 0 {
			t.Fatalf("race grant leak %d %v", grants, err)
		}
	}
}
func TestPublishingFollowingCategoryAndDrafts(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		_, err := WritePublishingPost(ctx, database, int64(i+1), 0, PublishingInput{Body: publishingString(fmt.Sprintf("post%d", i)), Audience: publishingString("followers"), HasCategories: true, CategoryIDs: []int64{1}}, false)
		if err != nil {
			t.Fatal(err)
		}
	}
	result, err := PublishingFeed(ctx, database, 3, 1, 1, "following", "all", 1, false)
	if err != nil || result.Total != 0 {
		t.Fatalf("initial following %+v %v", result, err)
	}
	if _, _, err := CreateFollow(ctx, database, 3, 1); err != nil {
		t.Fatal(err)
	}
	result, err = PublishingFeed(ctx, database, 3, 1, 1, "following", "all", 1, false)
	if err != nil || result.Total != 1 || result.Posts[0].AuthorID != 1 {
		t.Fatalf("older following %+v %v", result, err)
	}
	d, err := LatestPublishingDraft(ctx, database, 1)
	if err != nil || d != nil {
		t.Fatalf("empty latest %v %v", d, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := WritePublishingPost(ctx, database, 1, 0, PublishingInput{}, true); err != nil {
			t.Fatal(err)
		}
	}
	result, err = PublishingFeed(ctx, database, 1, 1, 50, "all", "draft", 0, true)
	if err != nil || result.Total != 2 {
		t.Fatalf("multiple drafts %+v %v", result, err)
	}
	d, err = LatestPublishingDraft(ctx, database, 1)
	if err != nil || d == nil || d.ID != result.Posts[0].ID {
		t.Fatalf("latest %+v %v", d, err)
	}
}
