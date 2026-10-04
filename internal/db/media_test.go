package db

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func mediaPNG(t *testing.T, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: shade, A: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}
func assertMedia(t *testing.T, database *sql.DB, viewer int64, url string, data []byte) {
	t.Helper()
	m, err := AuthorizedMedia(context.Background(), database, viewer, url)
	if err != nil {
		t.Fatalf("media %s viewer %d: %v", url, viewer, err)
	}
	got, err := ReadMediaFile(database, m)
	if err != nil || !bytes.Equal(data, got) {
		t.Fatalf("media changed %s err=%v", url, err)
	}
}
func denyMedia(t *testing.T, database *sql.DB, viewer int64, url string) {
	t.Helper()
	if _, err := AuthorizedMedia(context.Background(), database, viewer, url); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("media %s viewer %d denial: %v", url, viewer, err)
	}
}
func TestMediaOwnershipStagingReplacementAndEveryOwner(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	data := mediaPNG(t, 32)
	owner := WithSocialViewer(ctx, 1)
	url, _, err := StageMedia(ctx, database, 1, 0, "content", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 1, url, data)
	denyMedia(t, database, 2, url)
	if _, err := CreatePostWithCategories(WithSocialViewer(ctx, 2), database, 2, "spoof", "body", "published", []int64{1}, &url); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("foreign claim %v", err)
	}
	id, err := CreatePostWithCategories(owner, database, 1, "post", "body", "published", []int64{1}, &url)
	if err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 2, url, data)
	if _, err := CreatePostWithCategories(owner, database, 1, "reuse", "body", "published", []int64{1}, &url); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("new association from readable URL %v", err)
	}
	mustExec(t, database, `UPDATE users SET profile_visibility='private' WHERE id=1`)
	denyMedia(t, database, 2, url)
	mustExec(t, database, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2000-01-01')`)
	assertMedia(t, database, 2, url, data)
	commentURL, _, err := StageMedia(ctx, database, 2, 0, "content", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	comment, err := CreateComment(WithSocialViewer(ctx, 2), database, CreateCommentInput{PostID: id, UserID: 2, Body: "image", ImageURL: &commentURL})
	if err != nil {
		t.Fatal(err)
	}
	denyMedia(t, database, 3, commentURL)
	// Shared historical bytes may have multiple owners; cleanup preserves every link.
	dmURL, _, err := StageMedia(ctx, database, 2, 3, "dm", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	denyMedia(t, database, 3, dmURL)
	if err := DiscardStagedMedia(ctx, database, dmURL, 2); err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 2, dmURL, data)
	if _, err := CreateMessage(WithSocialViewer(ctx, 2), database, CreateMessageRequest{SenderID: 2, RecipientID: 1, ImagePath: dmURL}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("recipient spoof %v", err)
	}
	msg, err := CreateMessage(WithSocialViewer(ctx, 2), database, CreateMessageRequest{SenderID: 2, RecipientID: 3, ImagePath: dmURL})
	if err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 3, dmURL, data)
	denyMedia(t, database, 1, dmURL)
	mustExec(t, database, `UPDATE comments SET image_url=? WHERE id=?`, dmURL, comment)
	if err := DeletePost(owner, database, id); err != nil {
		t.Fatal(err)
	}
	denyMedia(t, database, 1, url)
	assertMedia(t, database, 3, dmURL, data)
	mustExec(t, database, `DELETE FROM private_messages WHERE id=?`, msg.ID)
	if err := CleanupMedia(ctx, database, false); err != nil {
		t.Fatal(err)
	}
	denyMedia(t, database, 3, dmURL)
	abandoned, path, err := StageMedia(ctx, database, 1, 0, "content", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if err := DiscardStagedMedia(ctx, database, abandoned, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("rollback bytes retained %v", err)
	}
}
func TestMediaUpgradeRepeatedRestartAndRecovery(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	legacy := filepath.Join(base, "legacy")
	if err := os.MkdirAll(filepath.Join(legacy, "dm"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LEGACY_UPLOAD_ROOTS", legacy)
	old := fstest.MapFS{}
	for _, name := range []string{"000001_initial.up.sql", "000002_profiles_follows.up.sql", "000003_relationship_notifications.up.sql"} {
		raw, err := migrationFS.ReadFile("migrations/sqlite/" + name)
		if err != nil {
			t.Fatal(err)
		}
		old["migrations/sqlite/"+name] = &fstest.MapFile{Data: raw}
	}
	path := filepath.Join(base, "upgrade.db")
	database, err := initDBWithMigrations(ctx, path, old)
	if err != nil {
		t.Fatal(err)
	}
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	data := mediaPNG(t, 96)
	for _, name := range []string{"kept.png", "dm/kept.png", "unknown.png"} {
		if err := os.WriteFile(filepath.Join(legacy, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "objects", "avatar.png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,avatar_key)VALUES(1,'one','one@example.com','hash','One','Person','2000-01-01','avatar.png'),(2,'two','two@example.com','hash','Two','Person','2000-01-01',NULL);
 INSERT INTO posts(id,author_id,title,body,image_url)VALUES(10,1,'kept','body','/static/uploads/kept.png');
 INSERT INTO comments(id,post_id,user_id,body,image_url)VALUES(20,10,2,'kept','web/static/uploads/kept.png');
 INSERT INTO private_messages(id,sender_id,recipient_id,body,image_path)VALUES(30,1,2,'kept','/static/uploads/dm/kept.png');
 INSERT INTO posts(id,author_id,title,body,image_url)VALUES(11,1,'missing','body','/static/uploads/missing.png'),(12,1,'unmappable','body','https://example.com/asset.png');`)
	database.Close()
	for attempt := 0; attempt < 3; attempt++ {
		database, err = InitDB(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		assertMedia(t, database, 2, "/static/uploads/kept.png", data)
		assertMedia(t, database, 2, "/static/uploads/dm/kept.png", data)
		avatar, err := AvatarMedia(ctx, database, 2, 1)
		if err != nil {
			t.Fatal(err)
		}
		got, err := ReadMediaFile(database, avatar)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatal("avatar lost")
		}
		var links, objects int
		if err := database.QueryRow(`SELECT COUNT(*) FROM media_links`).Scan(&links); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRow(`SELECT COUNT(*) FROM media_objects`).Scan(&objects); err != nil {
			t.Fatal(err)
		}
		if links != 6 || objects != 5 {
			t.Fatalf("links=%d objects=%d", links, objects)
		}
		if attempt == 0 {
			denyMedia(t, database, 1, "/static/uploads/missing.png")
			if err := os.WriteFile(filepath.Join(legacy, "missing.png"), data, 0600); err != nil {
				t.Fatal(err)
			}
		} else {
			assertMedia(t, database, 1, "/static/uploads/missing.png", data)
		}
		if _, err := os.Stat(filepath.Join(legacy, "unknown.png")); err != nil {
			t.Fatal("unknown legacy file destroyed")
		}
		// Simulate lost private copy after manifest commit: sources still recover it.
		if attempt == 1 {
			m, err := AuthorizedMedia(ctx, database, 2, "/static/uploads/kept.png")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(root, "objects", m.Key)); err != nil {
				t.Fatal(err)
			}
		}
		database.Close()
	}
}
func TestMediaCopyFailureResumesAndConflictingRootsStayRecoverable(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	one := t.TempDir()
	two := t.TempDir()
	data := mediaPNG(t, 20)
	other := mediaPNG(t, 70)
	t.Setenv("LEGACY_UPLOAD_ROOTS", one+string(os.PathListSeparator)+two)
	if err := os.WriteFile(filepath.Join(one, "asset.png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(two, "asset.png"), other, 0600); err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `INSERT INTO posts(id,author_id,title,body,image_url)VALUES(10,1,'asset','body','/static/uploads/asset.png')`)
	if err := PrepareMediaStorage(ctx, database, root); err != nil {
		t.Fatal(err)
	}
	denyMedia(t, database, 1, "/static/uploads/asset.png")
	if err := os.Remove(filepath.Join(two, "asset.png")); err != nil {
		t.Fatal(err)
	}
	var key string
	if err := database.QueryRow(`SELECT object_key FROM media_objects WHERE legacy_url='/static/uploads/asset.png'`).Scan(&key); err != nil {
		t.Fatal(err)
	}
	// Rename fails after temporary copy; manifest/source survive and no partial final bytes.
	if err := os.Mkdir(filepath.Join(root, "objects", key), 0700); err != nil {
		t.Fatal(err)
	}
	if err := PrepareMediaStorage(ctx, database, root); err == nil {
		t.Fatal("nonregular private object allowed readiness")
	}
	if err := os.Remove(filepath.Join(root, "objects", key)); err != nil {
		t.Fatal(err)
	}
	if err := PrepareMediaStorage(ctx, database, root); err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 1, "/static/uploads/asset.png", data)
	pending, _, err := StageMedia(ctx, database, 1, 2, "dm", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if err := PrepareMediaStorage(ctx, database, root); err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 1, pending, data)
	denyMedia(t, database, 2, pending)
	orphan := filepath.Join(root, "objects", "orphan.png")
	if err := os.WriteFile(orphan, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := CleanupMedia(ctx, database, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("private orphan not swept")
	}
	assertMedia(t, database, 1, pending, data)
}

type interruptedMediaReader struct{ read bool }

func (r *interruptedMediaReader) Read(buffer []byte) (int, error) {
	if !r.read {
		r.read = true
		copy(buffer, []byte("partial"))
		return 7, nil
	}
	return 0, errors.New("injected interrupted source read")
}
func TestMediaInterruptedWriteKeepsCommittedBytesAndDMRestart(t *testing.T) {
	database := profileTestDB(t)
	ctx := context.Background()
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	data := mediaPNG(t, 100)
	pending, path, err := StageMedia(ctx, database, 1, 2, "dm", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	key := filepath.Base(path)
	if err := writeMediaBytes(root, key, &interruptedMediaReader{}); err == nil {
		t.Fatal("interrupted write succeeded")
	}
	assertMedia(t, database, 1, pending, data)
	temps, err := filepath.Glob(filepath.Join(root, ".tmp-media-*"))
	if err != nil || len(temps) != 0 {
		t.Fatalf("temporary files %v err=%v", temps, err)
	}
	var dbPath string
	if err := database.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&dbPath); err != nil {
		t.Fatal(err)
	}
	database.Close()
	reopened, err := InitDB(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	assertMedia(t, reopened, 1, pending, data)
	denyMedia(t, reopened, 2, pending)
	msg, err := CreateMessage(WithSocialViewer(ctx, 1), reopened, CreateMessageRequest{SenderID: 1, RecipientID: 2, ImagePath: pending})
	if err != nil {
		t.Fatal(err)
	}
	assertMedia(t, reopened, 2, pending, data)
	history, _, err := GetMessageHistory(WithSocialViewer(ctx, 2), reopened, 2, 1, 0)
	if err != nil || len(history) != 1 || history[0].ID != msg.ID || history[0].ImagePath == nil || *history[0].ImagePath != pending {
		t.Fatalf("history %+v err=%v", history, err)
	}
}
func TestMediaReplacementFailurePreservesOldOwner(t *testing.T) {
	database := profileTestDB(t)
	ctx := WithSocialViewer(context.Background(), 1)
	data := mediaPNG(t, 120)
	old, _, err := StageMedia(ctx, database, 1, 0, "content", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	post, err := CreatePostWithCategories(ctx, database, 1, "post", "body", "published", []int64{1}, &old)
	if err != nil {
		t.Fatal(err)
	}
	replacement, _, err := StageMedia(ctx, database, 1, 0, "content", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, database, `CREATE TRIGGER fail_replacement BEFORE UPDATE OF image_url ON posts BEGIN SELECT RAISE(ABORT,'injected write failure');END;`)
	if err := UpdatePostContent(ctx, database, post, UpdatePostInput{ImageURL: &replacement, HasImageUpdate: true}); err == nil {
		t.Fatal("failed replacement committed")
	}
	assertMedia(t, database, 2, old, data)
	denyMedia(t, database, 2, replacement)
	mustExec(t, database, `DROP TRIGGER fail_replacement`)
	if err := UpdatePostContent(ctx, database, post, UpdatePostInput{ImageURL: &replacement, HasImageUpdate: true}); err != nil {
		t.Fatal(err)
	}
	assertMedia(t, database, 2, replacement, data)
	denyMedia(t, database, 1, old)
}
