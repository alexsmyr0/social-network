package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

// chatWorld is a migrated database with four users, group 1 owned by user 1
// (membership 1) and user 2 as an ordinary member (membership 2).
func chatWorld(t *testing.T) *sql.DB {
	t.Helper()
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	return database
}

func sendRoom(t *testing.T, database *sql.DB, sender, membership int64, n int, body string) GroupSendResult {
	t.Helper()
	result, err := SendGroupMessage(context.Background(), database, GroupSendRequest{SenderID: sender, GroupID: 1, MembershipID: membership, ClientID: testNonce(n), Body: body})
	if err != nil {
		t.Fatalf("send %d: %v", n, err)
	}
	return result
}

/*---------------------------------------------------------------------------
  migration 10
---------------------------------------------------------------------------*/

func seedChatUpgrade(t *testing.T, database *sql.DB) {
	t.Helper()
	insertTestUsers(t, database, 4)
	mustExec(t, database, `INSERT INTO groups(id,creator_id,title,description,title_search)VALUES(10,1,'Chess','Games','chess'),(11,1,'Books','Reads','books');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(10,2,'member'),(10,3,'member');
 INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(10,1,4);
 INSERT INTO posts(id,author_id,body)VALUES(30,1,'body');
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,is_read)VALUES(41,1,2,'post_like',30,1);
 INSERT INTO private_messages(id,sender_id,recipient_id,body)VALUES(7,2,1,'kept');
 INSERT INTO sessions(user_id,token,ip,user_agent,is_valid)VALUES(2,'revoked','','agent',0);`)
}

func TestGroupChatMigrationPreservesEverythingAndStartsEveryCursor(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "prior.db")
	old, err := initDBWithMigrations(ctx, path, eventMigrationFiles(t, 9))
	if err != nil {
		t.Fatal(err)
	}
	seedChatUpgrade(t, old)
	before := eventAllTables(t, old)
	seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
	old.Close()

	upgraded, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	for table, want := range before {
		if got := tableSnapshot(t, upgraded, table, "*"); got != want {
			t.Fatalf("%s changed by the upgrade", table)
		}
	}
	if got := tableSnapshot(t, upgraded, "sqlite_sequence", "name,seq"); got != seq {
		t.Fatalf("allocation changed\n%s\n%s", seq, got)
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM group_messages`) != 0 {
		t.Fatal("the upgrade invented messages")
	}
	// One room per group, including groups from earlier phases: every membership of
	// every existing group has a cursor at the room's latest ID (0 while empty).
	if count(t, upgraded, `SELECT COUNT(*) FROM group_memberships`) != 4 || count(t, upgraded, `SELECT COUNT(*) FROM group_read_cursors WHERE through_id=0`) != 4 ||
		count(t, upgraded, `SELECT COUNT(*) FROM group_memberships m LEFT JOIN group_read_cursors c ON c.membership_id=m.id WHERE c.membership_id IS NULL`) != 0 {
		t.Fatal("existing memberships are missing their cursors")
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM pragma_foreign_key_check`) != 0 || count(t, upgraded, `SELECT version FROM schema_migrations WHERE dirty=0`) != 10 {
		t.Fatal("foreign keys or version wrong")
	}
	for _, name := range []string{"idx_group_messages_room"} {
		if count(t, upgraded, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, name) != 1 {
			t.Fatal("missing index", name)
		}
	}
	// Repeated startup is a no-op with identical mappings.
	cursors := tableSnapshot(t, upgraded, "group_read_cursors", "*")
	upgraded.Close()
	again, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if tableSnapshot(t, again, "group_read_cursors", "*") != cursors || count(t, again, `SELECT version FROM schema_migrations WHERE dirty=0`) != 10 {
		t.Fatal("repeated startup changed the mapping")
	}
}

func TestGroupChatMigrationEveryVersionedSource(t *testing.T) {
	for version := 1; version <= 9; version++ {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.db")
			old, err := initDBWithMigrations(context.Background(), path, eventMigrationFiles(t, version))
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"one", "two"} {
				mustExec(t, old, `INSERT INTO users(username,email,password_hash,first_name,last_name,date_of_birth)VALUES(?,?,'hash','Kept','Person','2000-01-01')`, name, name+"@test.local")
			}
			if version >= 6 {
				mustExec(t, old, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');
 INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
			}
			old.Close()
			up, err := InitDB(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer up.Close()
			want := 0
			if version >= 6 {
				want = 2
			}
			if count(t, up, `SELECT version FROM schema_migrations WHERE dirty=0`) != 10 || count(t, up, `SELECT COUNT(*) FROM group_read_cursors`) != want {
				t.Fatalf("source %d: wrong version or cursor count", version)
			}
		})
	}
}

func TestGroupChatMigrationFailureBoundaries(t *testing.T) {
	stages := []string{
		"CREATE TABLE group_messages", "CREATE INDEX idx_group_messages_room", "CREATE TABLE group_read_cursors",
		"CREATE TRIGGER group_read_cursor_monotonic", "CREATE TRIGGER group_membership_cursor",
		"INSERT INTO group_read_cursors(membership_id,through_id) SELECT", "@end",
	}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			ctx := context.Background()
			path := filepath.Join(t.TempDir(), "failed.db")
			old, err := initDBWithMigrations(ctx, path, eventMigrationFiles(t, 9))
			if err != nil {
				t.Fatal(err)
			}
			seedChatUpgrade(t, old)
			before := eventAllTables(t, old)
			seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
			old.Close()
			files := eventMigrationFiles(t, 10)
			name := "migrations/sqlite/000010_group_chat.up.sql"
			s := string(files[name].Data)
			if stage == "@end" {
				s += "\nSELECT fail_b23_migration();\n"
			} else {
				if !strings.Contains(s, stage) {
					t.Fatalf("stage %q not found in the migration", stage)
				}
				s = strings.Replace(s, stage, "SELECT fail_b23_migration();\n"+stage, 1)
			}
			files[name] = &fstest.MapFile{Data: []byte(s)}
			if opened, err := initDBWithMigrations(ctx, path, files); err == nil {
				opened.Close()
				t.Fatal("fault allowed startup")
			}
			if opened, err := InitDB(ctx, path); err == nil {
				opened.Close()
				t.Fatal("dirty startup allowed readiness")
			}
			raw, err := sql.Open("sqlite3", path+"?_foreign_keys=on")
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			if !reflect.DeepEqual(before, eventAllTables(t, raw)) || seq != tableSnapshot(t, raw, "sqlite_sequence", "name,seq") {
				t.Fatal("failed upgrade changed schema, data or allocation")
			}
			if count(t, raw, `SELECT dirty FROM schema_migrations WHERE version=10`) != 1 {
				t.Fatal("missing dirty marker")
			}
			if count(t, raw, `SELECT COUNT(*) FROM sqlite_master WHERE name IN('group_messages','group_read_cursors','group_membership_cursor','group_read_cursor_monotonic')`) != 0 {
				t.Fatal("partial schema left behind")
			}
		})
	}
}

func TestGroupChatDownRefusesLossAndRoundTripsWhenEmpty(t *testing.T) {
	database := chatWorld(t)
	up, _ := migrationFS.ReadFile("migrations/sqlite/000010_group_chat.up.sql")
	down, _ := migrationFS.ReadFile("migrations/sqlite/000010_group_chat.down.sql")
	run := func(script []byte) error {
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
	// Untouched upgrade state carries nothing to lose: remove and restore it.
	if err := run(down); err != nil {
		t.Fatalf("empty downgrade refused: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM sqlite_master WHERE name IN('group_messages','group_read_cursors')`) != 0 {
		t.Fatal("downgrade kept the chat tables")
	}
	if err := run(up); err != nil {
		t.Fatal(err)
	}
	if count(t, database, `SELECT COUNT(*) FROM group_read_cursors WHERE through_id=0`) != 2 {
		t.Fatal("up after down did not recreate the cursors")
	}
	// A cursor that moved is persisted state, even before any message row exists.
	mustExec(t, database, `UPDATE group_read_cursors SET through_id=3 WHERE membership_id=2`)
	if err := run(down); err == nil {
		t.Fatal("downgrade discarded a persisted cursor")
	}
	mustExec(t, database, `DROP TRIGGER group_read_cursor_monotonic; UPDATE group_read_cursors SET through_id=0 WHERE membership_id=2`)
	// Any stored message is data.
	sendRoom(t, database, 2, 2, 1, "kept")
	if err := run(down); err == nil {
		t.Fatal("downgrade discarded a stored message")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_messages`) != 1 || count(t, database, `SELECT COUNT(*) FROM group_read_cursors`) != 2 {
		t.Fatal("refused downgrade changed data")
	}
}

func TestGroupChatSchemaEnforcesInvariantsAgainstRawWrites(t *testing.T) {
	database := chatWorld(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(2,'Books','Reads','books')`)
	insert := `INSERT INTO group_messages(group_id,sender_id,sender_membership_id,client_id,body)VALUES(?,?,?,?,?)`
	mustExec(t, database, insert, 1, 2, 2, testNonce(1), "a")
	mustFail(t, database, "duplicate nonce for one sender in another room", insert, 2, 2, 4, testNonce(1), "b")
	mustFail(t, database, "duplicate nonce in the same room", insert, 1, 2, 2, testNonce(1), "b")
	mustExec(t, database, insert, 1, 1, 1, testNonce(1), "c") // nonces are scoped by sender
	mustFail(t, database, "empty body", insert, 1, 2, 2, testNonce(2), "")
	mustFail(t, database, "2001-character body", insert, 1, 2, 2, testNonce(2), strings.Repeat("x", 2001))
	mustExec(t, database, insert, 1, 2, 2, testNonce(3), strings.Repeat("😀", 2000))
	mustFail(t, database, "malformed nonce", insert, 1, 2, 2, "not-a-uuid", "a")
	mustFail(t, database, "zero generation", insert, 1, 2, 0, testNonce(4), "a")
	mustFail(t, database, "unsafe generation", insert, 1, 2, 9007199254740992, testNonce(4), "a")
	mustFail(t, database, "message in a missing group", insert, 99, 2, 2, testNonce(4), "a")
	mustFail(t, database, "message from a missing user", insert, 1, 99, 2, testNonce(4), "a")
	mustExec(t, database, `INSERT INTO group_messages(group_id,sender_id,sender_membership_id,body)VALUES(1,2,2,'seeded without a nonce'),(1,2,2,'and another')`)
	mustFail(t, database, "deleting a user under a message", `DELETE FROM users WHERE id=2`)
	mustFail(t, database, "deleting a group under a message", `DELETE FROM groups WHERE id=1`)
	// A message ID past the safe range fails without a partial row.
	mustExec(t, database, `UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='group_messages'`)
	before := tableSnapshot(t, database, "group_messages", "*")
	mustFail(t, database, "unsafe message ID", insert, 1, 2, 2, testNonce(5), "overflow")
	if tableSnapshot(t, database, "group_messages", "*") != before {
		t.Fatal("overflow left a partial message")
	}
}

func TestGroupReadCursorsFollowMembershipGenerations(t *testing.T) {
	database := chatWorld(t)
	sendRoom(t, database, 1, 1, 1, "one")
	sendRoom(t, database, 2, 2, 2, "two")
	// Creating a group gives its creator a cursor; a join starts at the room's latest ID.
	if count(t, database, `SELECT through_id FROM group_read_cursors WHERE membership_id=1`) != 0 {
		t.Fatal("creator cursor did not start at the empty room")
	}
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'member')`)
	if count(t, database, `SELECT through_id FROM group_read_cursors WHERE membership_id=3`) != 2 {
		t.Fatal("joining member's cursor is not the room's latest message")
	}
	// Cursors only advance, however they are written.
	mustExec(t, database, `UPDATE group_read_cursors SET through_id=2 WHERE membership_id=1`)
	mustFail(t, database, "cursor moving backwards", `UPDATE group_read_cursors SET through_id=1 WHERE membership_id=1`)
	mustFail(t, database, "negative cursor", `UPDATE group_read_cursors SET through_id=-1 WHERE membership_id=1`)
	mustFail(t, database, "unsafe cursor", `UPDATE group_read_cursors SET through_id=9007199254740992 WHERE membership_id=1`)
	mustFail(t, database, "cursor without a membership", `INSERT INTO group_read_cursors(membership_id,through_id)VALUES(99,0)`)
	// Departure removes the cursor and nothing else; a returning member is a new
	// generation that starts at the latest message again.
	mustExec(t, database, `DELETE FROM group_memberships WHERE id=2`)
	if count(t, database, `SELECT COUNT(*) FROM group_read_cursors WHERE membership_id=2`) != 0 || count(t, database, `SELECT COUNT(*) FROM group_messages WHERE sender_id=2`) != 1 {
		t.Fatal("departure must delete the cursor and keep the contribution")
	}
	sendRoom(t, database, 1, 1, 3, "three")
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	var generation int
	if err := database.QueryRow(`SELECT id FROM group_memberships WHERE group_id=1 AND user_id=2`).Scan(&generation); err != nil || generation == 2 {
		t.Fatalf("readmission reused generation %d (%v)", generation, err)
	}
	if count(t, database, `SELECT through_id FROM group_read_cursors WHERE membership_id=?`, generation) != 3 {
		t.Fatal("readmitted member's backlog was counted as unread")
	}
}

func TestQASeedResetClearsGroupMessagesAndAllocation(t *testing.T) {
	database := chatWorld(t)
	sendRoom(t, database, 2, 2, 1, "hello")
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatal("QA reset with room messages", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM group_messages`) != 0 || count(t, database, `SELECT COUNT(*) FROM group_read_cursors`) != 0 ||
		count(t, database, `SELECT COUNT(*) FROM sqlite_sequence WHERE name='group_messages'`) != 0 {
		t.Fatal("QA reset kept chat state or allocation")
	}
}

/*---------------------------------------------------------------------------
  repository
---------------------------------------------------------------------------*/

func TestSendGroupMessageMembershipGenerationRetriesAndConflicts(t *testing.T) {
	ctx := context.Background()
	database := chatWorld(t)
	send := func(sender, group, membership int64, nonce int, body string) (GroupSendResult, error) {
		return SendGroupMessage(ctx, database, GroupSendRequest{SenderID: sender, GroupID: group, MembershipID: membership, ClientID: testNonce(nonce), Body: body})
	}
	first, err := send(2, 1, 2, 1, "hello")
	if err != nil || first.Duplicate || first.Message.ID != 1 || first.Message.SenderUsername != "Test Person" || *first.Message.ClientID != testNonce(1) {
		t.Fatalf("first send %+v (%v)", first, err)
	}
	if want := []GroupRecipient{{1, 1}, {2, 2}}; !reflect.DeepEqual(first.Recipients, want) {
		t.Fatalf("recipients %v want %v (sender included)", first.Recipients, want)
	}
	// Exact retry: the original message, no new row, nothing to fan out.
	again, err := send(2, 1, 2, 1, "hello")
	if err != nil || !again.Duplicate || again.Message.ID != 1 || len(again.Recipients) != 0 {
		t.Fatalf("retry %+v (%v)", again, err)
	}
	if _, err := send(2, 1, 2, 1, "changed"); !errors.Is(err, ErrMessageConflict) {
		t.Fatalf("changed body: %v", err)
	}
	// A nonce is scoped by sender and may not move to another room.
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(2,'Books','Reads','books')`)
	if _, err := send(2, 2, 3, 1, "hello"); !errors.Is(err, ErrMessageConflict) {
		t.Fatalf("nonce moved to another room: %v", err)
	}
	if other, err := send(1, 1, 1, 1, "same nonce, other sender"); err != nil || other.Duplicate {
		t.Fatalf("nonce is scoped by sender: %+v (%v)", other, err)
	}
	// Outsider, invitee and requester are 404 first, never a stale-generation hint.
	mustExec(t, database, `INSERT INTO group_invitations(group_id,inviter_id,invitee_id)VALUES(1,1,3);
 INSERT INTO group_join_requests(group_id,requester_id)VALUES(1,4)`)
	for _, user := range []int64{3, 4} {
		if _, err := send(user, 1, 2, 7, "hi"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("user %d: %v", user, err)
		}
	}
	if _, err := send(2, 99, 2, 8, "hi"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing group: %v", err)
	}
	// A current member holding an old generation is stale.
	if _, err := send(2, 1, 99, 9, "hi"); !errors.Is(err, ErrStaleMembership) {
		t.Fatalf("wrong generation: %v", err)
	}
	// Departure: 404 for the old generation and no replay of the stored result.
	mustExec(t, database, `DELETE FROM group_memberships WHERE id=2`)
	if _, err := send(2, 1, 2, 1, "hello"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("departed retry: %v", err)
	}
	// Readmission: the old generation is stale; the new one can neither replay the
	// old nonce with the old content nor reuse it.
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	if _, err := send(2, 1, 2, 1, "hello"); !errors.Is(err, ErrStaleMembership) {
		t.Fatalf("old generation after readmission: %v", err)
	}
	var generation int64
	database.QueryRow(`SELECT id FROM group_memberships WHERE group_id=1 AND user_id=2`).Scan(&generation)
	if _, err := send(2, 1, generation, 1, "hello"); !errors.Is(err, ErrMessageConflict) {
		t.Fatalf("nonce reused across generations: %v", err)
	}
	fresh, err := send(2, 1, generation, 10, "back")
	if err != nil || fresh.Duplicate {
		t.Fatalf("fresh send after readmission %+v (%v)", fresh, err)
	}
	// A deactivated creator hides the room entirely.
	mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=1`)
	if _, err := send(2, 1, generation, 11, "hi"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("room of an inactive creator: %v", err)
	}
}

func TestGroupHistoryPagingRetentionAndAttribution(t *testing.T) {
	ctx := context.Background()
	database := chatWorld(t)
	for n := 1; n <= 5; n++ {
		sender, membership := int64(1), int64(1)
		if n%2 == 0 {
			sender, membership = 2, 2
		}
		sendRoom(t, database, sender, membership, n, fmt.Sprintf("m%d", n))
	}
	ids := func(p GroupHistoryPage) []int64 {
		out := []int64{}
		for _, m := range p.Messages {
			out = append(out, m.ID)
		}
		return out
	}
	page, err := GroupHistory(ctx, database, 1, 1, 0, 2)
	if err != nil || !reflect.DeepEqual(ids(page), []int64{4, 5}) || !page.HasMore || page.NextBeforeID == nil || *page.NextBeforeID != 4 {
		t.Fatalf("newest page %v more=%v next=%v (%v)", ids(page), page.HasMore, page.NextBeforeID, err)
	}
	page, err = GroupHistory(ctx, database, 1, 1, 4, 2)
	if err != nil || !reflect.DeepEqual(ids(page), []int64{2, 3}) || !page.HasMore || *page.NextBeforeID != 2 {
		t.Fatalf("older page %v (%v)", ids(page), err)
	}
	page, _ = GroupHistory(ctx, database, 1, 1, 2, 2)
	if !reflect.DeepEqual(ids(page), []int64{1}) || page.HasMore || page.NextBeforeID != nil {
		t.Fatalf("last page %v more=%v", ids(page), page.HasMore)
	}
	// Nonmembers see nothing at all.
	for _, user := range []int64{3, 99} {
		if _, err := GroupHistory(ctx, database, user, 1, 0, 10); !errors.Is(err, ErrNotFound) {
			t.Fatalf("user %d: %v", user, err)
		}
	}
	// Retention: a departed author's messages stay, attributed to the same person
	// (private profiles expose no extra fields); an inactive author becomes unavailable.
	mustExec(t, database, `DELETE FROM group_memberships WHERE id=2`)
	page, err = GroupHistory(ctx, database, 1, 1, 0, 50)
	if err != nil || len(page.Messages) != 5 || page.Messages[1].SenderID != 2 || page.Messages[1].SenderUsername != "Test Person" {
		t.Fatalf("departed author's messages %+v (%v)", page.Messages, err)
	}
	if _, err := GroupHistory(ctx, database, 2, 1, 0, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("departed member can read: %v", err)
	}
	mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=2`)
	page, _ = GroupHistory(ctx, database, 1, 1, 0, 50)
	if page.Messages[1].SenderUsername != "Unavailable account" {
		t.Fatalf("inactive author shown as %q", page.Messages[1].SenderUsername)
	}
}

func TestGroupRoomsUnreadAndCursors(t *testing.T) {
	ctx := context.Background()
	database := chatWorld(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(2,'Books','Reads','books');
 INSERT INTO groups(creator_id,title,description,title_search)VALUES(3,'Other','Nope','other')`)
	sendRoom(t, database, 1, 1, 1, "welcome")
	sendRoom(t, database, 2, 2, 2, "mine")
	sendRoom(t, database, 1, 1, 3, "again")

	rooms, err := GroupRooms(ctx, database, 2, 1, 20)
	if err != nil || rooms.Total != 2 || len(rooms.Items) != 2 {
		t.Fatalf("rooms %+v (%v)", rooms, err)
	}
	first, second := rooms.Items[0], rooms.Items[1]
	// Joined after nothing: the admission cursor was 0. Own message never counts.
	if first.Group.ID != 1 || first.MembershipID != 2 || first.UnreadCount != 2 || first.LastMessage == nil || first.LastMessage.ID != 3 || first.ReadThroughID != 0 {
		t.Fatalf("room one %+v", first)
	}
	if second.Group.ID != 2 || second.LastMessage != nil || second.UnreadCount != 0 {
		t.Fatalf("empty room %+v", second)
	}
	if total, err := GroupUnreadTotal(ctx, database, 2); err != nil || total != 2 {
		t.Fatalf("unread total %d (%v)", total, err)
	}
	if paged, _ := GroupRooms(ctx, database, 2, 2, 1); paged.Total != 2 || len(paged.Items) != 1 || paged.Items[0].Group.ID != 2 {
		t.Fatalf("second page %+v", paged)
	}
	// Outsiders have no rooms and no count.
	if outsider, err := GroupRooms(ctx, database, 4, 1, 20); err != nil || outsider.Total != 0 || len(outsider.Items) != 0 {
		t.Fatalf("outsider rooms %+v (%v)", outsider, err)
	}
	if total, _ := GroupUnreadTotal(ctx, database, 4); total != 0 {
		t.Fatalf("outsider unread %d", total)
	}

	// Mark read: monotonic, idempotent, validated against this room.
	read, err := MarkGroupRead(ctx, database, 2, 1, 2, 3)
	if err != nil || read.ThroughID != 3 || read.UnreadCount != 0 || !read.Changed || read.MembershipID != 2 {
		t.Fatalf("mark read %+v (%v)", read, err)
	}
	if repeat, _ := MarkGroupRead(ctx, database, 2, 1, 2, 3); repeat.Changed || repeat.ThroughID != 3 {
		t.Fatalf("idempotent repeat %+v", repeat)
	}
	if older, _ := MarkGroupRead(ctx, database, 2, 1, 2, 1); older.Changed || older.ThroughID != 3 {
		t.Fatalf("older ID moved the cursor %+v", older)
	}
	if zero, err := MarkGroupRead(ctx, database, 2, 1, 2, 0); err != nil || zero.Changed || zero.ThroughID != 3 {
		t.Fatalf("zero is a no-op %+v (%v)", zero, err)
	}
	var field *ContentFieldError
	if _, err := MarkGroupRead(ctx, database, 2, 1, 2, 4); !errors.As(err, &field) || field.Field != "through_id" {
		t.Fatalf("future ID: %v", err)
	}
	mustExec(t, database, `INSERT INTO group_messages(group_id,sender_id,sender_membership_id,body)VALUES(2,2,3,'elsewhere')`)
	if _, err := MarkGroupRead(ctx, database, 2, 1, 2, 4); !errors.As(err, &field) {
		t.Fatalf("another room's ID: %v", err)
	}
	if _, err := MarkGroupRead(ctx, database, 2, 1, 99, 3); !errors.Is(err, ErrStaleMembership) {
		t.Fatalf("wrong generation: %v", err)
	}
	if _, err := MarkGroupRead(ctx, database, 4, 1, 2, 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outsider: %v", err)
	}
	// Mark-read before a new commit leaves the new message unread (and vice versa).
	sendRoom(t, database, 1, 1, 4, "later")
	if total, _ := GroupUnreadTotal(ctx, database, 2); total != 1 {
		t.Fatalf("new commit after the cursor: unread %d", total)
	}
	if stale, _ := MarkGroupRead(ctx, database, 2, 1, 2, 3); stale.UnreadCount != 1 {
		t.Fatalf("old through_id after a new commit: unread %d", stale.UnreadCount)
	}
	// Message counts never touch notification counts.
	if count(t, database, `SELECT COUNT(*) FROM notifications`) != 0 {
		t.Fatal("room traffic created notifications")
	}
	// Leaving hides the room and its count; contributions stay.
	mustExec(t, database, `DELETE FROM group_memberships WHERE id=2`)
	if gone, _ := GroupRooms(ctx, database, 2, 1, 20); gone.Total != 1 || gone.Items[0].Group.ID != 2 {
		t.Fatalf("departed rooms %+v", gone)
	}
	if total, _ := GroupUnreadTotal(ctx, database, 2); total != 0 {
		t.Fatalf("departed unread %d", total)
	}
}

func TestGroupDeliveryAllowedIsPerGeneration(t *testing.T) {
	ctx := context.Background()
	database := chatWorld(t)
	allowed := func(viewer, group, membership int64) bool {
		ok, err := GroupDeliveryAllowed(ctx, database, viewer, group, membership)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !allowed(2, 1, 2) || !allowed(1, 1, 1) {
		t.Fatal("current members are refused")
	}
	if allowed(2, 1, 1) || allowed(2, 2, 2) || allowed(3, 1, 2) || allowed(2, 1, 99) {
		t.Fatal("a mismatched viewer, group or generation was admitted")
	}
	mustExec(t, database, `DELETE FROM group_memberships WHERE id=2`)
	if allowed(2, 1, 2) {
		t.Fatal("departed generation admitted")
	}
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	if allowed(2, 1, 2) || !allowed(2, 1, 3) {
		t.Fatal("readmission must admit only the new generation")
	}
	mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=2`)
	if allowed(2, 1, 3) {
		t.Fatal("inactive account admitted")
	}
}

// A departure racing a send commits in one of two orders: the send first (the
// message is kept, only its delivery may stop) or the departure first (nothing is
// committed, no recipient list, no replay).
func TestGroupSendRacingDepartureCommitsNothingAfterRevocation(t *testing.T) {
	for round := 0; round < 25; round++ {
		database := chatWorld(t)
		var wg sync.WaitGroup
		var sendErr, removeErr error
		var sent GroupSendResult
		wg.Add(2)
		go func() {
			defer wg.Done()
			sent, sendErr = SendGroupMessage(context.Background(), database, GroupSendRequest{SenderID: 2, GroupID: 1, MembershipID: 2, ClientID: testNonce(1), Body: "racing"})
		}()
		go func() {
			defer wg.Done()
			removeErr = RemoveGroupMembership(context.Background(), database, 1, 2)
		}()
		wg.Wait()
		if removeErr != nil {
			t.Fatal(removeErr)
		}
		stored := count(t, database, `SELECT COUNT(*) FROM group_messages`)
		switch {
		case sendErr == nil:
			// The send was ordered first: the message stays and its snapshot includes
			// the member who is about to leave.
			if stored != 1 || len(sent.Recipients) != 2 {
				t.Fatalf("round %d: send won but stored=%d recipients=%v", round, stored, sent.Recipients)
			}
		case errors.Is(sendErr, ErrNotFound):
			if stored != 0 || len(sent.Recipients) != 0 {
				t.Fatalf("round %d: departure won but stored=%d", round, stored)
			}
		default:
			t.Fatalf("round %d: %v", round, sendErr)
		}
		// Either way the departed member is out.
		if _, err := SendGroupMessage(context.Background(), database, GroupSendRequest{SenderID: 2, GroupID: 1, MembershipID: 2, ClientID: testNonce(1), Body: "racing"}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("round %d: a departed member sent: %v", round, err)
		}
		database.Close()
	}
}

func TestGroupSendConcurrentDuplicatesYieldOneMessage(t *testing.T) {
	database := chatWorld(t)
	var wg sync.WaitGroup
	results := make([]GroupSendResult, 8)
	errs := make([]error, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = SendGroupMessage(context.Background(), database, GroupSendRequest{SenderID: 2, GroupID: 1, MembershipID: 2, ClientID: testNonce(1), Body: "once"})
		}(i)
	}
	wg.Wait()
	created := 0
	for i, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
		if !results[i].Duplicate {
			created++
		}
		if results[i].Message.ID != 1 {
			t.Fatalf("send %d returned message %d", i, results[i].Message.ID)
		}
	}
	if created != 1 || count(t, database, `SELECT COUNT(*) FROM group_messages`) != 1 {
		t.Fatalf("%d creations, %d rows; want exactly one", created, count(t, database, `SELECT COUNT(*) FROM group_messages`))
	}
}
