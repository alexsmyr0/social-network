package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// groupPostPriorFiles is the schema as shipped before B19: every migration but 000007.
func groupPostPriorFiles(t *testing.T) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	names, err := fs.Glob(migrationFS, "migrations/sqlite/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.Contains(name, "000007_") {
			continue
		}
		b, err := migrationFS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = &fstest.MapFile{Data: b}
	}
	return files
}

var groupPostPriorTables = map[string]string{
	"users":                   "id,username,email,profile_visibility,profile_version",
	"sessions":                "id,user_id,token,is_valid",
	"follows":                 "id,follower_id,followed_id,state,accepted_at",
	"posts":                   "id,author_id,title,image_url,body,status,audience,content_version,created_at,updated_at",
	"post_categories":         "post_id,category_id",
	"post_selected_followers": "post_id,follow_id",
	"comments":                "id,post_id,user_id,parent_comment_id,body,image_url,content_version",
	"reactions":               "id,user_id,post_id,comment_id,value",
	"notifications":           "id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read",
	"media_objects":           "id,source_key,object_key,legacy_url,mime_type,byte_count,state",
	"media_links":             "id,media_id,avatar_user_id,post_id,comment_id,message_id",
	"groups":                  "id,creator_id,title,description,title_search",
	"group_memberships":       "id,group_id,user_id,role",
	"group_invitations":       "id,group_id,inviter_id,invitee_id",
	"group_join_requests":     "id,group_id,requester_id",
}

func seedPriorGroupPostData(t *testing.T, database *sql.DB) {
	t.Helper()
	seedPhase3Data(t, database)
	// Real private bytes, so startup reconciliation keeps the objects ready.
	image, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{70, 71, 72} {
		object := fmt.Sprintf("o%d.png", id)
		if err := os.WriteFile(filepath.Join(root, "objects", object), image, 0600); err != nil {
			t.Fatal(err)
		}
		mustExec(t, database, `INSERT INTO media_objects(id,source_key,object_key,mime_type,byte_count,state)VALUES(?,?,?,'image/png',?,'ready')`, id, fmt.Sprintf("k%d", id), object, len(image))
	}
	mustExec(t, database, `
 INSERT INTO posts(id,author_id,title,body,image_url,status,audience)VALUES(32,2,'pic','body','/api/v1/media/70','published','public'),(33,3,NULL,'archived','/api/v1/media/72','archived','public');
 INSERT INTO comments(id,post_id,user_id,parent_comment_id,body,image_url)VALUES(41,30,3,40,'nested','/api/v1/media/71');
 INSERT INTO post_categories(post_id,category_id)VALUES(30,1),(32,2);
 INSERT INTO reactions(id,user_id,post_id,value)VALUES(50,2,30,1);
 INSERT INTO reactions(id,user_id,comment_id,value)VALUES(51,1,41,-1);
 INSERT INTO groups(id,creator_id,title,description,title_search)VALUES(7,1,'Chess','Games','chess');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(7,2,'member');
 INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(7,2,3);
 INSERT INTO notifications(id,recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(80,3,2,'group_invitation',7,1,'pending');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,created_at)VALUES(81,2,1,'post_like',32,'2026-01-01T00:00:00Z');
 INSERT INTO posts(id,author_id,body)VALUES(900,1,'highest');DELETE FROM posts WHERE id=900;`)
}

func snapshotTables(t *testing.T, database *sql.DB) map[string]string {
	t.Helper()
	out := map[string]string{}
	for table, columns := range groupPostPriorTables {
		out[table] = tableSnapshot(t, database, table, columns)
	}
	return out
}

func TestGroupPostMigrationUpgradePreservesEverythingAndStaysPersonal(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "prior.db")
	old, err := initDBWithMigrations(ctx, path, groupPostPriorFiles(t))
	if err != nil {
		t.Fatal(err)
	}
	seedPriorGroupPostData(t, old)
	before := snapshotTables(t, old)
	var sequence int64
	old.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name='posts'`).Scan(&sequence)
	if sequence < 900 {
		t.Fatalf("fixture did not leave a deleted high post ID: %d", sequence)
	}
	old.Close()

	upgraded, err := initDBWithMigrations(ctx, path, migrationFS)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer upgraded.Close()
	for table, snapshot := range snapshotTables(t, upgraded) {
		if snapshot != before[table] {
			t.Fatalf("%s changed by upgrade\nbefore %s\nafter  %s", table, before[table], snapshot)
		}
	}
	if n := count(t, upgraded, `SELECT COUNT(*) FROM posts WHERE group_id IS NOT NULL`); n != 0 {
		t.Fatalf("%d existing posts became group posts", n)
	}
	if n := count(t, upgraded, `SELECT COUNT(*) FROM posts`); n != 4 {
		t.Fatalf("posts after upgrade: %d", n)
	}
	var after int64
	upgraded.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name='posts'`).Scan(&after)
	if after != sequence {
		t.Fatalf("post allocation %d, want preserved %d", after, sequence)
	}
	mustExec(t, upgraded, `INSERT INTO posts(author_id,body)VALUES(1,'next')`)
	if next := count(t, upgraded, `SELECT MAX(id) FROM posts`); int64(next) != sequence+1 {
		t.Fatalf("new post ID %d, want %d (a deleted ID is never reused)", next, sequence+1)
	}
	// The earlier triggers keep working: image links, selected grants and audiences.
	mustExec(t, upgraded, `INSERT INTO posts(id,author_id,body,image_url)VALUES(902,1,'again','/api/v1/media/71')`)
	if count(t, upgraded, `SELECT COUNT(*) FROM media_links WHERE post_id=902`) != 1 {
		t.Fatal("media link trigger stopped working")
	}
	mustFail(t, upgraded, "selected grant for a non-selected post", `INSERT INTO post_selected_followers(post_id,follow_id)VALUES(30,20)`)
	for _, object := range []struct{ kind, name string }{{"index", "idx_posts_group_feed"}, {"trigger", "group_post_insert"}, {"trigger", "group_post_scope_immutable"}, {"trigger", "group_post_audience_inert"}, {"index", "idx_posts_feed"}, {"index", "idx_posts_author_feed"}} {
		if count(t, upgraded, `SELECT COUNT(*) FROM sqlite_master WHERE type=? AND name=?`, object.kind, object.name) != 1 {
			t.Fatalf("missing %s %s", object.kind, object.name)
		}
	}
	var version, dirty int
	upgraded.QueryRow(`SELECT version,dirty FROM schema_migrations`).Scan(&version, &dirty)
	if version != 7 || dirty != 0 {
		t.Fatalf("version %d dirty %d", version, dirty)
	}
	rows, err := upgraded.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		t.Fatal("foreign key violation after upgrade")
	}
	rows.Close()

	// Repeated startup recreates nothing and changes nothing.
	snapshot := snapshotTables(t, upgraded)
	upgraded.Close()
	again, err := InitDB(ctx, path)
	if err != nil {
		t.Fatalf("repeated startup: %v", err)
	}
	defer again.Close()
	for table, got := range snapshotTables(t, again) {
		if got != snapshot[table] {
			t.Fatalf("repeated startup changed %s", table)
		}
	}
}

func TestGroupPostMigrationFailureLeavesDataAndBlocksReadiness(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "failed.db")
	old, err := initDBWithMigrations(ctx, path, groupPostPriorFiles(t))
	if err != nil {
		t.Fatal(err)
	}
	seedPriorGroupPostData(t, old)
	// A conflicting object makes the migration fail after its column was added.
	mustExec(t, old, `CREATE INDEX idx_posts_group_feed ON posts(id)`)
	before := snapshotTables(t, old)
	old.Close()
	if opened, err := initDBWithMigrations(ctx, path, migrationFS); err == nil {
		opened.Close()
		t.Fatal("failed migration allowed readiness")
	}
	if opened, err := InitDB(ctx, path); err == nil {
		opened.Close()
		t.Fatal("dirty database allowed readiness on restart")
	}
	raw, err := sql.Open("sqlite3", path+"?_foreign_keys=on")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	for table, snapshot := range snapshotTables(t, raw) {
		if snapshot != before[table] {
			t.Fatalf("failed migration changed %s", table)
		}
	}
	if count(t, raw, `SELECT COUNT(*) FROM pragma_table_info('posts') WHERE name='group_id'`) != 0 {
		t.Fatal("failed migration left a partial posts.group_id column")
	}
	if count(t, raw, `SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'group_post_%'`) != 0 {
		t.Fatal("failed migration left partial triggers")
	}
	var version, dirty int
	raw.QueryRow(`SELECT version,dirty FROM schema_migrations`).Scan(&version, &dirty)
	if version != 7 || dirty != 1 {
		t.Fatalf("dirty marker %d %d", version, dirty)
	}
}

func TestGroupPostSchemaEnforcesScopeAgainstRawWrites(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO groups(creator_id,title,description,title_search)VALUES(3,'Other','Games','other');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member');
 INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(9,3,2,'accepted','2000-01-01')`)
	mustExec(t, database, `INSERT INTO posts(id,author_id,body,group_id)VALUES(10,2,'member post',1)`)
	mustExec(t, database, `INSERT INTO posts(id,author_id,body,group_id)VALUES(11,1,'creator post',1)`)
	mustFail(t, database, "nonmember author", `INSERT INTO posts(author_id,body,group_id)VALUES(4,'x',1)`)
	mustFail(t, database, "author of another group", `INSERT INTO posts(author_id,body,group_id)VALUES(2,'x',2)`)
	mustFail(t, database, "unknown group", `INSERT INTO posts(author_id,body,group_id)VALUES(2,'x',99)`)
	mustFail(t, database, "personal audience on a group post", `INSERT INTO posts(author_id,body,group_id,audience)VALUES(2,'x',1,'followers')`)
	mustFail(t, database, "selected audience on a group post", `INSERT INTO posts(author_id,body,group_id,audience)VALUES(2,'x',1,'selected')`)
	mustFail(t, database, "group move", `UPDATE posts SET group_id=2 WHERE id=10`)
	mustFail(t, database, "group removal", `UPDATE posts SET group_id=NULL WHERE id=10`)
	mustFail(t, database, "audience change", `UPDATE posts SET audience='followers' WHERE id=10`)
	mustFail(t, database, "selected grants on group post", `INSERT INTO post_selected_followers(post_id,follow_id)VALUES(10,9)`)
	mustFail(t, database, "group deletion with posts", `DELETE FROM groups WHERE id=1`)
	// A personal post cannot be converted either.
	mustExec(t, database, `INSERT INTO posts(id,author_id,body)VALUES(12,2,'personal')`)
	mustFail(t, database, "personal-to-group conversion", `UPDATE posts SET group_id=1 WHERE id=12`)
	// Writing the same scope or editing other columns is allowed.
	mustExec(t, database, `UPDATE posts SET group_id=1,body='edited' WHERE id=10`)
	// Departure never touches the post: the contribution is retained.
	mustExec(t, database, `DELETE FROM group_memberships WHERE user_id=2`)
	if count(t, database, `SELECT COUNT(*) FROM posts WHERE id=10 AND group_id=1`) != 1 {
		t.Fatal("departure removed or moved a contribution")
	}
	// An inactive author cannot start a group post.
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,4,'member');UPDATE users SET is_active=0 WHERE id=4`)
	mustFail(t, database, "inactive author", `INSERT INTO posts(author_id,body,group_id)VALUES(4,'x',1)`)
}

func TestGroupPostDownMigrationRefusesLossyRemovalAndRoundTripsWhenEmpty(t *testing.T) {
	down, err := migrationFS.ReadFile("migrations/sqlite/000007_group_posts.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _ := migrationFS.ReadFile("migrations/sqlite/000007_group_posts.up.sql")
	run := func(database *sql.DB, script []byte) error {
		tx, err := database.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.Exec(string(script)); err != nil {
			return err
		}
		return tx.Commit()
	}
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO posts(id,author_id,body,group_id)VALUES(10,1,'group',1);INSERT INTO posts(id,author_id,body)VALUES(11,1,'personal')`)
	if err := run(database, down); err == nil {
		t.Fatal("down migration discarded group scope")
	}
	if count(t, database, `SELECT COUNT(*) FROM posts WHERE group_id=1`) != 1 || count(t, database, `SELECT COUNT(*) FROM sqlite_master WHERE name='group_post_insert'`) != 1 {
		t.Fatal("refused down migration changed the schema or posts")
	}
	mustExec(t, database, `DELETE FROM posts WHERE id=10`)
	if err := run(database, down); err != nil {
		t.Fatalf("empty down migration: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM pragma_table_info('posts') WHERE name='group_id'`) != 0 || count(t, database, `SELECT COUNT(*) FROM posts WHERE id=11`) != 1 {
		t.Fatal("down migration kept the column or lost a personal post")
	}
	if err := run(database, up); err != nil {
		t.Fatalf("up after down: %v", err)
	}
	mustExec(t, database, `INSERT INTO posts(id,author_id,body,group_id)VALUES(12,1,'group again',1)`)
}

// permissionWorld is a random social graph checked against an independent oracle.
type permissionWorld struct {
	active, private map[int64]bool
	follows         map[[2]int64]bool // follower, followed (accepted)
	members         map[[2]int64]bool // group, user (current)
	posts           []permissionPost
}
type permissionPost struct {
	id, author int64
	group      int64 // 0 personal
	status     string
	audience   string
	selected   map[int64]bool
}

// oracle restates the approved policy independently of the SQL: group posts are
// decided by current membership alone, personal posts by profile and audience.
func (w permissionWorld) oracle(viewer int64, p permissionPost) bool {
	if !w.active[viewer] || !w.active[p.author] {
		return false
	}
	if p.group != 0 {
		return w.members[[2]int64{p.group, viewer}] && (p.status == "published" || p.author == viewer)
	}
	if p.author == viewer {
		return true
	}
	if p.status != "published" {
		return false
	}
	follows := w.follows[[2]int64{viewer, p.author}]
	if w.private[p.author] && !follows {
		return false
	}
	switch p.audience {
	case "public":
		return true
	case "followers":
		return follows
	default:
		return follows && p.selected[viewer]
	}
}

func TestSharedPostPermissionMatchesIndependentOracle(t *testing.T) {
	ctx := context.Background()
	const users, groups = 7, 3
	for seed := int64(1); seed <= 25; seed++ {
		rng := rand.New(rand.NewSource(seed))
		database := groupTestDB(t)
		mustExec(t, database, `DELETE FROM users`)
		insertTestUsers(t, database, users)
		w := permissionWorld{active: map[int64]bool{}, private: map[int64]bool{}, follows: map[[2]int64]bool{}, members: map[[2]int64]bool{}}
		for u := int64(1); u <= users; u++ {
			w.active[u] = true
			if rng.Intn(2) == 0 {
				w.private[u] = true
				mustExec(t, database, `UPDATE users SET profile_visibility='private' WHERE id=?`, u)
			}
		}
		followIDs := map[[2]int64]int64{}
		for a := int64(1); a <= users; a++ {
			for b := int64(1); b <= users; b++ {
				if a != b && rng.Intn(3) == 0 {
					res, err := database.Exec(`INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(?,?,'accepted','2000-01-01')`, a, b)
					if err != nil {
						t.Fatal(err)
					}
					id, _ := res.LastInsertId()
					followIDs[[2]int64{a, b}] = id
					w.follows[[2]int64{a, b}] = true
				}
			}
		}
		creators := map[int64]int64{}
		for g := int64(1); g <= groups; g++ {
			creator := int64(rng.Intn(users) + 1)
			creators[g] = creator
			mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(?,?,?,?)`, creator, fmt.Sprint("g", g), "d", fmt.Sprint("g", g))
			w.members[[2]int64{g, creator}] = true
			for u := int64(1); u <= users; u++ {
				if u != creator && rng.Intn(2) == 0 {
					mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(?,?,'member')`, g, u)
					w.members[[2]int64{g, u}] = true
				}
			}
		}
		// Posts are written while every author is a member, then some members leave.
		for id := int64(1); id <= 40; id++ {
			post := permissionPost{id: id, author: int64(rng.Intn(users) + 1), status: []string{"published", "published", "draft", "archived"}[rng.Intn(4)], audience: "public", selected: map[int64]bool{}}
			if rng.Intn(2) == 0 {
				post.group = int64(rng.Intn(groups) + 1)
				for !w.members[[2]int64{post.group, post.author}] {
					post.author = int64(rng.Intn(users) + 1)
				}
				mustExec(t, database, `INSERT INTO posts(id,author_id,body,status,group_id)VALUES(?,?,'b',?,?)`, id, post.author, post.status, post.group)
			} else {
				post.audience = []string{"public", "followers", "selected"}[rng.Intn(3)]
				mustExec(t, database, `INSERT INTO posts(id,author_id,body,status,audience)VALUES(?,?,'b',?,?)`, id, post.author, post.status, post.audience)
				if post.audience == "selected" {
					for u := int64(1); u <= users; u++ {
						if follow, ok := followIDs[[2]int64{u, post.author}]; ok && rng.Intn(2) == 0 {
							mustExec(t, database, `INSERT INTO post_selected_followers(post_id,follow_id)VALUES(?,?)`, id, follow)
							post.selected[u] = true
						}
					}
				}
			}
			w.posts = append(w.posts, post)
		}
		for key := range w.members {
			if creators[key[0]] != key[1] && rng.Intn(3) == 0 {
				mustExec(t, database, `DELETE FROM group_memberships WHERE group_id=? AND user_id=?`, key[0], key[1])
				delete(w.members, key)
			}
		}
		for u := int64(1); u <= users; u++ {
			if rng.Intn(6) == 0 {
				mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=?`, u)
				w.active[u] = false
			}
		}
		for viewer := int64(1); viewer <= users; viewer++ {
			visible := 0
			for _, p := range w.posts {
				got, err := CanViewPost(ctx, database, viewer, p.id)
				if err != nil {
					t.Fatal(err)
				}
				want := w.oracle(viewer, p)
				if got != want {
					t.Fatalf("seed %d viewer %d post %+v: policy %v, oracle %v", seed, viewer, p, got, want)
				}
				if want && p.status == "published" {
					visible++
				}
			}
			// Feeds and counts apply the same decision before paging.
			result, err := PublishingFeed(ctx, database, viewer, 1, 50, "all", "all", 0, 0, false)
			if !w.active[viewer] {
				if err == nil && result.Total != 0 {
					t.Fatalf("seed %d: inactive viewer %d reads %d posts", seed, viewer, result.Total)
				}
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Total != visible || len(result.Posts) != visible {
				t.Fatalf("seed %d viewer %d: feed total %d (%d items), oracle %d", seed, viewer, result.Total, len(result.Posts), visible)
			}
		}
	}
}

// A QA reset deletes users after groups; a group post's RESTRICT reference
// must not stop it, and allocation restarts like every other table.
func TestQASeedResetClearsGroupPosts(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member');
 INSERT INTO posts(author_id,body,group_id)VALUES(2,'group post',1);
 INSERT INTO comments(post_id,user_id,body)VALUES(1,1,'reply');
 INSERT INTO reactions(user_id,post_id,value)VALUES(1,1,1)`)
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatalf("QA reset with group posts: %v", err)
	}
	if n := count(t, database, `SELECT COUNT(*) FROM groups`); n != 0 {
		t.Fatalf("reset kept %d groups", n)
	}
	if n := count(t, database, `SELECT COUNT(*) FROM posts WHERE group_id IS NOT NULL`); n != 0 {
		t.Fatalf("reset kept %d group posts", n)
	}
}
