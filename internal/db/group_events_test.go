package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

func eventMigrationFiles(t *testing.T, through int) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	names, err := fs.Glob(migrationFS, "migrations/sqlite/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		version, err := strconv.Atoi(filepath.Base(name)[:6])
		if err != nil {
			t.Fatal(err)
		}
		if version > through {
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

// Snapshot every preexisting column, not just selected projections. Startup's
// profile search backfill is already complete before taking these snapshots.
func eventAllTables(t *testing.T, database *sql.DB) map[string]string {
	t.Helper()
	rows, err := database.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	rows.Close()
	out := map[string]string{}
	for _, name := range names {
		out[name] = tableSnapshot(t, database, name, "*")
	}
	return out
}
func seedEventUpgrade(t *testing.T, database *sql.DB) {
	t.Helper()
	seedPriorGroupPostData(t, database)
	mustExec(t, database, `INSERT INTO group_join_requests(id,group_id,requester_id)VALUES(9,7,3);
 INSERT INTO notifications(id,recipient_id,actor_id,type,group_id,group_entry_id,group_state,is_read)VALUES(82,1,3,'group_join_request',7,9,'pending',1);
 INSERT INTO sessions(id,user_id,token,ip,user_agent,is_valid)VALUES(11,2,'revoked','','agent',0);
 INSERT INTO private_messages(id,sender_id,recipient_id,body,image_path,created_at)VALUES(101,1,2,' retained 👋 ','/api/v1/media/70','2020-01-01T00:00:00Z');`)
}
func TestGroupEventMigrationPreservesAllColumnsAndMedia(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "prior.db")
	old, err := initDBWithMigrations(ctx, path, eventMigrationFiles(t, 7))
	if err != nil {
		t.Fatal(err)
	}
	seedEventUpgrade(t, old)
	before := eventAllTables(t, old)
	seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
	root, err := AvatarRoot(old)
	if err != nil {
		t.Fatal(err)
	}
	media := map[string][]byte{}
	for _, name := range []string{"o70.png", "o71.png", "o72.png"} {
		b, err := os.ReadFile(filepath.Join(root, "objects", name))
		if err != nil {
			t.Fatal(err)
		}
		media[name] = b
	}
	old.Close()
	upgraded, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for table, want := range before {
		if table == "notifications" {
			continue
		}
		if got := tableSnapshot(t, upgraded, table, "*"); got != want {
			t.Fatalf("%s changed", table)
		}
	}
	// Read the source notification columns in their original order.
	oldNotice := before["notifications"]
	if got := tableSnapshot(t, upgraded, "notifications", "id,recipient_id,actor_id,type,post_id,comment_id,follow_id,follow_state,group_id,group_entry_id,group_state,created_at,is_read"); got != oldNotice {
		t.Fatalf("notifications changed\nbefore %s\nafter %s", oldNotice, got)
	}
	if got := tableSnapshot(t, upgraded, "sqlite_sequence", "name,seq"); got != seq {
		t.Fatalf("allocation changed\n%s\n%s", seq, got)
	}
	for name, want := range media {
		got, err := os.ReadFile(filepath.Join(root, "objects", name))
		if err != nil || string(got) != string(want) {
			t.Fatalf("media %s changed: %v", name, err)
		}
	}
	for _, name := range []string{"idx_notifications_recipient", "idx_notifications_unread", "ux_notification_post", "ux_notification_comment", "ux_notification_follow", "ux_notification_group", "ux_notification_event", "idx_group_events_start", "idx_group_event_responses_user"} {
		if count(t, upgraded, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, name) != 1 {
			t.Fatal("missing", name)
		}
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM pragma_foreign_key_check`) != 0 {
		t.Fatal("foreign key violation")
	}
	if count(t, upgraded, `SELECT version FROM schema_migrations WHERE dirty=0`) != 8 {
		t.Fatal("wrong version")
	}
	// The deleted high notification ID is not reused.
	mustExec(t, upgraded, `INSERT INTO notifications(recipient_id,actor_id,type,post_id)VALUES(2,1,'post_like',30)`)
	if count(t, upgraded, `SELECT MAX(id) FROM notifications`) != 1000 {
		t.Fatal("notification high-water mark lost")
	}
	snapshot := eventAllTables(t, upgraded)
	upgraded.Close()
	again, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if !reflect.DeepEqual(snapshot, eventAllTables(t, again)) {
		t.Fatal("restart changed data")
	}
}

func TestGroupEventMigrationEveryVersionedSource(t *testing.T) {
	for version := 1; version <= 7; version++ {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.db")
			old, err := initDBWithMigrations(context.Background(), path, eventMigrationFiles(t, version))
			if err != nil {
				t.Fatal(err)
			}
			mustExec(t, old, `INSERT INTO users(username,email,password_hash,first_name,last_name,date_of_birth)VALUES('kept','kept@test.local','hash','Kept','Person','2000-01-01')`)
			old.Close()
			up, err := InitDB(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer up.Close()
			if count(t, up, `SELECT COUNT(*) FROM users WHERE email='kept@test.local'`) != 1 || count(t, up, `SELECT version FROM schema_migrations WHERE dirty=0`) != 8 {
				t.Fatal("upgrade lost account or schema")
			}
		})
	}
}

func TestGroupEventMigrationFailureBoundaries(t *testing.T) {
	for _, stage := range []string{"CREATE TABLE group_events", "INSERT INTO notifications_b21", "DROP TABLE notifications;", "CREATE TEMP TABLE b21_fk_check", "DROP TABLE b21_fk_check;"} {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "failed.db")
			old, err := initDBWithMigrations(context.Background(), path, eventMigrationFiles(t, 7))
			if err != nil {
				t.Fatal(err)
			}
			seedEventUpgrade(t, old)
			before := eventAllTables(t, old)
			seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
			old.Close()
			files := eventMigrationFiles(t, 8)
			name := "migrations/sqlite/000008_group_events.up.sql"
			s := string(files[name].Data)
			files[name] = &fstest.MapFile{Data: []byte(strings.Replace(s, stage, "SELECT fail_b21_migration();\n"+stage, 1))}
			if opened, err := initDBWithMigrations(context.Background(), path, files); err == nil {
				opened.Close()
				t.Fatal("fault allowed startup")
			}
			if opened, err := InitDB(context.Background(), path); err == nil {
				opened.Close()
				t.Fatal("dirty startup allowed readiness")
			}
			raw, err := sql.Open("sqlite3", path+"?_foreign_keys=on")
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			if !reflect.DeepEqual(before, eventAllTables(t, raw)) || seq != tableSnapshot(t, raw, "sqlite_sequence", "name,seq") {
				t.Fatal("failed upgrade changed schema/data/allocation")
			}
			if count(t, raw, `SELECT dirty FROM schema_migrations WHERE version=8`) != 1 {
				t.Fatal("missing dirty marker")
			}
		})
	}
}
func eventRepoFixture(t *testing.T) (*sql.DB, int64) {
	t.Helper()
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	var membership int64
	if err := database.QueryRow(`SELECT id FROM group_memberships WHERE user_id=2`).Scan(&membership); err != nil {
		t.Fatal(err)
	}
	return database, membership
}
func TestGroupEventAtomicRollbackSilenceAndOverflow(t *testing.T) {
	database, m := eventRepoFixture(t)
	var notices, invalidations int
	SetNotificationHook(func(int64) { notices++ })
	SetSocialInvalidationHook(func([]int64) { invalidations++ })
	t.Cleanup(func() { SetNotificationHook(nil); SetSocialInvalidationHook(nil) })
	mustExec(t, database, `CREATE TRIGGER fail_event_notice BEFORE INSERT ON notifications WHEN NEW.type='group_event' BEGIN SELECT RAISE(ABORT,'injected');END`)
	if _, err := CreateGroupEvent(context.Background(), database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z"); err == nil {
		t.Fatal("notice failure ignored")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_events`) != 0 || notices != 0 || invalidations != 0 {
		t.Fatal("partial event or premature signal")
	}
	mustExec(t, database, `DROP TRIGGER fail_event_notice`)
	e, err := CreateGroupEvent(context.Background(), database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if notices != 1 || invalidations != 1 {
		t.Fatal("wrong post-commit signals")
	}
	notices, invalidations = 0, 0
	mustExec(t, database, `CREATE TRIGGER fail_response BEFORE INSERT ON group_event_responses BEGIN SELECT RAISE(ABORT,'injected');END`)
	if _, err := RespondGroupEvent(context.Background(), database, 2, 1, e.ID, m, 0, "going"); err == nil {
		t.Fatal("response failure ignored")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_event_responses`) != 0 || invalidations != 0 || notices != 0 {
		t.Fatal("partial response or premature signal")
	}
	mustExec(t, database, `DROP TRIGGER fail_response;INSERT INTO group_event_responses(event_id,user_id,membership_id,choice,version)VALUES(1,2,2,'going',9007199254740991)`)
	if _, err := RespondGroupEvent(context.Background(), database, 2, 1, e.ID, m, MaxSocialID, "not_going"); err == nil {
		t.Fatal("overflow accepted")
	}
	if count(t, database, `SELECT version FROM group_event_responses`) != int(MaxSocialID) || invalidations != 0 {
		t.Fatal("overflow changed response")
	}
	mustExec(t, database, `UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='group_events'`)
	if _, err := CreateGroupEvent(context.Background(), database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z"); err == nil {
		t.Fatal("event ID overflow accepted")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_events`) != 1 || notices != 0 || invalidations != 0 {
		t.Fatal("overflow emitted effects")
	}
}

func TestGroupEventRacesRemovalAndConcurrentResponses(t *testing.T) {
	for _, kind := range []string{"response", "create", "response-conflict"} {
		for _, order := range []string{"write-first", "revoke-first", "concurrent"} {
			t.Run(kind+"/"+order, func(t *testing.T) {
				database, m := eventRepoFixture(t)
				e, err := CreateGroupEvent(context.Background(), database, 1, 1, 1, "New", "Games", "2026-10-16T18:00:00Z")
				if err != nil {
					t.Fatal(err)
				}
				write := func() error {
					if kind == "create" {
						_, err := CreateGroupEvent(context.Background(), database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z")
						return err
					}
					_, err := RespondGroupEvent(context.Background(), database, 2, 1, e.ID, m, 0, "going")
					return err
				}
				revoke := func() error {
					if kind == "response-conflict" {
						_, err := RespondGroupEvent(context.Background(), database, 2, 1, e.ID, m, 0, "not_going")
						return err
					}
					return RemoveGroupMembership(context.Background(), database, 1, m)
				}
				var a, b error
				switch order {
				case "write-first":
					a = write()
					b = revoke()
				case "revoke-first":
					b = revoke()
					a = write()
				default:
					var wg sync.WaitGroup
					start := make(chan struct{})
					wg.Add(2)
					go func() { defer wg.Done(); <-start; a = write() }()
					go func() { defer wg.Done(); <-start; b = revoke() }()
					close(start)
					wg.Wait()
				}
				if kind == "response-conflict" {
					if (a == nil) == (b == nil) || a != nil && !errors.Is(a, ErrStaleEventResponse) || b != nil && !errors.Is(b, ErrStaleEventResponse) {
						t.Fatalf("concurrent version outcomes %v/%v", a, b)
					}
					if count(t, database, `SELECT version FROM group_event_responses`) != 1 {
						t.Fatal("lost update")
					}
					return
				}
				if b != nil {
					t.Fatal(b)
				}
				if a != nil && !errors.Is(a, ErrNotFound) {
					t.Fatal(a)
				}
				if order == "write-first" && a != nil || order == "revoke-first" && a == nil {
					t.Fatalf("ordering violated: %v", a)
				}
				stored := 0
				if a == nil {
					stored = 1
				}
				table := "group_event_responses"
				query := `SELECT COUNT(*) FROM group_event_responses`
				if kind == "create" {
					table = "group_events"
					query = `SELECT COUNT(*) FROM group_events WHERE creator_id=2`
				}
				if count(t, database, query) != stored {
					t.Fatalf("%s effects disagree with commit order", table)
				}
				got, err := GetGroupEvent(context.Background(), database, 1, 1, e.ID)
				if err != nil || got.Counts.Going != 0 {
					t.Fatal(got, err)
				}
			})
		}
	}
}

func TestGroupEventDownRefusesLossAndEmptyRoundTrip(t *testing.T) {
	database, m := eventRepoFixture(t)
	up, _ := migrationFS.ReadFile("migrations/sqlite/000008_group_events.up.sql")
	down, _ := migrationFS.ReadFile("migrations/sqlite/000008_group_events.down.sql")
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
	// Empty event tables can be removed without touching group/content notices.
	before := tableSnapshot(t, database, "notifications", groupPostPriorTables["notifications"])
	if err := run(down); err != nil {
		t.Fatal(err)
	}
	if err := run(up); err != nil {
		t.Fatal(err)
	}
	if tableSnapshot(t, database, "notifications", groupPostPriorTables["notifications"]) != before {
		t.Fatal("empty downgrade lost notices")
	}
	e, err := CreateGroupEvent(context.Background(), database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if err := run(down); err == nil {
		t.Fatal("lossy downgrade accepted")
	}
	if count(t, database, `SELECT COUNT(*) FROM group_events WHERE id=?`, e.ID) != 1 {
		t.Fatal("refused downgrade changed events")
	}
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatal("QA reset with events", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM group_events`) != 0 {
		t.Fatal("QA reset retained events")
	}
}

func TestGroupEventRestartDurabilityAndMissedSignalRecovery(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "durable.db")
	database, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	insertTestUsers(t, database, 3)
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Chess','Games','chess');INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,2,'member')`)
	// No hook/socket: fetching authoritative storage must recover the event/notice.
	e, err := CreateGroupEvent(ctx, database, 2, 1, 2, "Retained", "Games", "2026-10-16T18:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	e, err = RespondGroupEvent(ctx, database, 2, 1, e.ID, 2, 0, "going")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RespondGroupEvent(ctx, database, 2, 1, e.ID, 2, 0, "going"); !errors.Is(err, ErrStaleEventResponse) {
		t.Fatal("stale same choice accepted", err)
	}
	database.Close()
	database, err = InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	restored, err := GetGroupEvent(ctx, database, 2, 1, e.ID)
	if err != nil || !reflect.DeepEqual(e, restored) {
		t.Fatal("event/response not durable", restored, err)
	}
	n, err := ListSocialNotifications(ctx, database, 1, 1, 20)
	if err != nil || n.UnreadCount != 1 || n.Notifications[0].Target.EventID == nil || *n.Notifications[0].Target.EventID != e.ID {
		t.Fatal(n, err)
	}
	if err := MarkSocialNotificationsRead(ctx, database, 1, n.Notifications[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := RemoveGroupMembership(ctx, database, 2, 2); err != nil {
		t.Fatal(err)
	}
	restored, err = GetGroupEvent(ctx, database, 1, 1, e.ID)
	if err != nil || restored.Creator.ID != 2 || restored.Counts.Going != 0 {
		t.Fatal("departed event author lost", restored, err)
	}
	// Creator departure does not hide a useful event notice; read state survives.
	n, err = ListSocialNotifications(ctx, database, 1, 1, 20)
	if err != nil || n.Total != 1 || n.UnreadCount != 0 || !n.Notifications[0].IsRead {
		t.Fatal(n, err)
	}
	before := eventAllTables(t, database)
	database.Close()
	database, err = InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if !reflect.DeepEqual(before, eventAllTables(t, database)) {
		t.Fatal("restart changed retained contribution/read state")
	}
}

func TestGroupEventOrderingPagingAndSchemaConstraints(t *testing.T) {
	database, m := eventRepoFixture(t)
	ctx := context.Background()
	for _, starts := range []string{"2027-01-01T00:00:00Z", "2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z"} {
		if _, err := CreateGroupEvent(ctx, database, 2, 1, m, "New", "Games", starts); err != nil {
			t.Fatal(err)
		}
	}
	first, err := ListGroupEvents(ctx, database, 1, 1, 1, 2)
	if err != nil || first.Total != 3 || len(first.Items) != 2 || first.Items[0].ID != 2 || first.Items[1].ID != 3 {
		t.Fatal(first, err)
	}
	last, err := ListGroupEvents(ctx, database, 1, 1, 2, 2)
	if err != nil || len(last.Items) != 1 || last.Items[0].ID != 1 {
		t.Fatal(last, err)
	}
	for _, user := range []int64{2, 1} {
		membership := user
		if _, err := RespondGroupEvent(ctx, database, user, 1, 1, membership, 0, "going"); err != nil {
			t.Fatal(err)
		}
	}
	page, err := ListGroupEventResponses(ctx, database, 1, 1, 1, 1, 1)
	if err != nil || page.Total != 2 || page.Items[0].User.ID != 1 {
		t.Fatal(page, err)
	}
	mustFail(t, database, "immutable event", `UPDATE group_events SET title='Changed' WHERE id=1`)
	mustFail(t, database, "unknown response choice", `UPDATE group_event_responses SET choice='maybe'`)
	mustFail(t, database, "duplicate response generation", `INSERT INTO group_event_responses VALUES(1,2,2,'going',1,'now')`)
	mustFail(t, database, "zero response generation", `INSERT INTO group_event_responses VALUES(1,2,0,'going',1,'now')`)
	mustFail(t, database, "mixed notice target", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,event_id,group_state)VALUES(1,2,'group_event',1,1,'pending')`)
	mustFail(t, database, "duplicate event notice", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,event_id)VALUES(1,2,'group_event',1,1)`)
	mustFail(t, database, "missing event", `INSERT INTO notifications(recipient_id,actor_id,type,group_id,event_id)VALUES(1,2,'group_event',1,999)`)
	mustFail(t, database, "old notice with event target", `INSERT INTO notifications(recipient_id,actor_id,type,follow_id,follow_state,event_id)VALUES(1,2,'follow_request',1,'pending',1)`)
	// Even a malformed stored group/event association cannot leak through notices.
	mustExec(t, database, `INSERT INTO groups(creator_id,title,description,title_search)VALUES(1,'Other','Other','other');
 INSERT INTO notifications(recipient_id,actor_id,type,group_id,event_id)VALUES(2,1,'group_event',2,1)`)
	n, err := ListSocialNotifications(ctx, database, 2, 1, 20)
	if err != nil || n.Total != 0 {
		t.Fatal("wrong-group notice visible", n, err)
	}
}

func TestGroupEventActiveMembersAndGroupVisibility(t *testing.T) {
	database, m := eventRepoFixture(t)
	ctx := context.Background()
	mustExec(t, database, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(1,3,'member');UPDATE users SET is_active=0 WHERE id=3`)
	e, err := CreateGroupEvent(ctx, database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if count(t, database, `SELECT COUNT(*) FROM notifications WHERE event_id=?`, e.ID) != 1 || count(t, database, `SELECT COUNT(*) FROM notifications WHERE recipient_id=3`) != 0 {
		t.Fatal("inactive member notified")
	}
	mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=1`)
	if _, err := GetGroupEvent(ctx, database, 2, 1, e.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("inactive group creator visibility", err)
	}
	if _, err := CreateGroupEvent(ctx, database, 2, 1, m, "New", "Games", "2026-10-16T18:00:00Z"); !errors.Is(err, ErrNotFound) {
		t.Fatal("write into hidden group", err)
	}
	if _, err := RespondGroupEvent(ctx, database, 2, 1, e.ID, m, 0, "going"); !errors.Is(err, ErrNotFound) {
		t.Fatal("response into hidden group", err)
	}
	n, err := ListSocialNotifications(ctx, database, 1, 1, 20)
	if err != nil || n.Total != 0 {
		t.Fatal("inactive recipient saw notice", n, err)
	}
}
