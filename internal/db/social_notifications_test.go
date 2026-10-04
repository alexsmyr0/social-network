package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"testing/fstest"
)

func TestRelationshipNotificationsUpgrade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	files := fstest.MapFS{}
	for _, name := range []string{"000001_initial.up.sql", "000002_profiles_follows.up.sql"} {
		data, err := migrationFS.ReadFile("migrations/sqlite/" + name)
		if err != nil {
			t.Fatal(err)
		}
		files["migrations/sqlite/"+name] = &fstest.MapFile{Data: data}
	}
	database, err := initDBWithMigrations(ctx, path, files)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth) VALUES
 (1,'user1','u1@example.com','hash','One','User','2000-01-01'),(2,'user2','u2@example.com','hash','Two','User','2000-01-01');
 INSERT INTO posts(id,author_id,title,body) VALUES(1,2,'kept','body');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,is_read,created_at) VALUES
 (5,2,1,'comment',1,1,'2026-01-01T00:00:00Z'),(6,2,1,'post_like',1,0,'2026-01-02T00:00:00Z'),(900,1,2,'post_like',1,1,'2026-01-01T00:00:00Z');
 DELETE FROM notifications WHERE id=900;
 INSERT INTO follows(id,follower_id,followed_id,state,created_at) VALUES(201,1,2,'pending','2026-01-03T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	database.Close()
	calls := recordHook(t)
	for restart := 0; restart < 2; restart++ {
		database, err = InitDB(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		var count, read int
		var created string
		if err := database.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&count); err != nil || count != 3 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		if err := database.QueryRow(`SELECT is_read,created_at FROM notifications WHERE id=5`).Scan(&read, &created); err != nil || read != 1 || created != "2026-01-01T00:00:00Z" {
			t.Fatalf("history lost: %d %s %v", read, created, err)
		}
		if err := database.QueryRow(`SELECT is_read FROM notifications WHERE id=6`).Scan(&read); err != nil || read != 0 {
			t.Fatal("unread history lost", err)
		}
		var id int64
		var state string
		if err := database.QueryRow(`SELECT id,follow_state,created_at FROM notifications WHERE follow_id=201`).Scan(&id, &state, &created); err != nil || id <= 900 || state != "pending" || created != "2026-01-03T00:00:00Z" {
			t.Fatalf("backfill %d %s %s %v", id, state, created, err)
		}
		rows, err := database.Query(`PRAGMA foreign_key_check`)
		if err != nil {
			t.Fatal(err)
		}
		if rows.Next() {
			t.Fatal("broken FK")
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		if _, err := database.Exec(`INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state) VALUES(2,1,'follow_request',201,'pending')`); err == nil {
			t.Fatal("duplicate allowed")
		}
		for _, target := range []string{"NULL,'pending'", "201,NULL", "201,'unknown'"} {
			if _, err := database.Exec(`INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state) VALUES(2,1,'follow_request',` + target + `)`); err == nil {
				t.Fatal("invalid target allowed", target)
			}
		}
		database.Close()
	}
	if len(calls()) != 0 {
		t.Fatal("migration announced historical requests")
	}
}

func TestRelationshipNotificationsAtomicTransitionsAndSilence(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	if _, err := database.Exec(`UPDATE users SET profile_visibility='private' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	calls := recordHook(t)
	newSignals := 0
	invalidations := 0
	SetSocialInvalidationHook(func(ids []int64) { invalidations++ })
	t.Cleanup(func() { SetSocialInvalidationHook(nil) })
	// Observe the row from a different DB connection inside the post-commit hook.
	SetNotificationHook(func(recipient int64) {
		newSignals++
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM follows f JOIN notifications n ON n.follow_id=f.id WHERE n.recipient_id=?`, recipient).Scan(&count); err != nil || count != 1 {
			t.Errorf("hook preceded commit: %d %v", count, err)
		}
	})
	if _, err := database.Exec(`CREATE TRIGGER fail_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CreateFollow(ctx, database, 1, 2); err == nil {
		t.Fatal("notice failure succeeded")
	}
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM follows`).Scan(&count); err != nil || count != 0 {
		t.Fatal("partial relationship", err)
	}
	if invalidations != 0 || newSignals != 0 || len(calls()) != 0 {
		t.Fatal("rollback signalled")
	}
	if _, err := database.Exec(`DROP TRIGGER fail_notice`); err != nil {
		t.Fatal(err)
	}
	// A deferred FK fails at COMMIT, after every statement succeeded.
	if _, err := database.Exec(`CREATE TABLE commit_probe(user_id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED);
 CREATE TRIGGER fail_commit AFTER INSERT ON notifications BEGIN INSERT INTO commit_probe VALUES(999); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CreateFollow(ctx, database, 1, 2); err == nil {
		t.Fatal("failed commit succeeded")
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM follows`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed commit retained relationship", count, err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed commit retained notice", count, err)
	}
	if newSignals != 0 || invalidations != 0 {
		t.Fatal("failed commit emitted signals")
	}
	if _, err := database.Exec(`DROP TRIGGER fail_commit; DROP TABLE commit_probe`); err != nil {
		t.Fatal(err)
	}
	f, created, err := CreateFollow(ctx, database, 1, 2)
	if err != nil || !created {
		t.Fatal(f, created, err)
	}
	if newSignals != 1 {
		t.Fatal("new notice signal count", newSignals)
	}
	SetNotificationHook(nil)
	if _, created, err := CreateFollow(ctx, database, 1, 2); err != nil || created || invalidations != 1 {
		t.Fatal("duplicate creation", created, err, invalidations)
	}
	// A caller-owned transaction reconciles state and notice but rollback stays silent.
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollowTx(ctx, tx, 2, f.ID, "accept"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, f.ID, "pending", false)
	if invalidations != 1 {
		t.Fatal("transaction signalled before commit")
	}
	if _, err := database.Exec(`CREATE TRIGGER fail_resolution BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollow(ctx, database, 2, f.ID, "accept"); err == nil {
		t.Fatal("resolution failure succeeded")
	}
	if _, err := ChangePrivacy(ctx, database, 2, "public", 1); err == nil {
		t.Fatal("privacy resolution failure succeeded")
	}
	assertFollowNotice(t, database, f.ID, "pending", false)
	var state, visibility string
	if err := database.QueryRow(`SELECT state FROM follows WHERE id=?`, f.ID).Scan(&state); err != nil || state != "pending" {
		t.Fatal("partial accept", err)
	}
	if err := database.QueryRow(`SELECT profile_visibility FROM users WHERE id=2`).Scan(&visibility); err != nil || visibility != "private" {
		t.Fatal("partial privacy", err)
	}
	if invalidations != 1 {
		t.Fatal("failed resolution signalled")
	}
	if _, err := database.Exec(`DROP TRIGGER fail_resolution`); err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollow(ctx, database, 2, f.ID, "decline"); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, f.ID, "declined", true)
	retry, _, err := CreateFollow(ctx, database, 1, 2)
	if err != nil || retry.ID <= f.ID {
		t.Fatal(retry, err)
	}
	if _, err := DecideFollow(ctx, database, 2, f.ID, "accept"); !errors.Is(err, ErrStaleFollow) {
		t.Fatal("old ID acted on retry", err)
	}
	assertFollowNotice(t, database, retry.ID, "pending", false)
	if _, err := RemoveFollow(ctx, database, 1, retry.ID); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, retry.ID, "cancelled", true)
	accepted, _, err := CreateFollow(ctx, database, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollow(ctx, database, 2, accepted.ID, "accept"); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, accepted.ID, "accepted", true)
	if _, err := RemoveFollow(ctx, database, 1, accepted.ID); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, accepted.ID, "unfollowed", true)
	auto, _, err := CreateFollow(ctx, database, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ChangePrivacy(ctx, database, 2, "public", 1); err != nil {
		t.Fatal(err)
	}
	assertFollowNotice(t, database, auto.ID, "accepted", true)
	before := invalidations
	if _, err := ChangePrivacy(ctx, database, 2, "public", 2); err != nil {
		t.Fatal(err)
	}
	if before != invalidations {
		t.Fatal("no-op privacy signalled")
	}
	if _, _, err := CreateFollow(ctx, database, 3, 2); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM notifications WHERE actor_id=3`).Scan(&count); err != nil || count != 0 {
		t.Fatal("public follow created alert", err)
	}
}

func assertFollowNotice(t *testing.T, database *sql.DB, id int64, state string, read bool) {
	t.Helper()
	var got string
	var isRead bool
	if err := database.QueryRow(`SELECT follow_state,is_read FROM notifications WHERE follow_id=?`, id).Scan(&got, &isRead); err != nil || got != state || isRead != read {
		t.Fatalf("notice %d = %s/%v want %s/%v err=%v", id, got, isRead, state, read, err)
	}
}

func TestRelationshipNotificationRaces(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	for _, race := range []string{"decline-retry", "cancel-accept", "privacy-create"} {
		t.Run(race, func(t *testing.T) {
			for attempt := 0; attempt < 10; attempt++ {
				if _, err := database.Exec(`DELETE FROM notifications;DELETE FROM follows;UPDATE users SET profile_visibility='private',profile_version=1 WHERE id=2`); err != nil {
					t.Fatal(err)
				}
				f, _, err := CreateFollow(ctx, database, 1, 2)
				if err != nil {
					t.Fatal(err)
				}
				start := make(chan struct{})
				var wg sync.WaitGroup
				operations := []func() error{}
				switch race {
				case "decline-retry":
					operations = []func() error{
						func() error { _, err := DecideFollow(ctx, database, 2, f.ID, "decline"); return err },
						func() error { _, _, err := CreateFollow(ctx, database, 1, 2); return err },
					}
				case "cancel-accept":
					operations = []func() error{
						func() error { _, err := RemoveFollow(ctx, database, 1, f.ID); return err },
						func() error { _, err := DecideFollow(ctx, database, 2, f.ID, "accept"); return err },
					}
				case "privacy-create":
					operations = []func() error{
						func() error { _, err := ChangePrivacy(ctx, database, 2, "public", 1); return err },
						func() error { _, _, err := CreateFollow(ctx, database, 3, 2); return err },
					}
				}
				for _, op := range operations {
					wg.Add(1)
					go func(op func() error) {
						defer wg.Done()
						<-start
						if err := op(); err != nil && !errors.Is(err, ErrStaleFollow) {
							t.Error(err)
						}
					}(op)
				}
				close(start)
				wg.Wait()
				var invalid int
				if err := database.QueryRow(`SELECT COUNT(*) FROM notifications n LEFT JOIN follows f ON f.id=n.follow_id
 WHERE n.follow_state='pending' AND (f.id IS NULL OR f.state<>'pending' OR f.follower_id<>n.actor_id OR f.followed_id<>n.recipient_id)`).Scan(&invalid); err != nil || invalid != 0 {
					t.Fatal("obsolete pending notice", invalid, err)
				}
				if err := database.QueryRow(`SELECT COUNT(*) FROM follows f LEFT JOIN notifications n ON n.follow_id=f.id WHERE f.state='pending' AND n.id IS NULL`).Scan(&invalid); err != nil || invalid != 0 {
					t.Fatal("pending without notice", invalid, err)
				}
				if err := database.QueryRow(`SELECT COUNT(*) FROM notifications WHERE follow_state<>'pending' AND is_read=0`).Scan(&invalid); err != nil || invalid != 0 {
					t.Fatal("resolved unread notice", invalid, err)
				}
			}
		})
	}
}

func TestSocialNoticeFilteringPaginationAndReadState(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	_, err := database.Exec(`UPDATE users SET profile_visibility='private' WHERE id IN(1,3);
 INSERT INTO posts(id,author_id,title,body,status) VALUES(1,1,'Hidden','body','published'),(2,2,'Visible','body','published'),(3,2,'Draft','body','draft');
 INSERT INTO comments(id,post_id,user_id,body) VALUES(1,2,3,'αβγδεζηθικλμνξοπρστυφχψω');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,is_read,created_at) VALUES
 (1,2,3,'post_like',1,0,'2026-01-01T00:00:00Z'),(2,2,3,'comment',2,0,'2026-01-01T00:00:00Z'),(3,2,3,'post_like',3,0,'2026-01-01T00:00:00Z'),(4,1,2,'post_like',2,0,'2026-01-01T00:00:00Z');
 INSERT INTO notifications(id,recipient_id,actor_id,type,comment_id,created_at) VALUES(5,2,3,'comment_like',1,'2026-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	first, err := ListSocialNotifications(ctx, database, 2, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 2 || first.UnreadCount != 2 || len(first.Notifications) != 1 || first.Notifications[0].ID != 5 {
		t.Fatal(first)
	}
	n := first.Notifications[0]
	if n.Actor.Access != "teaser" || n.Actor.AvatarURL != nil || *n.Target.Excerpt != "αβγδεζηθικλμνξοπρστυ" {
		t.Fatal(n)
	}
	second, err := ListSocialNotifications(ctx, database, 2, 2, 1)
	if err != nil || second.UnreadCount != 2 || second.Notifications[0].Target.Excerpt != nil {
		t.Fatal("fabricated excerpt", second, err)
	}
	outside, err := ListSocialNotifications(ctx, database, 2, 3, 1)
	if err != nil || outside.Total != 2 || outside.UnreadCount != 2 || len(outside.Notifications) != 0 {
		t.Fatal(outside, err)
	}
	for _, id := range []int64{1, 3, 4, 999} {
		if err := MarkSocialNotificationsRead(ctx, database, 2, id); !errors.Is(err, ErrNotFound) {
			t.Fatal("hidden/foreign mark", id, err)
		}
	}
	if err := MarkSocialNotificationsRead(ctx, database, 2, 0); err != nil {
		t.Fatal(err)
	}
	rows, err := database.Query(`SELECT id FROM notifications WHERE is_read=1 ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if !reflect.DeepEqual(ids, []int64{2, 5}) {
		t.Fatal("read-all changed hidden/foreign state", ids)
	}
	if _, _, err := CreateFollow(ctx, database, 2, 1); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := database.QueryRow(`SELECT id FROM follows WHERE follower_id=2 AND followed_id=1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollow(ctx, database, 1, id, "accept"); err != nil {
		t.Fatal(err)
	}
	restored, err := ListSocialNotifications(ctx, database, 2, 1, 20)
	if err != nil || restored.Total != 3 || restored.UnreadCount != 1 {
		t.Fatal("restored read state", restored, err)
	}
	if _, err := database.Exec(`DELETE FROM comments WHERE id=1;DELETE FROM posts WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	remaining, err := ListSocialNotifications(ctx, database, 2, 1, 20)
	if err != nil || remaining.Total != 1 {
		t.Fatal("deleted target visible", remaining, err)
	}
}
