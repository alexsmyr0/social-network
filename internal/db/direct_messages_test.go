package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

// testNonce returns a distinct lowercase canonical UUID v4 for each n.
func testNonce(n int) string { return fmt.Sprintf("%08d-1111-4111-8111-111111111111", n) }

type upgradePack struct {
	Upgrade struct {
		Messages   []map[string]any          `json:"messages"`
		Sequence   int64                     `json:"message_sequence"`
		Expected   []map[string]any          `json:"expected_messages"`
		Cursors    map[string]int64          `json:"expected_dm_cursors"`
		MediaAfter map[string]map[string]any `json:"media_after"`
	}
}

func loadUpgradePack(t *testing.T) upgradePack {
	t.Helper()
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-5-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack upgradePack
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	return pack
}

func seedDMUpgrade(t *testing.T, database *sql.DB, pack upgradePack) (root string, bytes []byte) {
	t.Helper()
	insertTestUsers(t, database, 3)
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	bytes = mediaPNG(t, 64)
	for _, id := range []int{701, 702} {
		key := fmt.Sprintf("o%d.png", id)
		if err := os.WriteFile(filepath.Join(root, "objects", key), bytes, 0o600); err != nil {
			t.Fatal(err)
		}
		mustExec(t, database, `INSERT INTO media_objects(id,source_key,object_key,mime_type,byte_count,state)VALUES(?,?,?,'image/png',?,'ready')`, id, "new:"+key, key, len(bytes))
	}
	mustExec(t, database, `INSERT INTO media_pending(media_id,uploader_id,recipient_id,kind)VALUES(701,1,2,'dm')`)
	for _, m := range pack.Upgrade.Messages {
		mustExec(t, database, `INSERT INTO private_messages(id,sender_id,recipient_id,body,image_path,created_at)VALUES(?,?,?,?,?,?)`,
			m["id"], m["sender_id"], m["recipient_id"], m["body"], m["image_url"], m["created_at"])
	}
	// A deleted high-water message: the allocator must never reuse its ID.
	mustExec(t, database, `INSERT INTO private_messages(id,sender_id,recipient_id,body)VALUES(?,1,2,'gone'); DELETE FROM private_messages WHERE id=?`, pack.Upgrade.Sequence, pack.Upgrade.Sequence)
	return root, bytes
}

const dmLegacyColumns = "id,sender_id,recipient_id,body,image_path,created_at"

func TestDirectMessageMigrationPreservesMessagesMediaAndBootstrapsCursors(t *testing.T) {
	ctx := context.Background()
	pack := loadUpgradePack(t)
	path := filepath.Join(t.TempDir(), "prior.db")
	old, err := initDBWithMigrations(ctx, path, eventMigrationFiles(t, 8))
	if err != nil {
		t.Fatal(err)
	}
	root, png := seedDMUpgrade(t, old, pack)
	before := eventAllTables(t, old)
	seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
	messages := tableSnapshot(t, old, "private_messages", dmLegacyColumns)
	links := tableSnapshot(t, old, "media_links", "*")
	old.Close()

	upgraded, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for table, want := range before {
		if table == "private_messages" {
			continue
		}
		if got := tableSnapshot(t, upgraded, table, "*"); got != want {
			t.Fatalf("%s changed", table)
		}
	}
	if got := tableSnapshot(t, upgraded, "private_messages", dmLegacyColumns); got != messages {
		t.Fatalf("messages changed\nbefore %s\nafter  %s", messages, got)
	}
	if got := tableSnapshot(t, upgraded, "media_links", "*"); got != links {
		t.Fatal("message media associations changed")
	}
	if got := tableSnapshot(t, upgraded, "sqlite_sequence", "name,seq"); got != seq {
		t.Fatalf("allocation changed\n%s\n%s", seq, got)
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM private_messages WHERE client_id IS NOT NULL`) != 0 {
		t.Fatal("legacy messages must keep a null client_id")
	}
	// Both directions of every pair start at the pair's latest message.
	rows, err := upgraded.Query(`SELECT viewer_id||':'||other_id,through_id FROM dm_read_cursors`)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int64{}
	for rows.Next() {
		var key string
		var through int64
		rows.Scan(&key, &through)
		got[key] = through
	}
	rows.Close()
	if !reflect.DeepEqual(got, pack.Upgrade.Cursors) {
		t.Fatalf("cursors %v want %v", got, pack.Upgrade.Cursors)
	}
	for _, name := range []string{"ux_pm_sender_client", "idx_pm_pair_sender", "idx_pm_pair_recipient", "idx_pm_sender", "idx_pm_recipient"} {
		if count(t, upgraded, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, name) != 1 {
			t.Fatal("missing index", name)
		}
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM pragma_foreign_key_check`) != 0 || count(t, upgraded, `SELECT version FROM schema_migrations WHERE dirty=0`) != 10 {
		t.Fatal("foreign keys or version wrong")
	}
	for _, name := range []string{"o701.png", "o702.png"} {
		if b, err := os.ReadFile(filepath.Join(root, "objects", name)); err != nil || string(b) != string(png) {
			t.Fatalf("media %s changed: %v", name, err)
		}
	}
	if count(t, upgraded, `SELECT COUNT(*) FROM media_pending WHERE media_id=701`) != 1 {
		t.Fatal("staged image lost")
	}
	// The deleted high ID is not reused, and a new message validates the migrated cursors.
	mustExec(t, upgraded, `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(1,2,'new',?)`, testNonce(1))
	if count(t, upgraded, `SELECT id FROM private_messages WHERE client_id IS NOT NULL`) != int(pack.Upgrade.Sequence)+1 {
		t.Fatal("message allocation high-water mark lost")
	}
	mustExec(t, upgraded, `DELETE FROM private_messages WHERE client_id IS NOT NULL`)
	snapshot := eventAllTables(t, upgraded)
	upgraded.Close()
	again, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if !reflect.DeepEqual(snapshot, eventAllTables(t, again)) {
		t.Fatal("repeated startup changed data or cursors")
	}
}

func TestDirectMessageMigrationEveryVersionedSource(t *testing.T) {
	for version := 1; version <= 8; version++ {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.db")
			old, err := initDBWithMigrations(context.Background(), path, eventMigrationFiles(t, version))
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"one", "two"} {
				mustExec(t, old, `INSERT INTO users(username,email,password_hash,first_name,last_name,date_of_birth)VALUES(?,?,'hash','Kept','Person','2000-01-01')`, name, name+"@test.local")
			}
			mustExec(t, old, `INSERT INTO private_messages(id,sender_id,recipient_id,body)VALUES(7,2,1,'kept')`)
			old.Close()
			up, err := InitDB(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			defer up.Close()
			if count(t, up, `SELECT COUNT(*) FROM private_messages WHERE id=7 AND body='kept' AND client_id IS NULL`) != 1 || count(t, up, `SELECT version FROM schema_migrations WHERE dirty=0`) != 10 {
				t.Fatal("upgrade lost the message or schema")
			}
			if count(t, up, `SELECT through_id FROM dm_read_cursors WHERE viewer_id=1 AND other_id=2`) != 7 || count(t, up, `SELECT through_id FROM dm_read_cursors WHERE viewer_id=2 AND other_id=1`) != 7 {
				t.Fatal("cursor bootstrap missing")
			}
		})
	}
}

func TestDirectMessageMigrationFailureBoundaries(t *testing.T) {
	stages := []string{"ALTER TABLE private_messages", "CREATE UNIQUE INDEX ux_pm_sender_client", "CREATE TABLE dm_read_cursors", "INSERT INTO dm_read_cursors", "@end"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			ctx := context.Background()
			pack := loadUpgradePack(t)
			path := filepath.Join(t.TempDir(), "failed.db")
			old, err := initDBWithMigrations(ctx, path, eventMigrationFiles(t, 8))
			if err != nil {
				t.Fatal(err)
			}
			seedDMUpgrade(t, old, pack)
			before := eventAllTables(t, old)
			seq := tableSnapshot(t, old, "sqlite_sequence", "name,seq")
			old.Close()
			files := eventMigrationFiles(t, 9)
			name := "migrations/sqlite/000009_dm_cursors.up.sql"
			s := string(files[name].Data)
			if stage == "@end" {
				s += "\nSELECT fail_b22_migration();\n"
			} else {
				s = strings.Replace(s, stage, "SELECT fail_b22_migration();\n"+stage, 1)
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
			if count(t, raw, `SELECT dirty FROM schema_migrations WHERE version=9`) != 1 {
				t.Fatal("missing dirty marker")
			}
			if count(t, raw, `SELECT COUNT(*) FROM pragma_table_info('private_messages') WHERE name='client_id'`) != 0 || count(t, raw, `SELECT COUNT(*) FROM sqlite_master WHERE name='dm_read_cursors'`) != 0 {
				t.Fatal("partial schema left behind")
			}
		})
	}
}

func TestDirectMessageDownRefusesLossAndRoundTripsWhenUnchanged(t *testing.T) {
	database := groupTestDB(t)
	up, _ := migrationFS.ReadFile("migrations/sqlite/000009_dm_cursors.up.sql")
	down, _ := migrationFS.ReadFile("migrations/sqlite/000009_dm_cursors.down.sql")
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
	// Empty: remove and restore without loss.
	if err := run(down); err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `INSERT INTO private_messages(id,sender_id,recipient_id,body)VALUES(5,1,2,'legacy')`)
	if err := run(up); err != nil {
		t.Fatal(err)
	}
	if count(t, database, `SELECT through_id FROM dm_read_cursors WHERE viewer_id=2 AND other_id=1`) != 5 {
		t.Fatal("up after down did not bootstrap")
	}
	// A cursor still equal to its bootstrap value carries nothing to lose.
	if err := run(down); err != nil {
		t.Fatalf("bootstrap-only downgrade refused: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM private_messages WHERE id=5 AND body='legacy'`) != 1 {
		t.Fatal("downgrade lost a legacy message")
	}
	if err := run(up); err != nil {
		t.Fatal(err)
	}
	// A cursor that differs from its bootstrap value is persisted state.
	mustExec(t, database, `UPDATE dm_read_cursors SET through_id=3 WHERE viewer_id=2 AND other_id=1`)
	if err := run(down); err == nil {
		t.Fatal("downgrade discarded a persisted cursor")
	}
	mustExec(t, database, `UPDATE dm_read_cursors SET through_id=5 WHERE viewer_id=2 AND other_id=1`)
	// A retry nonce is data.
	mustExec(t, database, `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(1,2,'new',?)`, testNonce(1))
	if err := run(down); err == nil {
		t.Fatal("downgrade discarded a retry nonce")
	}
	if count(t, database, `SELECT COUNT(*) FROM dm_read_cursors`) != 2 || count(t, database, `SELECT COUNT(*) FROM private_messages WHERE client_id IS NOT NULL`) != 1 {
		t.Fatal("refused downgrade changed data")
	}
	if err := ApplyQASeeds(context.Background(), database); err != nil {
		t.Fatal("QA reset with cursors", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM dm_read_cursors`) != 0 {
		t.Fatal("QA reset kept cursors")
	}
}

func TestDirectMessageSchemaEnforcesInvariantsAgainstRawWrites(t *testing.T) {
	database := groupTestDB(t)
	mustExec(t, database, `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(1,2,'a',?)`, testNonce(1))
	mustFail(t, database, "duplicate nonce for one sender", `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(1,3,'b',?)`, testNonce(1))
	mustExec(t, database, `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(2,3,'c',?)`, testNonce(1))
	mustExec(t, database, `INSERT INTO private_messages(sender_id,recipient_id,body)VALUES(1,2,'legacy one'),(1,2,'legacy two')`)
	mustExec(t, database, `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(1,3,0)`)
	mustFail(t, database, "duplicate cursor", `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(1,3,1)`)
	mustFail(t, database, "self cursor", `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(2,2,0)`)
	mustFail(t, database, "negative cursor", `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(3,1,-1)`)
	mustFail(t, database, "unsafe cursor", `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(3,1,9007199254740992)`)
	mustFail(t, database, "cursor for a missing user", `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(3,99,0)`)
	mustFail(t, database, "user removal under a cursor", `DELETE FROM users WHERE id=1`)
	// The cursor is a historical high-water mark, not a reference to a message.
	mustExec(t, database, `UPDATE dm_read_cursors SET through_id=4000 WHERE viewer_id=1 AND other_id=3`)
	// A message ID past the safe range fails without a partial row.
	mustExec(t, database, `UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='private_messages'`)
	before := tableSnapshot(t, database, "private_messages", "*")
	mustFail(t, database, "unsafe message ID", `INSERT INTO private_messages(sender_id,recipient_id,body)VALUES(1,2,'overflow')`)
	if tableSnapshot(t, database, "private_messages", "*") != before {
		t.Fatal("overflow left a partial message")
	}
}

func dmFixtureDB(t *testing.T) *sql.DB {
	t.Helper()
	database := profileTestDB(t)
	mustExec(t, database, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,display_name_search)VALUES(4,'user4','user4@example.com','hash','Test','Person','2000-01-01','test person')`)
	mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,2,'accepted','2000-01-01'),(3,1,'pending',NULL)`)
	return database
}

func TestSendDirectMessagePermissionRetriesAndConflicts(t *testing.T) {
	ctx := context.Background()
	database := dmFixtureDB(t)
	send := func(from, to int64, nonce, body, image string) (DirectSendResult, error) {
		return SendDirectMessage(ctx, database, DirectSendRequest{SenderID: from, RecipientID: to, ClientID: nonce, Body: body, ImageURL: image})
	}
	for name, pair := range map[string][2]int64{"self": {1, 1}, "pending": {3, 1}, "stranger": {2, 3}, "unknown": {1, 99}} {
		if _, err := send(pair[0], pair[1], testNonce(1), "x", ""); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	first, err := send(1, 2, testNonce(1), "hello", "")
	if err != nil || first.Duplicate || first.Message.ClientID == nil || *first.Message.ClientID != testNonce(1) || first.Message.SenderUsername != "Test Person" {
		t.Fatalf("first %+v %v", first, err)
	}
	// The recipient is private and does not follow the sender: stored, not live.
	mustExec(t, database, `UPDATE users SET profile_visibility='private' WHERE id=2`)
	quiet, err := send(1, 2, testNonce(2), "quiet", "")
	if err != nil || quiet.RecipientEligible {
		t.Fatalf("private non-following recipient was eligible: %+v %v", quiet, err)
	}
	mustExec(t, database, `UPDATE users SET profile_visibility='public' WHERE id=2`)
	loud, err := send(1, 2, testNonce(3), "loud", "")
	if err != nil || !loud.RecipientEligible {
		t.Fatalf("public recipient was not eligible: %+v %v", loud, err)
	}
	again, err := send(1, 2, testNonce(1), "hello", "")
	if err != nil || !again.Duplicate || again.Message.ID != first.Message.ID || again.Message.CreatedAt != first.Message.CreatedAt {
		t.Fatalf("retry %+v %v", again, err)
	}
	for name, req := range map[string][4]string{
		"body":      {testNonce(1), "changed", "", "2"},
		"image":     {testNonce(1), "hello", "/api/v1/media/5", "2"},
		"recipient": {testNonce(1), "hello", "", "4"},
	} {
		to := int64(2)
		if req[3] == "4" {
			to = 4
			mustExec(t, database, `INSERT OR IGNORE INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,4,'accepted','2000-01-01')`)
		}
		if _, err := send(1, to, req[0], req[1], req[2]); !errors.Is(err, ErrMessageConflict) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	// Permission is judged before the retry lookup: reusing a nonce for someone the
	// sender may not message is not found, not a conflict.
	if _, err := send(1, 3, testNonce(1), "hello", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("nonce reused for a non-messageable recipient: %v", err)
	}
	// A revoked relationship stops even an exact replay.
	mustExec(t, database, `DELETE FROM follows WHERE follower_id=1 AND followed_id=2`)
	if _, err := send(1, 2, testNonce(1), "hello", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replay after revocation: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM private_messages`) != 3 {
		t.Fatal("rejected sends stored rows")
	}
	// Only private media references are accepted; the HTTP and socket layers validate before this.
	mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,2,'accepted','2000-01-01')`)
	if _, err := send(1, 2, testNonce(9), "x", "https://evil.test/a.png"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("external image: %v", err)
	}
}

func TestSendDirectMessageClaimsAStagedImageExactlyOnce(t *testing.T) {
	ctx := context.Background()
	database := dmFixtureDB(t)
	data := mediaPNG(t, 80)
	url, _, err := StageMedia(ctx, database, 1, 2, "dm", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `DELETE FROM follows`)
	req := DirectSendRequest{SenderID: 1, RecipientID: 2, ClientID: testNonce(1), ImageURL: url}
	if _, err := SendDirectMessage(ctx, database, req); !errors.Is(err, ErrNotFound) {
		t.Fatalf("denied send %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM media_pending`) != 1 || count(t, database, `SELECT COUNT(*) FROM media_links`) != 0 {
		t.Fatal("a denied send consumed the staged image")
	}
	mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01')`)
	sent, err := SendDirectMessage(ctx, database, req)
	if err != nil || sent.Message.ImageURL == nil || *sent.Message.ImageURL != url {
		t.Fatalf("send %+v %v", sent, err)
	}
	replay, err := SendDirectMessage(ctx, database, req)
	if err != nil || !replay.Duplicate || replay.Message.ID != sent.Message.ID {
		t.Fatalf("replay %+v %v", replay, err)
	}
	// The same object cannot back a second, different message.
	other := req
	other.ClientID = testNonce(2)
	if _, err := SendDirectMessage(ctx, database, other); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("reuse of a claimed image: %v", err)
	}
	if count(t, database, `SELECT COUNT(*) FROM media_links`) != 1 || count(t, database, `SELECT COUNT(*) FROM media_pending`) != 0 || count(t, database, `SELECT COUNT(*) FROM private_messages`) != 1 {
		t.Fatal("image claimed or stored twice")
	}
	// An image-only message round-trips through history with its original private URL.
	page, err := DirectHistory(ctx, database, 2, 1, 0, 10)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].Body != "" || *page.Messages[0].ImageURL != url {
		t.Fatalf("history %+v %v", page, err)
	}
}

func TestDirectMessageConcurrentNonceWritesYieldOneResult(t *testing.T) {
	ctx := context.Background()
	database := dmFixtureDB(t)
	run := func(bodies []string) (created, duplicate, conflict int) {
		var wg sync.WaitGroup
		var mu sync.Mutex
		for _, body := range bodies {
			wg.Add(1)
			go func(body string) {
				defer wg.Done()
				result, err := SendDirectMessage(ctx, database, DirectSendRequest{SenderID: 1, RecipientID: 2, ClientID: testNonce(len(body)), Body: body})
				mu.Lock()
				defer mu.Unlock()
				switch {
				case errors.Is(err, ErrMessageConflict):
					conflict++
				case err != nil:
					t.Errorf("send: %v", err)
				case result.Duplicate:
					duplicate++
				default:
					created++
				}
			}(body)
		}
		wg.Wait()
		return
	}
	// Same nonce (the nonce derives from the body length), same payload.
	created, duplicate, conflict := run([]string{"same", "same", "same", "same", "same", "same"})
	if created != 1 || duplicate != 5 || conflict != 0 {
		t.Fatalf("same payload: %d created %d duplicate %d conflict", created, duplicate, conflict)
	}
	// Same nonce, different payload: exactly one wins and the rest conflict.
	created, duplicate, conflict = run([]string{"aaaaa", "bbbbb", "ccccc", "ddddd"})
	if created != 1 || duplicate != 0 || conflict != 3 {
		t.Fatalf("conflicting payloads: %d created %d duplicate %d conflict", created, duplicate, conflict)
	}
	if count(t, database, `SELECT COUNT(*) FROM private_messages`) != 2 {
		t.Fatal("wrong number of stored messages")
	}
}

func TestMarkDirectReadValidatesPairAndAdvancesMonotonically(t *testing.T) {
	ctx := context.Background()
	database := dmFixtureDB(t)
	mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,4,'accepted','2000-01-01')`)
	ids := []int64{}
	for i, from := range []int64{1, 2, 2, 1, 2} {
		to := int64(3 - from)
		result, err := SendDirectMessage(ctx, database, DirectSendRequest{SenderID: from, RecipientID: to, ClientID: testNonce(i + 1), Body: fmt.Sprint(i)})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, result.Message.ID)
	}
	other, err := SendDirectMessage(ctx, database, DirectSendRequest{SenderID: 4, RecipientID: 1, ClientID: testNonce(9), Body: "elsewhere"})
	if err != nil {
		t.Fatal(err)
	}
	// User 1 has received messages 2, 3 and 5 of the pair, plus one from user 4.
	if n, _ := DirectUnreadTotal(ctx, database, 1); n != 4 {
		t.Fatalf("unread total %d", n)
	}
	res, err := MarkDirectRead(ctx, database, 1, 2, ids[1])
	if err != nil || !res.Changed || res.ThroughID != ids[1] || res.UnreadCount != 2 {
		t.Fatalf("read %+v %v", res, err)
	}
	for _, through := range []int64{0, ids[0], ids[1]} {
		res, err = MarkDirectRead(ctx, database, 1, 2, through)
		if err != nil || res.Changed || res.ThroughID != ids[1] || res.UnreadCount != 2 {
			t.Fatalf("no-op through %d: %+v %v", through, res, err)
		}
	}
	// Another pair's ID, an unknown ID and a future ID are all rejected without effect.
	for _, forged := range []int64{other.Message.ID, ids[4] + 100, 9007199254740991} {
		_, err := MarkDirectRead(ctx, database, 1, 2, forged)
		var field *ContentFieldError
		if !errors.As(err, &field) || field.Field != "through_id" || field.Code != "INVALID_ID" {
			t.Fatalf("forged %d: %v", forged, err)
		}
	}
	if _, err := MarkDirectRead(ctx, database, 1, 3, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-conversation: %v", err)
	}
	res, err = MarkDirectRead(ctx, database, 1, 2, ids[4])
	if err != nil || res.UnreadCount != 0 {
		t.Fatalf("read all %+v %v", res, err)
	}
	// The other participant's own cursor is untouched; new commits stay unread.
	if n, _ := DirectUnreadTotal(ctx, database, 2); n != 2 {
		t.Fatalf("counterpart unread %d", n)
	}
	if _, err := SendDirectMessage(ctx, database, DirectSendRequest{SenderID: 2, RecipientID: 1, ClientID: testNonce(20), Body: "later"}); err != nil {
		t.Fatal(err)
	}
	if n, _ := DirectUnreadTotal(ctx, database, 1); n != 2 {
		t.Fatalf("unread after a later message %d", n)
	}
}

func TestDirectMessageHistoryAndRosterAreParticipantOnlyAndIndexed(t *testing.T) {
	ctx := context.Background()
	database := dmFixtureDB(t)
	if _, err := SendDirectMessage(ctx, database, DirectSendRequest{SenderID: 1, RecipientID: 2, ClientID: testNonce(1), Body: "hi"}); err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `DELETE FROM follows`)
	if page, err := DirectHistory(ctx, database, 2, 1, 0, 10); err != nil || len(page.Messages) != 1 {
		t.Fatalf("participant history after unfollow: %+v %v", page, err)
	}
	for _, viewer := range []int64{3, 4} {
		if _, err := DirectHistory(ctx, database, viewer, 1, 0, 10); !errors.Is(err, ErrNotFound) {
			t.Fatalf("third party %d: %v", viewer, err)
		}
	}
	mustExec(t, database, `UPDATE users SET is_active=0 WHERE id=2`)
	if _, err := DirectHistory(ctx, database, 1, 2, 0, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inactive counterpart: %v", err)
	}
	if roster, err := DirectRoster(ctx, database, 1, 1, 20); err != nil || roster.Total != 0 || len(roster.Items) != 0 {
		t.Fatalf("roster with an inactive counterpart: %+v %v", roster, err)
	}
	if n, err := DirectUnreadTotal(ctx, database, 1); err != nil || n != 0 {
		t.Fatalf("unread from an inactive counterpart: %d %v", n, err)
	}
	// History and unread counting use the pair indexes rather than scanning messages.
	for _, query := range []string{
		`SELECT id FROM private_messages WHERE (sender_id=1 AND recipient_id=2) OR (sender_id=2 AND recipient_id=1) ORDER BY id DESC LIMIT 11`,
		`SELECT COUNT(*) FROM private_messages WHERE sender_id=2 AND recipient_id=1 AND id>0`,
	} {
		rows, err := database.Query(`EXPLAIN QUERY PLAN ` + query)
		if err != nil {
			t.Fatal(err)
		}
		plan := ""
		for rows.Next() {
			var a, b, c int
			var detail string
			rows.Scan(&a, &b, &c, &detail)
			plan += detail + "\n"
		}
		rows.Close()
		if !strings.Contains(plan, "idx_pm_") || strings.Contains(plan, "SCAN private_messages") {
			t.Fatalf("query scans the table:\n%s", plan)
		}
	}
}
