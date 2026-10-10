package db

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func contentPhase2Files(t *testing.T) fstest.MapFS {
	t.Helper()
	files := fstest.MapFS{}
	names, err := fs.Glob(migrationFS, "migrations/sqlite/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		// The phase-4 group migration builds on version 5, so the old-world
		// fixture stops before both it and the content rebuild.
		if strings.Contains(name, "000005_") || strings.Contains(name, "000006_") || strings.Contains(name, "000007_") {
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

type preservedTable struct {
	Columns []string
	Rows    string
}

func contentSnapshot(t *testing.T, database *sql.DB, template map[string]preservedTable) map[string]preservedTable {
	t.Helper()
	out := map[string]preservedTable{}
	names := []string{}
	if template == nil {
		rows, err := database.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN('schema_migrations','sqlite_sequence') ORDER BY name`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var name string
			rows.Scan(&name)
			names = append(names, name)
		}
		rows.Close()
	} else {
		for name := range template {
			names = append(names, name)
		}
	}
	for _, name := range names {
		cols := template[name].Columns
		if template == nil {
			rows, err := database.Query(`SELECT * FROM ` + name + ` LIMIT 0`)
			if err != nil {
				t.Fatal(err)
			}
			cols, _ = rows.Columns()
			rows.Close()
		}
		rows, err := database.Query(`SELECT ` + strings.Join(cols, ",") + ` FROM ` + name + ` ORDER BY 1,2`)
		if err != nil {
			t.Fatal(err)
		}
		data := [][]any{}
		for rows.Next() {
			values := make([]any, len(cols))
			dest := make([]any, len(cols))
			for i := range values {
				dest[i] = &values[i]
			}
			if err := rows.Scan(dest...); err != nil {
				t.Fatal(err)
			}
			data = append(data, values)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		b, _ := json.Marshal(data)
		out[name] = preservedTable{cols, string(b)}
	}
	return out
}
func seedContentUpgrade(t *testing.T, database *sql.DB) {
	t.Helper()
	for id := 1; id <= 3; id++ {
		mustExec(t, database, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,display_name_search)VALUES(?,?,?,'hash','Test','Person','2000-01-01','test person')`, id, fmt.Sprintf("user%d", id), fmt.Sprintf("user%d@test.local", id))
	}
	mustExec(t, database, `UPDATE users SET profile_visibility='private',profile_version=3 WHERE id=1;
 INSERT INTO sessions(id,user_id,token,ip,user_agent,is_valid,revoked_at)VALUES(10,1,'valid','','agent',1,NULL),(11,2,'revoked','','agent2',0,'2000-01-01');
 INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(20,2,1,'accepted','2000-01-01');
 INSERT INTO follows(id,follower_id,followed_id,state)VALUES(21,3,1,'pending');
 INSERT INTO posts(id,author_id,title,body,status,created_at,updated_at)VALUES(30,1,' keep title bytes ','body','published','2000-01-01','2000-01-02'),(31,1,'draft','draft','draft','2000-01-03','2000-01-04'),(32,2,'archived','archived','archived','2000-01-05','2000-01-06'),(33,2,'whitespace','  ','published','2000-01-07','2000-01-08');
 INSERT INTO post_categories VALUES(30,1),(30,2),(31,3);
 INSERT INTO comments(id,post_id,user_id,parent_comment_id,body)VALUES(40,30,2,NULL,'root'),(41,30,3,40,'nested'),(42,30,2,41,'deep');
 INSERT INTO reactions(id,user_id,post_id,comment_id,value)VALUES(50,2,30,NULL,1),(51,1,NULL,41,-1);
 INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,comment_id,is_read)VALUES(60,1,2,'comment',30,NULL,0),(61,3,1,'comment_dislike',NULL,41,1);
 INSERT INTO notifications(id,recipient_id,actor_id,type,follow_id,follow_state)VALUES(62,1,3,'follow_request',21,'pending');
 INSERT INTO private_messages(id,sender_id,recipient_id,body)VALUES(70,1,2,'private');
 INSERT INTO posts(id,author_id,title,body)VALUES(999,1,'deleted','deleted');DELETE FROM posts WHERE id=999;
 CREATE INDEX retained_custom_post_index ON posts(title,body);
 CREATE TRIGGER retained_custom_post_trigger AFTER UPDATE OF body ON posts WHEN NEW.id=-1 BEGIN SELECT 1;END;`)
	data := mediaPNG(t, 64)
	root, err := AvatarRoot(database)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{80, 81, 82, 83, 84} {
		key := fmt.Sprintf("upgrade%d.png", id)
		source := "new:" + key
		if id == 80 {
			source = "avatar:" + key
		}
		mustExec(t, database, `INSERT INTO media_objects(id,source_key,object_key,mime_type,byte_count,state)VALUES(?,?,?,'image/png',?,'ready')`, id, source, key, len(data))
		if err := os.WriteFile(filepath.Join(root, "objects", key), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(t, database, `UPDATE users SET avatar_key='upgrade80.png' WHERE id=1;
 UPDATE posts SET image_url='/api/v1/media/81' WHERE id=30;
 UPDATE comments SET image_url='/api/v1/media/81' WHERE id=40;
 UPDATE comments SET image_url='/api/v1/media/82' WHERE id=41;
 UPDATE private_messages SET image_path='/api/v1/media/82' WHERE id=70;
 INSERT INTO media_pending(media_id,uploader_id,recipient_id,kind)VALUES(83,1,2,'dm'),(84,2,3,'dm');
 INSERT INTO media_objects(id,source_key,object_key,legacy_url,state)VALUES(85,'legacy:/static/uploads/missing.png','missing.png','/static/uploads/missing.png','missing');
 UPDATE posts SET image_url='/static/uploads/missing.png' WHERE id=32;`)
	if err := PrepareMediaStorage(context.Background(), database, root); err != nil {
		t.Fatal(err)
	}
}
func TestContentMigrationPreservesPhase2DataAndBytes(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")
	old, err := initDBWithMigrations(ctx, path, contentPhase2Files(t))
	if err != nil {
		t.Fatal(err)
	}
	seedContentUpgrade(t, old)
	before := contentSnapshot(t, old, nil)
	root, _ := AvatarRoot(old)
	files := map[string][]byte{}
	entries, _ := os.ReadDir(filepath.Join(root, "objects"))
	for _, entry := range entries {
		b, _ := os.ReadFile(filepath.Join(root, "objects", entry.Name()))
		files[entry.Name()] = b
	}
	old.Close()
	for i := 0; i < 2; i++ {
		database, err := InitDB(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		after := contentSnapshot(t, database, before)
		if !reflect.DeepEqual(before, after) {
			for name, value := range before {
				if !reflect.DeepEqual(value, after[name]) {
					t.Errorf("%s changed: %s -> %s", name, value.Rows, after[name].Rows)
				}
			}
			t.Fatal("upgrade changed Phase 2 rows")
		}
		var mapped int
		database.QueryRow(`SELECT COUNT(*) FROM posts WHERE audience='public' AND content_version=1`).Scan(&mapped)
		if mapped != 4 {
			t.Fatal("post backfill")
		}
		database.QueryRow(`SELECT COUNT(*) FROM comments WHERE content_version=1`).Scan(&mapped)
		if mapped != 3 {
			t.Fatal("comment backfill")
		}
		var sequence int
		database.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name='posts'`).Scan(&sequence)
		if sequence != 999 {
			t.Fatalf("sequence %d", sequence)
		}
		var fks int
		database.QueryRow(`PRAGMA foreign_keys`).Scan(&fks)
		if fks != 1 {
			t.Fatal("live pool foreign keys disabled")
		}
		check, err := database.Query(`PRAGMA foreign_key_check`)
		if err != nil {
			t.Fatal(err)
		}
		if check.Next() {
			t.Fatal("foreign key violation")
		}
		check.Close()
		var custom int
		database.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name IN('retained_custom_post_index','retained_custom_post_trigger','media_posts_insert','media_posts_update')`).Scan(&custom)
		if custom != 4 {
			t.Fatal("rebuild dropped indexes/triggers")
		}
		for name, want := range files {
			got, err := os.ReadFile(filepath.Join(root, "objects", name))
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("bytes lost %s: %v", name, err)
			}
		}
		database.Close()
	}
	database, err := InitDB(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	// Restored triggers still maintain links; incoming FKs still cascade against
	// the final posts/comments names. Fresh allocation never reuses deleted IDs.
	mustExec(t, database, `INSERT INTO posts(author_id,body,status)VALUES(1,'','draft')`)
	var newID int
	database.QueryRow(`SELECT MAX(id) FROM posts`).Scan(&newID)
	if newID != 1000 {
		t.Fatalf("allocation reused %d", newID)
	}
	mustExec(t, database, `UPDATE posts SET image_url='/api/v1/media/82' WHERE id=30`)
	var media int
	database.QueryRow(`SELECT media_id FROM media_links WHERE post_id=30`).Scan(&media)
	if media != 82 {
		t.Fatal("restored media trigger failed")
	}
	mustExec(t, database, `DELETE FROM posts WHERE id=30`)
	var count int
	database.QueryRow(`SELECT (SELECT COUNT(*) FROM comments)+(SELECT COUNT(*) FROM reactions)+(SELECT COUNT(*) FROM notifications WHERE post_id=30 OR comment_id IS NOT NULL)+(SELECT COUNT(*) FROM media_links WHERE post_id=30 OR comment_id IS NOT NULL)`).Scan(&count)
	if count != 0 {
		t.Fatalf("lost incoming cascades %d", count)
	}
}
func TestContentMigrationFailureBoundariesAreAtomicAndDirty(t *testing.T) {
	for _, stage := range []string{"before-copy", "before-swap", "before-check", "before-commit"} {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fault.db")
			old, err := initDBWithMigrations(context.Background(), path, contentPhase2Files(t))
			if err != nil {
				t.Fatal(err)
			}
			seedContentUpgrade(t, old)
			before := contentSnapshot(t, old, nil)
			root, _ := AvatarRoot(old)
			old.Close()
			ctx := context.WithValue(context.Background(), contentMigrationFaultKey{}, func(at string) error {
				if at == stage {
					return errors.New("injected " + stage)
				}
				return nil
			})
			if opened, err := initDBWithMigrations(ctx, path, migrationFS); err == nil {
				opened.Close()
				t.Fatal("failed rebuild allowed readiness")
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
			after := contentSnapshot(t, raw, before)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("failed rebuild changed data")
			}
			var version, dirty int
			raw.QueryRow(`SELECT version,dirty FROM schema_migrations`).Scan(&version, &dirty)
			if version != 5 || dirty != 1 {
				t.Fatalf("dirty marker %d %d", version, dirty)
			}
			var fks int
			raw.QueryRow(`PRAGMA foreign_keys`).Scan(&fks)
			if fks != 1 {
				t.Fatal("normal connection lost foreign keys")
			}
			for _, id := range []int{80, 81, 82, 83, 84} {
				b, err := os.ReadFile(filepath.Join(root, "objects", fmt.Sprintf("upgrade%d.png", id)))
				if err != nil || !bytes.Equal(b, mediaPNG(t, 64)) {
					t.Fatal("failed startup swept private bytes")
				}
			}
		})
	}
}
func TestContentMigrationRejectsCopyAndForeignKeyCorruption(t *testing.T) {
	for _, fault := range []string{"copy", "foreign-key"} {
		t.Run(fault, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "corrupt.db")
			database, err := initDBWithMigrations(context.Background(), path, contentPhase2Files(t))
			if err != nil {
				t.Fatal(err)
			}
			seedContentUpgrade(t, database)
			script, _ := migrationFS.ReadFile("migrations/sqlite/000005_content_audiences.up.sql")
			if fault == "copy" {
				script = []byte(strings.Replace(string(script), "-- B15 SWAP", `UPDATE posts_b15 SET title='corrupted' WHERE id=30;`+"\n-- B15 SWAP", 1))
			} else {
				script = append(script, []byte(`INSERT INTO post_categories VALUES(99999,1);`)...)
			}
			if err := rebuildContent(context.Background(), database, string(script)); err == nil {
				t.Fatal("corrupted rebuild committed")
			}
			var fks int
			database.QueryRow(`PRAGMA foreign_keys`).Scan(&fks)
			if fks != 1 {
				t.Fatal("failure returned a connection with FK disabled")
			}
			var title string
			database.QueryRow(`SELECT title FROM posts WHERE id=30`).Scan(&title)
			if title != " keep title bytes " {
				t.Fatal("corruption survived rollback")
			}
			database.Close()
		})
	}
}
