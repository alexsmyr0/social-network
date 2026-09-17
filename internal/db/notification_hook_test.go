// internal/db/notification_hook_test.go
//
// The delivery hook is what lets the SPA drop its 5-second notification poll:
// the backend announces a new row down the WebSocket the client already has
// open. These tests pin the two properties that make that safe to rely on —
// it fires exactly once per row actually inserted, and never for a write that
// did not happen.
package db

import (
	"context"
	"database/sql"
	"sync"
	"testing"
)

// recordHook installs a counting hook and removes it when the test ends, so a
// leaked hook cannot bleed into another test in this package.
func recordHook(t *testing.T) func() []int64 {
	t.Helper()

	var (
		mu       sync.Mutex
		notified []int64
	)

	SetNotificationHook(func(recipientID int64) {
		mu.Lock()
		defer mu.Unlock()
		notified = append(notified, recipientID)
	})
	t.Cleanup(func() { SetNotificationHook(nil) })

	return func() []int64 {
		mu.Lock()
		defer mu.Unlock()
		return append([]int64(nil), notified...)
	}
}

func TestInsertNotificationAnnouncesTheRecipient(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	notified := recordHook(t)

	author := mustCreateUser(t, ctx, database, "author", "author@example.com")
	commenter := mustCreateUser(t, ctx, database, "commenter", "commenter@example.com")

	postID := seedPost(t, ctx, database, author)
	commentID, err := CreateComment(ctx, database, CreateCommentInput{
		PostID: postID,
		UserID: commenter,
		Body:   "nice post",
	})
	if err != nil {
		t.Fatalf("create comment: %v", err)
	}
	if commentID == 0 {
		t.Fatal("expected a comment id")
	}

	got := notified()
	if len(got) != 1 || got[0] != author {
		t.Fatalf("hook calls = %v, want exactly [%d]", got, author)
	}
}

// InsertNotification uses ON CONFLICT DO NOTHING, so a repeat is a no-op. It
// must stay silent rather than telling the client to refetch for nothing.
func TestDuplicateNotificationDoesNotAnnounce(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	notified := recordHook(t)

	author := mustCreateUser(t, ctx, database, "dupauthor", "dupauthor@example.com")
	actor := mustCreateUser(t, ctx, database, "dupactor", "dupactor@example.com")
	postID := seedPost(t, ctx, database, author)

	for i := 0; i < 3; i++ {
		if err := InsertNotification(ctx, database, author, actor, "post_like", &postID, nil); err != nil {
			t.Fatalf("insert notification %d: %v", i, err)
		}
	}

	if got := notified(); len(got) != 1 {
		t.Fatalf("hook fired %d times for one unique notification, want 1", len(got))
	}
}

// Self-actions never create a row, so they must never announce one.
func TestSelfNotificationDoesNotAnnounce(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	notified := recordHook(t)

	author := mustCreateUser(t, ctx, database, "selfauthor", "selfauthor@example.com")
	postID := seedPost(t, ctx, database, author)

	if err := InsertNotification(ctx, database, author, author, "post_like", &postID, nil); err != nil {
		t.Fatalf("insert notification: %v", err)
	}

	if got := notified(); len(got) != 0 {
		t.Fatalf("hook fired %v for a self-notification, want no calls", got)
	}
}

func TestReactionAnnouncesTheTargetOwner(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	notified := recordHook(t)

	author := mustCreateUser(t, ctx, database, "reactauthor", "reactauthor@example.com")
	reactor := mustCreateUser(t, ctx, database, "reactor", "reactor@example.com")
	postID := seedPost(t, ctx, database, author)

	if _, err := ToggleReaction(ctx, database, reactor, postID, 1, "post"); err != nil {
		t.Fatalf("toggle reaction: %v", err)
	}

	got := notified()
	if len(got) != 1 || got[0] != author {
		t.Fatalf("hook calls = %v, want exactly [%d]", got, author)
	}

	// Toggling the same reaction off removes it and creates nothing.
	before := len(got)
	if _, err := ToggleReaction(ctx, database, reactor, postID, 1, "post"); err != nil {
		t.Fatalf("untoggle reaction: %v", err)
	}
	if after := len(notified()); after != before {
		t.Fatalf("removing a reaction announced a notification (%d -> %d calls)", before, after)
	}
}

// The hook is optional: nothing in internal/db may depend on one being set.
func TestNotificationsWorkWithNoHookInstalled(t *testing.T) {
	database := setupTestDB(t)
	defer database.Close()
	ctx := context.Background()

	SetNotificationHook(nil)

	author := mustCreateUser(t, ctx, database, "nohookauthor", "nohookauthor@example.com")
	actor := mustCreateUser(t, ctx, database, "nohookactor", "nohookactor@example.com")
	postID := seedPost(t, ctx, database, author)

	if err := InsertNotification(ctx, database, author, actor, "post_like", &postID, nil); err != nil {
		t.Fatalf("insert notification without a hook: %v", err)
	}
}

func seedPost(t *testing.T, ctx context.Context, database *sql.DB, authorID int64) int64 {
	t.Helper()

	res, err := database.ExecContext(ctx,
		`INSERT INTO posts (author_id, title, body, status) VALUES (?, 'title', 'body', 'published')`,
		authorID,
	)
	if err != nil {
		t.Fatalf("seed post: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}
	return id
}
