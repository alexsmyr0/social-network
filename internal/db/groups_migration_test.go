package db

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// groupPhase3Files is the schema as shipped before B18: every migration except
// 000006 and B19's 000007, which builds on it.
func groupPhase3Files(t *testing.T) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	names, err := fs.Glob(migrationFS, "migrations/sqlite/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if strings.Contains(name, "000006_") || strings.Contains(name, "000007_") {
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

func insertTestUsers(t *testing.T, database *sql.DB, n int) {
	t.Helper()
	for id := 1; id <= n; id++ {
		mustExec(t, database, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,display_name_search)VALUES(?,?,?,'hash','Test','Person','2000-01-01','test person')`,
			id, fmt.Sprintf("user%d", id), fmt.Sprintf("user%d@test.local", id))
	}
}

func seedPhase3Data(t *testing.T, database *sql.DB) {
	t.Helper()
	insertTestUsers(t, database, 3)
	mustExec(t, database, `UPDATE users SET profile_visibility='private',profile_version=3 WHERE id=1;
 INSERT INTO sessions(id,user_id,token,ip,user_agent,is_valid)VALUES(10,1,'valid','','agent',1);
 INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(20,2,1,'accepted','2000-01-01');
 INSERT INTO follows(id,follower_id,followed_id,state)VALUES(21,3,1,'pending');
 INSERT INTO posts(id,author_id,title,body,status,audience,content_version)VALUES(30,1,'kept','body','published','followers',4),(31,1,NULL,'draft','draft','selected',2);
 INSERT INTO post_selected_followers(post_id,follow_id)VALUES(31,20);
 INSERT INTO comments(id,post_id,user_id,body)VALUES(40,30,2,'root');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,is_read)VALUES(60,1,2,'comment',30,0);
 INSERT INTO notifications(id,recipient_id,actor_id,type,comment_id,is_read)VALUES(61,3,1,'comment_dislike',40,1);
 INSERT INTO notifications(id,recipient_id,actor_id,type,follow_id,follow_state)VALUES(62,1,3,'follow_request',21,'pending');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id)VALUES(999,2,1,'post_like',30);
 DELETE FROM notifications WHERE id=999;`)
}

func tableSnapshot(t *testing.T, database *sql.DB, table, columns string) string {
	t.Helper()
	rows, err := database.Query(`SELECT ` + columns + ` FROM ` + table + ` ORDER BY 1,2`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out strings.Builder
	for rows.Next() {
		values := make([]any, len(cols))
		dest := make([]any, len(cols))
		for i := range values {
			dest[i] = &values[i]
		}
		if err := rows.Scan(dest...); err != nil {
			t.Fatal(err)
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		fmt.Fprintln(&out, values...)
	}
	return out.String()
}

var phase3Tables = map[string]string{
	"users":                   "id,username,email,profile_visibility,profile_version",
	"sessions":                "id,user_id,token,is_valid",
	"follows":                 "id,follower_id,followed_id,state,accepted_at",
	"posts":                   "id,author_id,title,body,status,audience,content_version",
	"post_selected_followers": "post_id,follow_id",
	"comments":                "id,post_id,user_id,body",
	"notifications":           "id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,created_at,is_read",
}

func TestGroupMigrationUpgradePreservesPhase3Data(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "phase3.db")
	old, err := initDBWithMigrations(ctx, path, groupPhase3Files(t))
	if err != nil {
		t.Fatal(err)
	}
	seedPhase3Data(t, old)
	before := map[string]string{}
	for table, columns := range phase3Tables {
		before[table] = tableSnapshot(t, old, table, columns)
	}
	var sequence int64
	old.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name='notifications'`).Scan(&sequence)
	if sequence < 999 {
		t.Fatalf("fixture did not leave a deleted high notification ID: %d", sequence)
	}
	old.Close()

	upgraded, err := initDBWithMigrations(ctx, path, migrationFS)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer upgraded.Close()
	for table, columns := range phase3Tables {
		if after := tableSnapshot(t, upgraded, table, columns); after != before[table] {
			t.Fatalf("%s changed by upgrade\nbefore %s\nafter  %s", table, before[table], after)
		}
	}
	var after int64
	upgraded.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name='notifications'`).Scan(&after)
	if after != sequence {
		t.Fatalf("notification allocation %d, want preserved %d", after, sequence)
	}
	mustExec(t, upgraded, `INSERT INTO notifications(recipient_id,actor_id,type,post_id)VALUES(2,1,'post_like',30)`)
	if next := count(t, upgraded, `SELECT MAX(id) FROM notifications`); int64(next) != sequence+1 {
		t.Fatalf("new notification ID %d, want %d (a deleted ID is never reused)", next, sequence+1)
	}
	for _, table := range []string{"groups", "group_memberships", "group_invitations", "group_join_requests"} {
		if n := count(t, upgraded, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Fatalf("%s starts with %d rows", table, n)
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
	for _, index := range []string{"idx_notifications_recipient", "idx_notifications_unread", "ux_notification_post", "ux_notification_comment", "ux_notification_follow", "ux_notification_group"} {
		if count(t, upgraded, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, index) != 1 {
			t.Fatalf("missing index %s", index)
		}
	}
	snapshot := tableSnapshot(t, upgraded, "notifications", phase3Tables["notifications"])
	upgraded.Close()
	again, err := InitDB(ctx, path)
	if err != nil {
		t.Fatalf("repeated startup: %v", err)
	}
	defer again.Close()
	if tableSnapshot(t, again, "notifications", phase3Tables["notifications"]) != snapshot {
		t.Fatal("repeated startup changed notifications")
	}
}

func TestGroupMigrationFailureLeavesDataAndBlocksReadiness(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "failed.db")
	old, err := initDBWithMigrations(ctx, path, groupPhase3Files(t))
	if err != nil {
		t.Fatal(err)
	}
	seedPhase3Data(t, old)
	// A conflicting object makes the migration fail after it has started.
	mustExec(t, old, `CREATE TABLE group_join_requests(conflict INTEGER)`)
	before := map[string]string{}
	for table, columns := range phase3Tables {
		before[table] = tableSnapshot(t, old, table, columns)
	}
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
	for table, columns := range phase3Tables {
		if tableSnapshot(t, raw, table, columns) != before[table] {
			t.Fatalf("failed migration changed %s", table)
		}
	}
	if n := count(t, raw, `SELECT COUNT(*) FROM sqlite_master WHERE name IN('groups','group_memberships','group_invitations')`); n != 0 {
		t.Fatal("failed migration left a partial group schema")
	}
	var version, dirty, enforced int
	raw.QueryRow(`SELECT version,dirty FROM schema_migrations`).Scan(&version, &dirty)
	if version != 6 || dirty != 1 {
		t.Fatalf("dirty marker %d %d", version, dirty)
	}
	raw.QueryRow(`PRAGMA foreign_keys`).Scan(&enforced)
	if enforced != 1 {
		t.Fatal("foreign keys not enforced on the normal connection")
	}
}

func groupTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := InitDB(context.Background(), filepath.Join(t.TempDir(), "groups.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	insertTestUsers(t, database, 4)
	return database
}

func mustFail(t *testing.T, database *sql.DB, label, query string, args ...any) {
	t.Helper()
	if _, err := database.Exec(query, args...); err == nil {
		t.Fatalf("%s: raw write was accepted", label)
	}
}

func count(t *testing.T, database *sql.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestGroupSchemaEnforcesInvariantsAgainstRawWrites(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess')`)
	if got := count(t, database, `SELECT COUNT(*) FROM group_memberships WHERE group_id=1 AND user_id=1 AND role='creator'`); got != 1 {
		t.Fatalf("creator membership trigger produced %d rows", got)
	}
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)

	mustFail(t, database, "empty title", `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'','d','')`)
	mustFail(t, database, "overlong title", `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,?,'d','x')`, strings.Repeat("x", 101))
	mustFail(t, database, "empty description", `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'t','','t')`)
	mustFail(t, database, "overlong description", `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'t',?,'t')`, strings.Repeat("x", 1001))
	mustFail(t, database, "duplicate membership", `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	mustFail(t, database, "second creator", `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'creator')`)
	mustFail(t, database, "bad role", `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'moderator')`)
	mustFail(t, database, "role change", `UPDATE group_memberships SET role='creator' WHERE user_id=2`)
	mustFail(t, database, "membership move", `UPDATE group_memberships SET user_id=3 WHERE user_id=2`)
	mustFail(t, database, "creator departure", `DELETE FROM group_memberships WHERE user_id=1`)
	mustFail(t, database, "creator account deletion", `DELETE FROM users WHERE id=1`)

	mustFail(t, database, "invitation from nonmember", `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,3,4)`)
	mustFail(t, database, "invitation to member", `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,1,2)`)
	mustFail(t, database, "self invitation", `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,2,2)`)
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,2,3)`)
	mustFail(t, database, "duplicate invitation", `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,2,3)`)
	mustFail(t, database, "invitation rewrite", `UPDATE group_invitations SET invitee_id=4`)
	mustFail(t, database, "request by member", `INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,2)`)
	mustExec(t, database, `INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,3)`)
	mustFail(t, database, "duplicate request", `INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,3)`)
	mustFail(t, database, "request rewrite", `UPDATE group_join_requests SET requester_id=4`)

	// Admission resolves that person's pending entries and only theirs.
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,1,4)`)
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'member')`)
	if got := count(t, database, `SELECT COUNT(*) FROM group_invitations WHERE invitee_id=3`) + count(t, database, `SELECT COUNT(*) FROM group_join_requests WHERE requester_id=3`); got != 0 {
		t.Fatalf("admission left %d pending entries for the new member", got)
	}
	if count(t, database, `SELECT COUNT(*) FROM group_invitations WHERE invitee_id=4`) != 1 {
		t.Fatal("admission removed another person's invitation")
	}
	// Departure cancels the departing inviter's invitations only.
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,3,4)`)
	mustExec(t, database, `DELETE FROM group_memberships WHERE user_id=3`)
	if count(t, database, `SELECT COUNT(*) FROM group_invitations WHERE inviter_id=3`) != 0 {
		t.Fatal("departure left the departed inviter's invitation usable")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_invitations WHERE inviter_id=1 AND invitee_id=4`) != 1 {
		t.Fatal("departure cancelled another member's invitation")
	}
	// A returning inviter does not revive the cancelled invitation.
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'member')`)
	if count(t, database, `SELECT COUNT(*) FROM group_invitations WHERE inviter_id=3`) != 0 {
		t.Fatal("readmission revived a cancelled invitation")
	}
	// Non-creator account deletion removes its memberships.
	mustExec(t, database, `DELETE FROM users WHERE id=2`)
	if count(t, database, `SELECT COUNT(*) FROM group_memberships WHERE user_id=2`) != 0 {
		t.Fatal("account deletion left a membership")
	}
}

func TestGroupNotificationConstraints(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO posts(id,author_id,body)VALUES(30,1,'body'); INSERT INTO follows(id,follower_id,followed_id,state)VALUES(5,2,1,'pending')`)
	mustExec(t, database, `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(3,2,'group_invitation',1,7,'pending')`)
	mustExec(t, database, `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(1,2,'group_join_request',1,7,'pending')`)
	mustFail(t, database, "duplicate group notice", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(3,4,'group_invitation',1,7,'accepted')`)
	mustFail(t, database, "group notice without group", `INSERT INTO notifications(recipient_id,actor_id,type,group_entry_id,group_state)VALUES(3,2,'group_invitation',8,'pending')`)
	mustFail(t, database, "group notice without entry", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_state)VALUES(3,2,'group_invitation',1,'pending')`)
	mustFail(t, database, "group notice without state", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id)VALUES(3,2,'group_invitation',1,9)`)
	mustFail(t, database, "request cannot be cancelled", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(1,3,'group_join_request',1,10,'cancelled')`)
	mustFail(t, database, "invitation unknown state", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(3,2,'group_invitation',1,11,'declined')`)
	mustFail(t, database, "content notice with group fields", `INSERT INTO notifications(recipient_id,actor_id,type,post_id,group_id)VALUES(1,2,'post_like',30,1)`)
	mustFail(t, database, "follow notice with group state", `INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state,group_state)VALUES(1,2,'follow_request',5,'pending','pending')`)
	mustFail(t, database, "group notice with a post", `INSERT INTO notifications(recipient_id,actor_id,type,post_id,group_id,group_entry_id,group_state)VALUES(3,2,'group_invitation',30,1,12,'pending')`)
	// Notices keep their group: it cannot be deleted from under them.
	mustFail(t, database, "group deletion with notices", `DELETE FROM groups WHERE id=1`)
}

func TestGroupIdentitiesAreNeverReused(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'A','a','a'),(2,'B','b','b')`)
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(2,3,'member')`)
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(2,3,4)`)
	mustExec(t, database, `INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,3)`)
	highs := map[string]int{
		"groups": 2, "group_memberships": 3, "group_invitations": 1, "group_join_requests": 1,
	}
	for table, high := range highs {
		if got := count(t, database, `SELECT MAX(id) FROM `+table); got != high {
			t.Fatalf("%s high ID %d want %d", table, got, high)
		}
	}
	// Removing the highest rows (group deletion cascades) never lowers allocation.
	mustExec(t, database, `DELETE FROM groups WHERE id=2`)
	mustExec(t, database, `DELETE FROM group_join_requests`)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'C','c','c')`)
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(3,2,'member')`)
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(3,2,4)`)
	mustExec(t, database, `INSERT INTO group_join_requests(group_id,requester_id)VALUES(3,4)`)
	for table, high := range map[string]int{"groups": 3, "group_invitations": 2, "group_join_requests": 2} {
		if got := count(t, database, `SELECT MAX(id) FROM `+table); got != high {
			t.Fatalf("%s reused an ID: highest %d want %d", table, got, high)
		}
	}
	// Creator 1 and 2, member 3, then deleted group 2 took 2 and 3; C's creator is 4 and the member is 5.
	if got := count(t, database, `SELECT MAX(id) FROM group_memberships`); got != 5 {
		t.Fatalf("membership generation allocation %d, want 5 (no reuse of 2 or 3)", got)
	}
}

func TestGroupDownMigrationRefusesLossyRemovalAndRoundTripsWhenEmpty(t *testing.T) {
	down, err := migrationFS.ReadFile("migrations/sqlite/000006_groups.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _ := migrationFS.ReadFile("migrations/sqlite/000006_groups.up.sql")
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
	// B19's migration sits on top of B18's: its objects reference the group tables.
	groupPostsDown, err := migrationFS.ReadFile("migrations/sqlite/000007_group_posts.down.sql")
	if err != nil {
		t.Fatal(err)
	}
	groupPostsUp, _ := migrationFS.ReadFile("migrations/sqlite/000007_group_posts.up.sql")
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess')`)
	if err := run(database, groupPostsDown); err != nil {
		t.Fatalf("group post down migration: %v", err)
	}
	defer func() {
		if err := run(database, groupPostsUp); err != nil {
			t.Fatalf("group post up migration after round trip: %v", err)
		}
	}()
	if err := run(database, down); err == nil {
		t.Fatal("down migration discarded group history")
	}
	if count(t, database, `SELECT COUNT(*) FROM groups`) != 1 {
		t.Fatal("refused down migration changed groups")
	}
	mustExec(t, database, `DELETE FROM groups`)
	// Ordinary content notices survive the round trip.
	mustExec(t, database, `INSERT INTO posts(id,author_id,body)VALUES(30,1,'body');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id)VALUES(41,1,2,'post_like',30)`)
	if err := run(database, down); err != nil {
		t.Fatalf("empty down migration: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM sqlite_master WHERE name='groups'`) != 0 {
		t.Fatal("down migration kept the group tables")
	}
	if count(t, database, `SELECT COUNT(*) FROM notifications WHERE id=41 AND type='post_like'`) != 1 {
		t.Fatal("down migration lost a retained content notice")
	}
	mustFail(t, database, "old constraint", `INSERT INTO notifications(recipient_id,actor_id,type,group_state)VALUES(1,2,'post_like','pending')`)
	if err := run(database, up); err != nil {
		t.Fatalf("up after down: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM sqlite_master WHERE name='groups'`) != 1 {
		t.Fatal("round trip lost the group schema")
	}
}

func TestQASeedResetClearsGroupStateAndAllocation(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member');
 INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,2,3);
 INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,4);
 INSERT INTO notifications(recipient_id,actor_id,type,group_id,group_entry_id,group_state)VALUES(3,2,'group_invitation',1,1,'pending')`)
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatalf("QA reset with group state: %v", err)
	}
	for _, table := range []string{"groups", "group_memberships", "group_invitations", "group_join_requests"} {
		if n := count(t, database, `SELECT COUNT(*) FROM `+table); n != 0 {
			t.Fatalf("%s kept %d rows through reset", table, n)
		}
		if n := count(t, database, `SELECT COUNT(*) FROM sqlite_sequence WHERE name=?`, table); n != 0 {
			t.Fatalf("%s allocation survived reset", table)
		}
	}
}
