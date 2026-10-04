package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
)

func profileTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := InitDB(context.Background(), filepath.Join(t.TempDir(), "profiles.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	for id := 1; id <= 3; id++ {
		if _, err := database.Exec(`INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,display_name_search) VALUES(?,?,?,'hash','Test','Person','2000-01-01','test person')`, id, fmt.Sprintf("user%d", id), fmt.Sprintf("user%d@example.com", id)); err != nil {
			t.Fatal(err)
		}
	}
	return database
}
func TestProfilesUpgradePreservesVersionedData(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	initial, err := migrationFS.ReadFile("migrations/sqlite/000001_initial.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	oldFiles := fstest.MapFS{"migrations/sqlite/000001_initial.up.sql": &fstest.MapFile{Data: initial}}
	database, err := initDBWithMigrations(ctx, path, oldFiles)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,nickname,avatar_key) VALUES(42,'compat','old@example.com','hash','Άννα','Example','2000-02-29','ΆΝΝΑ','kept.png');
 INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth) VALUES(43,'second','second@example.com','hash','Second','Person','2000-01-01');
 INSERT INTO sessions(id,user_id,token,ip,user_agent) VALUES(3,42,'retained-token','','');
 INSERT INTO posts(id,author_id,title,body) VALUES(8,42,'Kept title','Kept body');
 INSERT INTO comments(id,post_id,user_id,body) VALUES(9,8,42,'Kept comment');
 INSERT INTO post_categories(post_id,category_id) VALUES(8,1);
 INSERT INTO reactions(id,user_id,post_id,value) VALUES(10,42,8,1);
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,is_read) VALUES(11,42,42,'post_like',8,1);
 INSERT INTO private_messages(id,sender_id,recipient_id,body) SELECT 12,42,id,'Kept DM' FROM users WHERE id<>42;`)
	if err != nil {
		t.Fatal(err)
	}
	bytes := []byte("retained image bytes")
	image := filepath.Join(filepath.Dir(path), "media", "objects", "kept.png")
	if err := os.WriteFile(image, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	database.Close()
	for start := 0; start < 2; start++ {
		database, err = InitDB(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		var version int
		var visibility, key string
		if err := database.QueryRow(`SELECT profile_visibility,display_name_search,profile_version FROM users WHERE id=42`).Scan(&visibility, &key, &version); err != nil {
			t.Fatal(err)
		}
		if visibility != "public" || key != "άννα" || version != 1 {
			t.Fatalf("backfill=%s %s %d", visibility, key, version)
		}
		account, err := GetAccount(ctx, database, 42)
		if err != nil || account.Email != "old@example.com" || account.AvatarURL == nil {
			t.Fatalf("account %v %v", account, err)
		}
		if session, err := GetSessionByToken(ctx, database, "retained-token"); err != nil || session.UserID != 42 {
			t.Fatalf("session=%v %v", session, err)
		}
		for _, table := range []string{"posts", "comments", "post_categories", "reactions", "notifications", "private_messages"} {
			var count int
			if err := database.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 1 {
				t.Fatalf("%s count %d err %v", table, count, err)
			}
		}
		var read int
		if err := database.QueryRow(`SELECT is_read FROM notifications WHERE id=11`).Scan(&read); err != nil || read != 1 {
			t.Fatal("notification read flag lost")
		}
		data, err := os.ReadFile(image)
		if err != nil || string(data) != string(bytes) {
			t.Fatal("avatar bytes lost")
		}
		database.Close()
	}
}
func TestProfilesFailedUpgradeAndBackfillRefuseReadiness(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "fail.db")
	initial, _ := migrationFS.ReadFile("migrations/sqlite/000001_initial.up.sql")
	files := fstest.MapFS{"migrations/sqlite/000001_initial.up.sql": &fstest.MapFile{Data: initial}}
	database, err := initDBWithMigrations(ctx, path, files)
	if err != nil {
		t.Fatal(err)
	}
	database.Close()
	files["migrations/sqlite/000002_broken.up.sql"] = &fstest.MapFile{Data: []byte("INVALID SQL;")}
	if opened, err := initDBWithMigrations(ctx, path, files); err == nil {
		opened.Close()
		t.Fatal("failed upgrade served")
	}
	if opened, err := InitDB(ctx, path); err == nil {
		opened.Close()
		t.Fatal("dirty upgrade served")
	}
	database = profileTestDB(t)
	if _, err := database.Exec(`UPDATE users SET display_name_search='' WHERE id=1; CREATE TRIGGER fail_backfill BEFORE UPDATE OF display_name_search ON users BEGIN SELECT RAISE(ABORT,'backfill failed'); END;`); err != nil {
		t.Fatal(err)
	}
	if err := BackfillProfileSearch(ctx, database); err == nil {
		t.Fatal("failed backfill accepted")
	}
	var key string
	if err := database.QueryRow(`SELECT display_name_search FROM users WHERE id=1`).Scan(&key); err != nil || key != "" {
		t.Fatal("partial backfill")
	}
	if _, err := database.Exec(`DROP TRIGGER fail_backfill`); err != nil {
		t.Fatal(err)
	}
	if err := BackfillProfileSearch(ctx, database); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT display_name_search FROM users WHERE id=1`).Scan(&key); err != nil || key != "test person" {
		t.Fatal("backfill did not recover")
	}
}
func TestProfilesFollowConstraints(t *testing.T) {
	database := profileTestDB(t)
	for _, query := range []string{
		`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,1,'pending')`,
		`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,99,'pending')`,
		`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,2,'rejected')`,
		`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,2,'accepted')`,
		`INSERT INTO follows(follower_id,followed_id,state,accepted_at) VALUES(1,2,'pending','2026-10-02T12:00:00Z')`,
	} {
		if _, err := database.Exec(query); err == nil {
			t.Fatalf("invalid follow accepted: %s", query)
		}
	}
	if _, err := database.Exec(`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,2,'pending')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO follows(follower_id,followed_id,state) VALUES(1,2,'pending')`); err == nil {
		t.Fatal("duplicate pair accepted")
	}
}
func TestProfilesFollowConcurrencyAndStaleIdentity(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	if _, err := database.Exec(`UPDATE users SET profile_visibility='private' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	const n = 16
	start := make(chan struct{})
	results := make(chan Follow, n)
	created := make(chan bool, n)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			f, new, err := CreateFollow(ctx, database, 1, 2)
			results <- f
			created <- new
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	var id int64
	winners := 0
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		f := <-results
		if id == 0 {
			id = f.ID
		}
		if f.ID != id || f.State != "pending" {
			t.Fatal("contradictory concurrent follows")
		}
		if <-created {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("created %d relationships", winners)
	}
	if _, err := RemoveFollow(ctx, database, 1, id); err != nil {
		t.Fatal(err)
	}
	replacement, _, err := CreateFollow(ctx, database, 1, 2)
	if err != nil || replacement.ID <= id {
		t.Fatalf("reused ID: %v %v", replacement, err)
	}
	if _, err := DecideFollow(ctx, database, 2, id, "accept"); !errors.Is(err, ErrStaleFollow) {
		t.Fatalf("old acceptance: %v", err)
	}
	if _, err := RemoveFollow(ctx, database, 1, id); !errors.Is(err, ErrStaleFollow) {
		t.Fatalf("old removal: %v", err)
	}
	p, err := GetProfile(ctx, database, 1, 2)
	if err != nil || p.Access != "teaser" || p.Relationship.FollowID == nil || *p.Relationship.FollowID != replacement.ID {
		t.Fatalf("replacement changed: %v %v", p, err)
	}
}
func TestProfilesPrivacyFollowRaces(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	for _, visibility := range []string{"public", "private"} {
		t.Run(visibility, func(t *testing.T) {
			for iteration := 0; iteration < 12; iteration++ {
				if _, err := database.Exec(`DELETE FROM follows; UPDATE users SET profile_visibility=?,profile_version=1 WHERE id=2`, visibility); err != nil {
					t.Fatal(err)
				}
				next := "private"
				if visibility == "private" {
					next = "public"
				}
				start := make(chan struct{})
				errs := make(chan error, 2)
				go func() { <-start; _, _, err := CreateFollow(ctx, database, 1, 2); errs <- err }()
				go func() { <-start; _, err := ChangePrivacy(ctx, database, 2, next, 1); errs <- err }()
				close(start)
				for i := 0; i < 2; i++ {
					if err := <-errs; err != nil {
						t.Fatal(err)
					}
				}
				var state string
				if err := database.QueryRow(`SELECT state FROM follows WHERE follower_id=1 AND followed_id=2`).Scan(&state); err != nil {
					t.Fatal(err)
				}
				if next == "public" && state != "accepted" {
					t.Fatalf("public switch left %s", state)
				}
				if next == "private" && state != "accepted" && state != "pending" {
					t.Fatal(state)
				}
			}
		})
	}
}
func TestProfilesPrivacyRollbackAndTxSeam(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	if _, err := database.Exec(`UPDATE users SET profile_visibility='private' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	f, _, err := CreateFollow(ctx, database, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TRIGGER fail_privacy BEFORE UPDATE OF profile_visibility ON users BEGIN SELECT RAISE(ABORT,'privacy failed'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := ChangePrivacy(ctx, database, 2, "public", 1); err == nil {
		t.Fatal("failed privacy succeeded")
	}
	p, err := GetProfile(ctx, database, 2, 2)
	if err != nil || p.Details.Visibility != "private" || *p.Details.Version != 1 {
		t.Fatal("partial privacy commit")
	}
	var state string
	if err := database.QueryRow(`SELECT state FROM follows WHERE id=?`, f.ID).Scan(&state); err != nil || state != "pending" {
		t.Fatal("partial auto-accept")
	}
	tx, err := BeginSocialWrite(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecideFollowTx(ctx, tx, 2, f.ID, "accept"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`INSERT INTO notifications(recipient_id,actor_id,type,post_id) VALUES(2,1,'follow_request',NULL)`); err == nil {
		t.Fatal("follow notice without a target was accepted")
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT state FROM follows WHERE id=?`, f.ID).Scan(&state); err != nil || state != "pending" {
		t.Fatal("caller transaction rollback failed")
	}
}

func TestProfilesAcceptCancelRace(t *testing.T) {
	ctx := context.Background()
	database := profileTestDB(t)
	if _, err := database.Exec(`UPDATE users SET profile_visibility='private' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		f, _, err := CreateFollow(ctx, database, 1, 2)
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		accepted := make(chan error, 1)
		removed := make(chan error, 1)
		go func() { <-start; _, err := DecideFollow(ctx, database, 2, f.ID, "accept"); accepted <- err }()
		go func() { <-start; _, err := RemoveFollow(ctx, database, 1, f.ID); removed <- err }()
		close(start)
		if err := <-removed; err != nil {
			t.Fatal(err)
		}
		if err := <-accepted; err != nil && !errors.Is(err, ErrStaleFollow) {
			t.Fatal(err)
		}
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM follows WHERE id=?`, f.ID).Scan(&count); err != nil || count != 0 {
			t.Fatal("accept resurrected cancelled row")
		}
	}
}
func TestProfilesSearchBackfillFailureStopsStartup(t *testing.T) {
	database := profileTestDB(t)
	var path string
	if err := database.QueryRow(`PRAGMA database_list`).Scan(new(int), new(string), &path); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE users SET display_name_search='' WHERE id=1;CREATE TRIGGER block_search BEFORE UPDATE OF display_name_search ON users BEGIN SELECT RAISE(ABORT,'search failed'); END`); err != nil {
		t.Fatal(err)
	}
	database.Close()
	if opened, err := InitDB(context.Background(), path); err == nil {
		opened.Close()
		t.Fatal("failed search backfill allowed readiness")
	}
	raw, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec(`DROP TRIGGER block_search`); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	opened, err := InitDB(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	var key string
	if err := opened.QueryRow(`SELECT display_name_search FROM users WHERE id=1`).Scan(&key); err != nil || key != "test person" {
		t.Fatal("recovery failed")
	}
}
func TestProfilesQASeedSearchKeys(t *testing.T) {
	database := profileTestDB(t)
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatal(err)
	}
	var missing int
	if err := database.QueryRow(`SELECT COUNT(*) FROM users WHERE display_name_search=''`).Scan(&missing); err != nil || missing != 0 {
		t.Fatalf("seed keys: %d %v", missing, err)
	}
}
