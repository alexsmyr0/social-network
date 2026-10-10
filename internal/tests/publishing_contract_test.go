package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"forum/internal/db"
)

type publishingFixtureCase struct {
	Name    string
	Viewer  *int64 `json:"viewer_id"`
	Given   map[string]map[string]map[string]any
	Request struct {
		Method, Path, Encoding string
		Body                   json.RawMessage
		RawBody                *string `json:"raw_body"`
		RawRepeat              struct {
			Value string
			Count int
		} `json:"raw_repeat"`
		Fields  map[string]any
		Files   map[string]json.RawMessage
		Headers map[string]*string
	}
	Response struct {
		Status        int
		Headers       map[string]string
		Body          json.RawMessage
		BinaryFixture string `json:"bytes_fixture"`
	}
	ExpectState map[string]map[string]map[string]any `json:"expect_state"`
	Unchanged   bool
	Signals     []struct {
		Type       string
		Recipients any
	}
}

func publishingFixtureRoute(path string) bool {
	path = strings.Split(path, "?")[0]
	if path == "/api/v1/posts" || path == "/api/v1/posts/mine" || path == "/api/v1/posts/draft" || strings.HasPrefix(path, "/api/v1/posts/draft/") || strings.HasPrefix(path, "/api/v1/media/") {
		return true
	}
	return strings.HasPrefix(path, "/api/v1/posts/") && !strings.Contains(strings.TrimPrefix(path, "/api/v1/posts/"), "/")
}
func TestPublishingContractFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-3-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack struct {
		Clock string
		State map[string]map[string]map[string]any
		Cases []publishingFixtureCase
	}
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, c := range pack.Cases {
		if !publishingFixtureRoute(c.Request.Path) {
			continue
		}
		ran++
		t.Run(c.Name, func(t *testing.T) {
			handler, conn := socialAPI(t)
			// Overlay the fixture state before insertion; null entries mean removed rows.
			state := map[string]map[string]map[string]any{}
			b, _ := json.Marshal(pack.State)
			json.Unmarshal(b, &state)
			for table, rows := range c.Given {
				if state[table] == nil {
					state[table] = map[string]map[string]any{}
				}
				for id, fields := range rows {
					if fields == nil {
						delete(state[table], id)
						continue
					}
					if state[table][id] == nil {
						state[table][id] = map[string]any{}
					}
					for k, v := range fields {
						state[table][id][k] = v
					}
				}
			}
			seedPublishingFixture(t, conn, state, pack.Clock)
			if c.Name == "image-replacement-commit-failure" {
				fixtureExec(t, conn, `CREATE TABLE fail_content_commit(id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED);CREATE TRIGGER fail_content_update AFTER UPDATE ON posts BEGIN INSERT INTO fail_content_commit VALUES(-1);END;`)
			}
			before := publishingStateSnapshot(t, conn)
			signals := 0
			db.SetSocialInvalidationHook(func(ids []int64) {
				if len(ids) != 0 {
					t.Errorf("content signal is not global")
				}
				signals++
			})
			t.Cleanup(func() { db.SetSocialInvalidationHook(nil) })
			request := publishingFixtureRequest(t, c)
			if c.Viewer != nil {
				fixtureExec(t, conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(?,'b15-fixture','','')`, *c.Viewer)
				request.AddCookie(&http.Cookie{Name: "session_token", Value: "b15-fixture"})
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != c.Response.Status {
				t.Fatalf("status %d %s; want %d", response.Code, response.Body.String(), c.Response.Status)
			}
			for k, v := range c.Response.Headers {
				if response.Header().Get(k) != v {
					t.Errorf("header %s=%q want %q", k, response.Header().Get(k), v)
				}
			}
			if c.Response.BinaryFixture != "" {
				bytesWant, err := os.ReadFile(filepath.Join("../..", c.Response.BinaryFixture))
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(response.Body.Bytes(), bytesWant) {
					t.Fatal("media bytes differ")
				}
			} else if len(c.Response.Body) > 0 {
				var got, want any
				if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				json.Unmarshal(c.Response.Body, &want)
				normalizePublishingResponse(got, want, c.Request.Method != "GET" && response.Code < 300)
				if !reflect.DeepEqual(got, want) {
					a, _ := json.Marshal(got)
					b, _ := json.Marshal(want)
					t.Fatalf("response %s; want %s", a, b)
				}
			}
			assertPublishingFixtureState(t, conn, c.ExpectState, c.Viewer)
			expectedSignals := 0
			for _, s := range c.Signals {
				if s.Type == "social.invalidate" {
					expectedSignals++
				}
			}
			if signals != expectedSignals {
				t.Fatalf("signals %d want %d", signals, expectedSignals)
			}
			if c.Unchanged {
				after := publishingStateSnapshot(t, conn)
				if !reflect.DeepEqual(before, after) {
					t.Fatalf("failed/noop request mutated content\nbefore %v\nafter %v", before, after)
				}
			}
			if c.Name == "image-replacement-commit-failure" {
				var pending int
				conn.QueryRow(`SELECT COUNT(*) FROM media_pending`).Scan(&pending)
				if pending != 0 {
					t.Fatal("rollback retained staging")
				}
				url := "/api/v1/media/401"
				r := socialRequest(t, handler, "GET", url, "", nil, "b15-fixture")
				if r.Code != 200 {
					t.Fatal("rollback lost prior bytes")
				}
			}
		})
	}
	if ran < 150 {
		t.Fatalf("fixture ownership filter unexpectedly ran only %d cases", ran)
	}
	t.Logf("%d B15 fixtures passed", ran)
}
func fixtureExec(t *testing.T, conn *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := conn.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}
func seedPublishingFixture(t *testing.T, conn *sql.DB, state map[string]map[string]map[string]any, clock string) {
	for key, u := range state["users"] {
		fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,nickname,profile_visibility,is_active,display_name_search)VALUES(?,?,?,'hash','Fixture','Person','2000-01-01',?,?,?,?)`, key, "fixture"+key, "fixture"+key+"@test.local", u["display_name"], u["visibility"], u["is_active"], strings.ToLower(u["display_name"].(string)))
	}
	for key, f := range state["follows"] {
		var accepted any
		if f["state"] == "accepted" {
			accepted = clock
		}
		fixtureExec(t, conn, `INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(?,?,?,?,?)`, key, f["follower_id"], f["followed_id"], f["state"], accepted)
	}
	root, err := db.AvatarRoot(conn)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	for key, m := range state["media"] {
		image, err := os.ReadFile(filepath.Join("../..", m["fixture"].(string)))
		if err != nil {
			t.Fatal(err)
		}
		object := "fixture" + key + ".png"
		fixtureExec(t, conn, `INSERT INTO media_objects(id,source_key,object_key,mime_type,byte_count,state)VALUES(?,?,?,'image/png',?,?)`, key, "fixture:"+key, object, len(image), m["state"])
		if m["state"] == "ready" {
			if err := os.WriteFile(filepath.Join(root, "objects", object), image, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	for key, p := range state["posts"] {
		fixtureExec(t, conn, `INSERT INTO posts(id,author_id,title,body,image_url,status,audience,content_version,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?)`, key, p["author_id"], p["title"], p["body"], p["image_url"], p["status"], p["audience"], p["version"], p["created_at"], p["updated_at"])
		categories, _ := p["categories"].([]any)
		for _, v := range categories {
			cat := v.(map[string]any)
			fixtureExec(t, conn, `INSERT INTO post_categories VALUES(?,?)`, key, cat["id"])
		}
		selected, _ := p["selected_follow_ids"].([]any)
		for _, follow := range selected {
			fixtureExec(t, conn, `INSERT INTO post_selected_followers VALUES(?,?)`, key, follow)
		}
	}
	// Parents are inserted before nested replies, so foreign keys hold.
	commentKeys := make([]string, 0, len(state["comments"]))
	for key := range state["comments"] {
		commentKeys = append(commentKeys, key)
	}
	sort.Slice(commentKeys, func(i, j int) bool {
		a, _ := strconv.Atoi(commentKeys[i])
		b, _ := strconv.Atoi(commentKeys[j])
		return a < b
	})
	for _, key := range commentKeys {
		c := state["comments"][key]
		fixtureExec(t, conn, `INSERT INTO comments(id,post_id,user_id,parent_comment_id,body,image_url,content_version,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)`, key, c["post_id"], c["user_id"], c["parent_comment_id"], c["body"], c["image_url"], c["version"], c["created_at"], c["updated_at"])
	}
	for key, r := range state["reactions"] {
		fixtureExec(t, conn, `INSERT INTO reactions(id,user_id,post_id,comment_id,value)VALUES(?,?,?,?,?)`, key, r["user_id"], r["post_id"], r["comment_id"], r["value"])
	}
	for key, n := range state["notifications"] {
		fixtureExec(t, conn, `INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,comment_id,is_read,created_at)VALUES(?,?,?,?,?,?,?,?)`, key, n["recipient_id"], n["actor_id"], n["type"], n["post_id"], n["comment_id"], n["is_read"], n["created_at"])
	}
	if len(state["categories"]) > 0 {
		// The database seeds default categories; the fixture's category set is exact.
		keep := []any{}
		for key := range state["categories"] {
			keep = append(keep, key)
		}
		fixtureExec(t, conn, `DELETE FROM categories WHERE id NOT IN (`+strings.TrimSuffix(strings.Repeat("?,", len(keep)), ",")+`)`, keep...)
	}
	for key, c := range state["categories"] {
		fixtureExec(t, conn, `UPDATE categories SET name=?,created_at=? WHERE id=?`, c["name"], c["created_at"], key)
	}
}
func publishingFixtureRequest(t *testing.T, c publishingFixtureCase) *http.Request {
	var body bytes.Buffer
	contentType := "application/json"
	if c.Request.Encoding == "multipart" {
		form := multipart.NewWriter(&body)
		for k, value := range c.Request.Fields {
			values := []any{value}
			if array, ok := value.([]any); ok {
				values = array
			}
			for _, v := range values {
				if err := form.WriteField(k, fmt.Sprint(v)); err != nil {
					t.Fatal(err)
				}
			}
		}
		for k, raw := range c.Request.Files {
			var filename string
			var data []byte
			if json.Unmarshal(raw, &filename) == nil {
				var err error
				data, err = os.ReadFile(filepath.Join("../..", filename))
				if err != nil {
					t.Fatal(err)
				}
				filename = filepath.Base(filename)
			} else {
				var file struct {
					Literal, Filename string
					RepeatByte        byte `json:"repeat_byte"`
					Count             int
				}
				if err := json.Unmarshal(raw, &file); err != nil {
					t.Fatal(err)
				}
				filename = file.Filename
				data = []byte(file.Literal)
				if file.Count > 0 {
					data = bytes.Repeat([]byte{file.RepeatByte}, file.Count)
				}
			}
			part, err := form.CreateFormFile(k, filename)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := part.Write(data); err != nil {
				t.Fatal(err)
			}
		}
		form.Close()
		contentType = form.FormDataContentType()
	} else if c.Request.RawBody != nil {
		body.WriteString(*c.Request.RawBody)
	} else if c.Request.RawRepeat.Count > 0 {
		body.WriteString(strings.Repeat(c.Request.RawRepeat.Value, c.Request.RawRepeat.Count))
	} else {
		body.Write(c.Request.Body)
	}
	r := httptest.NewRequest(c.Request.Method, c.Request.Path, &body)
	r.Header.Set("Content-Type", contentType)
	if r.Method != "GET" {
		r.Header.Set("Origin", "http://localhost:3000")
		r.Header.Set("X-Requested-With", "XMLHttpRequest")
	}
	for k, v := range c.Request.Headers {
		if v == nil {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, *v)
		}
	}
	return r
}
func normalizePublishingResponse(got, want any, mutation bool) {
	gm, gok := got.(map[string]any)
	wm, wok := want.(map[string]any)
	if gok && wok {
		if _, isError := gm["code"]; isError && gm["code"] != "STALE_CONTENT" {
			delete(gm, "message")
			delete(wm, "message")
		}
		// Phase 4 adds a nullable group scope to posts and drafts. Personal content
		// keeps the Phase 3 contract otherwise, so a null scope is not a difference.
		if scope, has := gm["group"]; has && scope == nil {
			if _, expected := wm["group"]; !expected {
				delete(gm, "group")
			}
		}
		for k, v := range gm {
			if mutation && (k == "created_at" || k == "updated_at" || k == "accepted_at") {
				gm[k] = wm[k]
			} else {
				normalizePublishingResponse(v, wm[k], mutation)
			}
		}
	} else if ga, ok := got.([]any); ok {
		if wa, ok := want.([]any); ok {
			for i := range ga {
				if i < len(wa) {
					normalizePublishingResponse(ga[i], wa[i], mutation)
				}
			}
		}
	}
}
func publishingStateSnapshot(t *testing.T, conn *sql.DB) map[string]string {
	out := map[string]string{}
	for _, table := range []string{"posts", "comments", "reactions", "notifications", "post_categories", "post_selected_followers", "media_links", "media_pending", "media_objects"} {
		rows, err := conn.Query(`SELECT * FROM ` + table + ` ORDER BY 1`)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
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
		out[table] = string(b)
	}
	return out
}

func assertPublishingFixtureState(t *testing.T, conn *sql.DB, expected map[string]map[string]map[string]any, viewer *int64) {
	t.Helper()
	for table, rows := range expected {
		actualTable := map[string]string{"posts": "posts", "comments": "comments", "media": "media_objects", "follows": "follows", "reactions": "reactions", "notifications": "notifications"}[table]
		if actualTable == "" {
			t.Fatalf("unsupported fixture postcondition table %s", table)
		}
		if len(rows) == 0 {
			// An empty table map asserts the table has no rows.
			var count int
			if err := conn.QueryRow(`SELECT COUNT(*) FROM ` + actualTable).Scan(&count); err != nil || count != 0 {
				t.Fatalf("%s has %d rows, want none: %v", table, count, err)
			}
		}
		for id, fields := range rows {
			if fields == nil {
				var count int
				if err := conn.QueryRow(`SELECT COUNT(*) FROM `+actualTable+` WHERE id=?`, id).Scan(&count); err != nil || count != 0 {
					t.Fatalf("%s %s still exists: %v", table, id, err)
				}
				continue
			}
			for key, want := range fields {
				var got any
				if key == "selected_follow_ids" {
					selected := []int64{}
					r, err := conn.Query(`SELECT follow_id FROM post_selected_followers WHERE post_id=? ORDER BY follow_id`, id)
					if err != nil {
						t.Fatal(err)
					}
					for r.Next() {
						var n int64
						r.Scan(&n)
						selected = append(selected, n)
					}
					r.Close()
					got = selected
				} else {
					column := key
					if key == "version" {
						column = "content_version"
					}
					if key == "post_id" && table == "media" {
						if err := conn.QueryRow(`SELECT post_id FROM media_links WHERE media_id=? AND post_id IS NOT NULL`, id).Scan(&got); err != nil {
							t.Fatal(err)
						}
					} else if table == "comments" && (key == "username" || key == "likes" || key == "dislikes" || key == "my_reaction") {
						query := map[string]string{"username": `SELECT COALESCE(u.nickname,u.first_name||' '||u.last_name) FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?`, "likes": `SELECT COUNT(*) FROM reactions WHERE comment_id=? AND value=1`, "dislikes": `SELECT COUNT(*) FROM reactions WHERE comment_id=? AND value=-1`, "my_reaction": `SELECT COALESCE(MAX(value),0) FROM reactions WHERE comment_id=? AND user_id=?`}[key]
						args := []any{id}
						if key == "my_reaction" {
							args = append(args, viewer)
						}
						if err := conn.QueryRow(query, args...).Scan(&got); err != nil {
							t.Fatal(err)
						}
					} else {
						// Fixture keys are data, never executable identifiers.
						allowed := map[string]bool{"id": true, "author_id": true, "title": true, "body": true, "image_url": true, "status": true, "audience": true, "content_version": true, "created_at": true, "updated_at": true, "post_id": true, "user_id": true, "parent_comment_id": true, "state": true, "comment_id": true, "value": true, "is_read": true, "recipient_id": true, "actor_id": true, "type": true}
						if !allowed[column] {
							t.Fatalf("unsupported fixture field %s", key)
						}
						if err := conn.QueryRow(`SELECT `+column+` FROM `+actualTable+` WHERE id=?`, id).Scan(&got); err != nil {
							t.Fatal(err)
						}
					}
				}
				if key == "is_read" {
					got = got == int64(1)
				}
				b, _ := json.Marshal(got)
				var normalized any
				json.Unmarshal(b, &normalized)
				if !reflect.DeepEqual(normalized, want) {
					t.Fatalf("%s %s.%s = %v want %v", table, id, key, normalized, want)
				}
			}
		}
	}
}
func TestPublishingContractFollowReselectionSequence(t *testing.T) {
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-3-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack struct {
		Clock     string
		State     map[string]map[string]map[string]any
		Sequences []struct {
			Given map[string]map[string]map[string]any
			Steps []publishingFixtureCase
		}
	}
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	if len(pack.Sequences) != 1 || len(pack.Sequences[0].Steps) != 6 {
		t.Fatal("follow sequence coverage changed")
	}
	handler, conn := socialAPI(t)
	for table, rows := range pack.Sequences[0].Given {
		for id, fields := range rows {
			for k, v := range fields {
				pack.State[table][id][k] = v
			}
		}
	}
	seedPublishingFixture(t, conn, pack.State, pack.Clock)
	for _, id := range []int64{7, 42} {
		fixtureExec(t, conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, id, fmt.Sprintf("sequence-%d", id))
	}
	for i, c := range pack.Sequences[0].Steps {
		request := publishingFixtureRequest(t, c)
		request.AddCookie(&http.Cookie{Name: "session_token", Value: fmt.Sprintf("sequence-%d", *c.Viewer)})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != c.Response.Status {
			t.Fatalf("step %d status %d %s want %d", i, response.Code, response.Body.String(), c.Response.Status)
		}
		for k, v := range c.Response.Headers {
			if response.Header().Get(k) != v {
				t.Fatalf("step %d header %s", i, k)
			}
		}
		if c.Response.BinaryFixture != "" {
			want, err := os.ReadFile(filepath.Join("../..", c.Response.BinaryFixture))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(response.Body.Bytes(), want) {
				t.Fatal("reselected bytes changed")
			}
		} else if len(c.Response.Body) > 0 {
			var got, want any
			json.Unmarshal(response.Body.Bytes(), &got)
			json.Unmarshal(c.Response.Body, &want)
			normalizePublishingResponse(got, want, c.Request.Method != "GET" && response.Code < 300)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("step %d response %v want %v", i, got, want)
			}
		}
		assertPublishingFixtureState(t, conn, c.ExpectState, c.Viewer)
	}
}

func TestPublishingHTTPBodyLineEndings(t *testing.T) {
	handler, conn := socialAPI(t)
	fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth)VALUES(1,'owner','owner@line-endings.test','hash','Owner','Test','2000-01-01');INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(1,'line-endings','','')`)
	png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	for _, encoding := range []string{"json", "multipart with image"} {
		for _, tc := range []struct {
			name, title, body, wantBody, invalidField, invalidCode string
		}{
			{name: "mixed line endings", body: " \r\none\r\ntwo\n\tthree\r\n ", wantBody: "one\ntwo\n\tthree"},
			{name: "normalized length limit", body: strings.Repeat("x\r\n", 4999) + "xx", wantBody: strings.Repeat("x\n", 4999) + "xx"},
			{name: "normalized length overflow", body: strings.Repeat("x\r\n", 4999) + "xxx", invalidField: "body", invalidCode: "TOO_LONG"},
			{name: "bare carriage return", body: "one\rtwo", invalidField: "body", invalidCode: "INVALID_TEXT"},
			{name: "title line break", title: "one\r\ntwo", body: "ok", invalidField: "title", invalidCode: "INVALID_TEXT"},
		} {
			t.Run(encoding+"/"+tc.name, func(t *testing.T) {
				fields := map[string]string{"title": tc.title, "body": tc.body}
				var response *httptest.ResponseRecorder
				if encoding == "json" {
					payload, err := json.Marshal(fields)
					if err != nil {
						t.Fatal(err)
					}
					response = socialRequest(t, handler, "POST", "/api/v1/posts", "application/json", payload, "line-endings")
				} else {
					response = contentUpload(t, handler, "line-endings", "/api/v1/posts", png, fields)
				}
				if tc.invalidField != "" {
					assertSocialCode(t, response, 400, "VALIDATION_ERROR")
					var got struct {
						Error struct{ Fields map[string]string }
					}
					if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
						t.Fatal(err)
					}
					if got.Error.Fields[tc.invalidField] != tc.invalidCode {
						t.Fatalf("validation fields %v, want %s=%s", got.Error.Fields, tc.invalidField, tc.invalidCode)
					}
					return
				}
				assertSocialCode(t, response, 201, "")
				var got struct{ Data db.Post }
				if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if got.Data.Body != tc.wantBody {
					t.Fatalf("response body length %d, want %d; normalized text differs", len(got.Data.Body), len(tc.wantBody))
				}
				if encoding == "multipart with image" && (got.Data.ImageURL == nil || *got.Data.ImageURL == "") {
					t.Fatal("multipart post lost its image")
				}
				var stored string
				if err := conn.QueryRow(`SELECT body FROM posts WHERE id=?`, got.Data.ID).Scan(&stored); err != nil {
					t.Fatal(err)
				}
				if stored != tc.wantBody {
					t.Fatal("stored body differs from normalized text")
				}
			})
		}
	}
}

func TestPublishingHTTPStructuralAndUnicodeBounds(t *testing.T) {
	handler, conn := socialAPI(t)
	fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth)VALUES(1,'owner','owner@bounds.test','hash','Owner','Test','2000-01-01');INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(1,'bounds','','')`)
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"unicode title", `{"title":"` + strings.Repeat("🙂", 200) + `","body":"ok"}`, 201, ""},
		{"unicode body", `{"body":"` + strings.Repeat("🙂", 10000) + `"}`, 201, ""},
		{"unicode title overflow", `{"title":"` + strings.Repeat("🙂", 201) + `","body":"ok"}`, 400, "VALIDATION_ERROR"},
		{"unicode body overflow", `{"body":"` + strings.Repeat("🙂", 10001) + `"}`, 400, "VALIDATION_ERROR"},
		{"body allowed controls", `{"body":"one\n\ttwo"}`, 201, ""},
		{"title control", `{"title":"one\ttwo","body":"ok"}`, 400, "VALIDATION_ERROR"},
		{"array string ID", `{"body":"ok","category_ids":["1"]}`, 400, "VALIDATION_ERROR"},
		{"fractional ID", `{"body":"ok","category_ids":[1.0]}`, 400, "VALIDATION_ERROR"},
		{"unsafe ID", `{"body":"ok","category_ids":[9007199254740992]}`, 400, "VALIDATION_ERROR"},
		{"null category array", `{"body":"ok","category_ids":null}`, 400, "VALIDATION_ERROR"},
		{"nonobject", `[]`, 400, "BAD_REQUEST"},
		{"null object", `null`, 400, "BAD_REQUEST"},
		{"invalid UTF8", string([]byte{'{', '"', 'b', 'o', 'd', 'y', '"', ':', '"', 0xff, '"', '}'}), 400, "BAD_REQUEST"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := socialRequest(t, handler, "POST", "/api/v1/posts", "application/json", []byte(tc.body), "bounds")
			assertSocialCode(t, r, tc.status, tc.code)
		})
	}
	for _, query := range []string{"page=-1", "page=1000001", "per_page=0", "page=1e2", "category_id=9007199254740992", "feed=all&feed=following", "status=all"} {
		assertSocialCode(t, socialRequest(t, handler, "GET", "/api/v1/posts?"+query, "", nil, "bounds"), 400, "BAD_REQUEST")
	}
	for _, body := range []string{`{"expected_version":"1","body":"ok"}`, `{"expected_version":1.0,"body":"ok"}`, `{"expected_version":null,"body":"ok"}`, `{"expected_version":-1,"body":"ok"}`, `{"expected_version":1,"body":null}`, `{"expected_version":"x","title":"` + strings.Repeat("x", 201) + `"}`} {
		assertSocialCode(t, socialRequest(t, handler, "PATCH", "/api/v1/posts/1", "application/json", []byte(body), "bounds"), 400, "BAD_REQUEST")
	}
	for _, tc := range []struct {
		name   string
		fields [][2]string
		status int
		code   string
	}{
		{"repeated scalar", [][2]string{{"body", "ok"}, {"body", "other"}}, 400, "BAD_REQUEST"},
		{"clear mixed with ID", [][2]string{{"body", "ok"}, {"category_ids", ""}, {"category_ids", "1"}}, 400, "BAD_REQUEST"},
		{"invalid remove flag", [][2]string{{"body", "ok"}, {"remove_image", "1"}}, 400, "BAD_REQUEST"},
		{"structured array text", [][2]string{{"body", "ok"}, {"category_ids", "[1]"}}, 400, "VALIDATION_ERROR"},
		{"decimal ID normalization", [][2]string{{"body", "ok"}, {"category_ids", "001"}}, 201, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var b bytes.Buffer
			form := multipart.NewWriter(&b)
			for _, pair := range tc.fields {
				form.WriteField(pair[0], pair[1])
			}
			form.Close()
			r := socialRequest(t, handler, "POST", "/api/v1/posts", form.FormDataContentType(), b.Bytes(), "bounds")
			assertSocialCode(t, r, tc.status, tc.code)
		})
	}
}

func TestPublishingStaleMediaEligibilityAndCheckedLegacyRetention(t *testing.T) {
	handler, conn := socialAPI(t)
	fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth)VALUES(1,'owner','owner@stale.test','hash','Owner','Test','2000-01-01');INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(1,'stale','','')`)
	png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	made := contentUpload(t, handler, "stale", "/api/v1/posts", png, map[string]string{"body": "body"})
	assertSocialCode(t, made, 201, "")
	var post struct{ Data db.Post }
	json.Unmarshal(made.Body.Bytes(), &post)
	path := fmt.Sprintf("/api/v1/posts/%d", post.Data.ID)
	// A stale owner sees a version conflict before media/follower eligibility.
	assertSocialCode(t, socialRequest(t, handler, "PATCH", path, "application/json", []byte(`{"expected_version":1,"body":"changed"}`), "stale"), 200, "")
	assertSocialCode(t, socialRequest(t, handler, "PATCH", path, "application/json", []byte(`{"expected_version":1,"image_url":"/api/v1/media/999"}`), "stale"), 409, "STALE_CONTENT")
	// JSON cannot consume fresh staging even if owned by this viewer.
	staged, _, err := db.StageMedia(context.Background(), conn, 1, 0, "content", png, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	assertSocialCode(t, socialRequest(t, handler, "PATCH", path, "application/json", []byte(fmt.Sprintf(`{"expected_version":2,"image_url":%q}`, staged)), "stale"), 404, "NOT_FOUND")
	fixtureExec(t, conn, `UPDATE media_objects SET legacy_url='/static/uploads/current.png' WHERE id=1;UPDATE posts SET image_url='/static/uploads/current.png' WHERE id=?`, post.Data.ID)
	// Checked legacy aliases may retain the same manifest association, but edits
	// without an image field must preserve the stored legacy reference bytes.
	assertSocialCode(t, socialRequest(t, handler, "PATCH", path, "application/json", []byte(`{"expected_version":2,"body":"another"}`), "stale"), 200, "")
	var rawURL string
	conn.QueryRow(`SELECT image_url FROM posts WHERE id=?`, post.Data.ID).Scan(&rawURL)
	if rawURL != "/static/uploads/current.png" {
		t.Fatal("omitted image rewrote historical reference")
	}
	retained := socialRequest(t, handler, "PATCH", path, "application/json", []byte(`{"expected_version":3,"image_url":"/static/uploads/current.png"}`), "stale")
	assertSocialCode(t, retained, 200, "")
	var got struct{ Data db.Post }
	json.Unmarshal(retained.Body.Bytes(), &got)
	if got.Data.Version != 3 {
		t.Fatal("same checked attachment was not a no-op")
	}
}
