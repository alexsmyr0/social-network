package tests

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type profileFixtureCase struct {
	Name     string                     `json:"name"`
	Viewer   *int64                     `json:"viewer_id"`
	State    map[string]json.RawMessage `json:"given"`
	Expected map[string]json.RawMessage `json:"expect"`
	Request  struct {
		Method, Path string
		JSON         json.RawMessage    `json:"json"`
		RawBody      *string            `json:"raw_body"`
		Headers      map[string]*string `json:"headers"`
	} `json:"request"`
	Response struct {
		Status        *int
		Headers       map[string]string
		Body          json.RawMessage
		BinaryFixture string `json:"binary_fixture"`
	} `json:"response"`
}

// Exercise the owner-approved B10 HTTP fixtures against real SQLite/router services.
// Notice writes, signals and infrastructure injection remain B12 or dedicated tests.
func TestSocialProfilesContractFixtures(t *testing.T) {
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-2-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack struct {
		Clock  string
		Actors []struct {
			ID         int64
			Email      string
			FirstName  string `json:"first_name"`
			LastName   string `json:"last_name"`
			DOB        string `json:"date_of_birth"`
			Nickname   *string
			AboutMe    *string `json:"about_me"`
			Visibility string
			Version    int64
		}
		Cases []profileFixtureCase
	}
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	ran := 0
	for _, c := range pack.Cases {
		if c.Response.Status == nil || strings.Contains(c.Request.Path, "/notifications") || len(c.State["failure"]) > 0 {
			continue
		}
		ran++
		t.Run(c.Name, func(t *testing.T) {
			handler, conn := socialAPI(t)
			for _, a := range pack.Actors {
				name := a.FirstName + " " + a.LastName
				if a.Nickname != nil {
					name = *a.Nickname
				}
				var avatar any
				if a.ID == 42 {
					avatar = "fixture.png"
				}
				if _, err := conn.Exec(`INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,nickname,about_me,avatar_key,profile_visibility,profile_version,display_name_search) VALUES(?,?,?,'hash',?,?,?,?,?,?,?,?,?)`, a.ID, fmt.Sprintf("internal-%d", a.ID), a.Email, a.FirstName, a.LastName, a.DOB, a.Nickname, a.AboutMe, avatar, a.Visibility, a.Version, strings.ToLower(name)); err != nil {
					t.Fatal(err)
				}
			}
			var root string
			if err := conn.QueryRow(`PRAGMA database_list`).Scan(new(int), new(string), &root); err != nil {
				t.Fatal(err)
			}
			png, err := os.ReadFile("../../SPA/tests/fixtures/a07/avatar.png")
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(filepath.Dir(root), "media", "objects", "fixture.png"), png, 0600); err != nil {
				t.Fatal(err)
			}
			var inactive []int64
			_ = json.Unmarshal(c.State["inactive_user_ids"], &inactive)
			for _, id := range inactive {
				if _, err := conn.Exec(`UPDATE users SET is_active=0 WHERE id=?`, id); err != nil {
					t.Fatal(err)
				}
			}
			var version int64
			if json.Unmarshal(c.State["profile_version"], &version) == nil {
				if _, err := conn.Exec(`UPDATE users SET profile_version=? WHERE id=42`, version); err != nil {
					t.Fatal(err)
				}
			}
			var follows []struct {
				ID       int64
				Follower int64 `json:"follower_id"`
				Target   int64 `json:"followed_id"`
				State    string
				Created  string  `json:"created_at"`
				Accepted *string `json:"accepted_at"`
			}
			_ = json.Unmarshal(c.State["follows"], &follows)
			for _, f := range follows {
				if _, err := conn.Exec(`INSERT INTO follows(id,follower_id,followed_id,state,created_at,accepted_at) VALUES(?,?,?,?,?,?)`, f.ID, f.Follower, f.Target, f.State, f.Created, f.Accepted); err != nil {
					t.Fatal(err)
				}
			}
			// Historical deleted IDs still advance AUTOINCREMENT, so retry fixtures get fresh IDs.
			high := int64(200)
			var removed []int64
			_ = json.Unmarshal(c.State["removed_follow_ids"], &removed)
			for _, id := range removed {
				if id > high {
					high = id
				}
			}
			if _, err := conn.Exec(`INSERT INTO sqlite_sequence(name,seq) SELECT 'follows',? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='follows'); UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='follows'`, high, high); err != nil {
				t.Fatal(err)
			}
			token := ""
			if c.Viewer != nil {
				token = "fixture-session"
				valid := 1
				var state string
				_ = json.Unmarshal(c.State["session"], &state)
				if state == "revoked" {
					valid = 0
				}
				if _, err := conn.Exec(`INSERT INTO sessions(user_id,token,is_valid,ip,user_agent) VALUES(?,?,?,'','')`, *c.Viewer, token, valid); err != nil {
					t.Fatal(err)
				}
			}
			body := []byte(c.Request.JSON)
			if c.Request.RawBody != nil {
				body = []byte(*c.Request.RawBody)
			}
			req := httptest.NewRequest(c.Request.Method, c.Request.Path, bytes.NewReader(body))
			if len(body) > 0 {
				req.Header.Set("Content-Type", "application/json")
			}
			if req.Method != "GET" {
				req.Header.Set("Origin", "http://localhost:3000")
				req.Header.Set("X-Requested-With", "XMLHttpRequest")
			}
			for k, v := range c.Request.Headers {
				if v == nil {
					req.Header.Del(k)
				} else {
					req.Header.Set(k, *v)
				}
			}
			if token != "" {
				req.AddCookie(&http.Cookie{Name: "session_token", Value: token})
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != *c.Response.Status {
				t.Fatalf("status %d body %s; want %d", rec.Code, rec.Body.String(), *c.Response.Status)
			}
			for k, v := range c.Response.Headers {
				if rec.Header().Get(k) != v {
					t.Fatalf("header %s=%q want %q", k, rec.Header().Get(k), v)
				}
			}

			if expected, ok := c.Expected["follows"]; ok {
				rows, err := conn.Query(`SELECT id,follower_id,followed_id,state,created_at,accepted_at FROM follows ORDER BY id`)
				if err != nil {
					t.Fatal(err)
				}
				current := []any{}
				for rows.Next() {
					var id, viewer, target int64
					var state, created string
					var accepted sql.NullString
					if err := rows.Scan(&id, &viewer, &target, &state, &created, &accepted); err != nil {
						t.Fatal(err)
					}
					var at any
					if accepted.Valid {
						at = accepted.String
					}
					current = append(current, map[string]any{"id": float64(id), "follower_id": float64(viewer), "followed_id": float64(target), "state": state, "created_at": created, "accepted_at": at})
				}
				err = rows.Err()
				rows.Close()
				if err != nil {
					t.Fatal(err)
				}
				var want any
				if err := json.Unmarshal(expected, &want); err != nil {
					t.Fatal(err)
				}
				normalizeFixture(current, pack.Clock)
				normalizeFixture(want, pack.Clock)
				if !reflect.DeepEqual(current, want) {
					t.Fatalf("postcondition mismatch: %s want %s", mustJSON(current), mustJSON(want))
				}
			}
			if visibility, ok := c.Expected["profile_visibility"]; ok {
				var expected string
				_ = json.Unmarshal(visibility, &expected)
				var got string
				if err := conn.QueryRow(`SELECT profile_visibility FROM users WHERE id=?`, *c.Viewer).Scan(&got); err != nil || got != expected {
					t.Fatalf("privacy postcondition %s want %s err %v", got, expected, err)
				}
			}
			if version, ok := c.Expected["profile_version"]; ok {
				var expected int64
				_ = json.Unmarshal(version, &expected)
				var got int64
				if err := conn.QueryRow(`SELECT profile_version FROM users WHERE id=?`, *c.Viewer).Scan(&got); err != nil || got != expected {
					t.Fatalf("version postcondition %d want %d err %v", got, expected, err)
				}
			}

			if c.Response.BinaryFixture != "" {
				if !bytes.Equal(rec.Body.Bytes(), png) {
					t.Fatal("avatar bytes differ")
				}
				return
			}
			if rec.Code == 204 {
				if rec.Body.Len() != 0 {
					t.Fatal("204 body")
				}
				return
			}
			var got, want any
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(c.Response.Body, &want); err != nil {
				t.Fatal(err)
			}
			normalizeFixture(got, pack.Clock)
			normalizeFixture(want, pack.Clock)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("body mismatch\ngot  %s\nwant %s", mustJSON(got), mustJSON(want))
			}
		})
	}
	if ran < 60 {
		t.Fatalf("only %d B11 fixture cases selected", ran)
	}
}
func normalizeFixture(v any, clock string) {
	switch x := v.(type) {
	case map[string]any:
		if _, ok := x["code"]; ok {
			delete(x, "message")
		}
		for k, item := range x {
			if (k == "created_at" || k == "accepted_at") && item != nil {
				if _, err := time.Parse(time.RFC3339, item.(string)); err != nil {
					panic(err)
				}
				x[k] = clock
			} else {
				normalizeFixture(item, clock)
			}
		}
	case []any:
		for _, item := range x {
			normalizeFixture(item, clock)
		}
	}
}
func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestSocialProfilesValidationOrderAndPrivacyRevocation(t *testing.T) {
	handler, conn := socialAPI(t)
	owner := registerSocialUser(t, handler, "owner@example.com")
	viewer := registerSocialUser(t, handler, "viewer@example.com")
	var ownerID, viewerID int64
	if err := conn.QueryRow(`SELECT id FROM users WHERE email='owner@example.com'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`SELECT id FROM users WHERE email='viewer@example.com'`).Scan(&viewerID); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("PUT", "/api/v1/follows", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertSocialCode(t, rec, 405, "METHOD_NOT_ALLOWED")
	if rec.Header().Get("Allow") != "POST" {
		t.Fatal("missing method allowance")
	}
	changed := socialRequest(t, handler, "PATCH", "/api/v1/users/me/privacy", "application/json", []byte(`{"visibility":"private","expected_version":1}`), owner)
	assertSocialCode(t, changed, 200, "")
	created := socialRequest(t, handler, "POST", "/api/v1/follows", "application/json", []byte(fmt.Sprintf(`{"user_id":%d}`, ownerID)), viewer)
	assertSocialCode(t, created, 201, "")
	var follow struct{ Data struct{ ID int64 } }
	if err := json.Unmarshal(created.Body.Bytes(), &follow); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/v1/users/%d/profile", ownerID)
	teaser := socialRequest(t, handler, "GET", path, "", nil, viewer)
	if strings.Contains(teaser.Body.String(), `"profile"`) {
		t.Fatal("pending profile disclosed")
	}
	accept := socialRequest(t, handler, "PATCH", fmt.Sprintf("/api/v1/follow-requests/%d", follow.Data.ID), "application/json", []byte(`{"decision":"accept"}`), owner)
	assertSocialCode(t, accept, 200, "")
	full := socialRequest(t, handler, "GET", path, "", nil, viewer)
	if !strings.Contains(full.Body.String(), `"email"`) {
		t.Fatal("accepted profile missing")
	}
	removed := socialRequest(t, handler, "DELETE", fmt.Sprintf("/api/v1/follows/%d", follow.Data.ID), "", nil, viewer)
	assertSocialCode(t, removed, 204, "")
	denied := socialRequest(t, handler, "GET", path, "", nil, viewer)
	if strings.Contains(denied.Body.String(), `"email"`) {
		t.Fatal("unfollow retained profile access")
	}
	if _, err := conn.Exec(`UPDATE users SET is_active=0 WHERE id=?`, ownerID); err != nil {
		t.Fatal(err)
	}
	missing := socialRequest(t, handler, "GET", path, "", nil, viewer)
	assertSocialCode(t, missing, 404, "NOT_FOUND")
	if _, err := conn.Exec(`UPDATE sessions SET is_valid=0 WHERE user_id=?`, viewerID); err != nil {
		t.Fatal(err)
	}
	revoked := socialRequest(t, handler, "GET", "/api/v1/users", "", nil, viewer)
	assertSocialCode(t, revoked, 401, "UNAUTHORIZED")
}
