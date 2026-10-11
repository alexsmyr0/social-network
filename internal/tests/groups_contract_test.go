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
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"forum/internal/db"
)

// B18 and B19 replay the whole approved phase-4 pack against the real router and
// SQLite schema: groups, invitations, requests, memberships and group notices
// (B18), and group posts, drafts, comments, reactions, media, feeds, activity,
// navigation and content notices (B19). Nothing is filtered by owner.

type groupRequest struct {
	Method, Path, Encoding string
	Body                   json.RawMessage
	RawBody                *string `json:"raw_body"`
	RawRepeat              struct {
		Value string
		Count int
	} `json:"raw_repeat"`
	Headers map[string]*string
}
type groupResponse struct {
	Status       int
	Headers      map[string]string
	Body         json.RawMessage
	BytesFixture string `json:"bytes_fixture"`
	EmptyBody    bool   `json:"empty_body"`
}
type groupSignal struct {
	Type       string
	Recipients any
}
type groupCase struct {
	Name        string
	Tags        []string
	Viewer      *int64 `json:"viewer_id"`
	Given       map[string]any
	Request     groupRequest
	Response    groupResponse
	ExpectState map[string]map[string]map[string]any `json:"expect_state"`
	Unchanged   bool
	Signals     []groupSignal
}
type groupPack struct {
	Clock     string
	State     map[string]any
	Cases     []groupCase
	Sequences []struct {
		Name  string
		Given map[string]any
		Steps []struct {
			Viewer      int64 `json:"viewer_id"`
			Request     groupRequest
			Response    groupResponse
			ExpectState map[string]map[string]map[string]any `json:"expect_state"`
			Signals     []groupSignal
		}
	}
	Races []struct {
		Name  string
		Given map[string]any
		Ops   map[string]struct {
			Viewer  int64
			Request groupRequest
		}
		Outcomes map[string]struct {
			A, B  []any
			Final map[string]map[string]map[string]any
		}
	}
}

func loadGroupPack(t *testing.T) groupPack {
	t.Helper()
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-4-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack groupPack
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	return pack
}

// mergeGroupState applies a fixture given-patch to the base state: object
// merges recurse, null deletes a record, other values replace.
func mergeGroupState(base, patch map[string]any) map[string]any {
	out := map[string]any{}
	b, _ := json.Marshal(base)
	json.Unmarshal(b, &out)
	var apply func(dst, src map[string]any)
	apply = func(dst, src map[string]any) {
		for k, v := range src {
			if v == nil {
				delete(dst, k)
				continue
			}
			sm, isMap := v.(map[string]any)
			dm, dstMap := dst[k].(map[string]any)
			if isMap && dstMap {
				apply(dm, sm)
			} else {
				dst[k] = v
			}
		}
	}
	apply(out, patch)
	return out
}

func records(state map[string]any, table string) map[string]map[string]any {
	out := map[string]map[string]any{}
	raw, _ := state[table].(map[string]any)
	for id, v := range raw {
		out[id], _ = v.(map[string]any)
	}
	return out
}

func setSequence(t *testing.T, conn *sql.DB, table string, next float64) {
	t.Helper()
	res, err := conn.Exec(`UPDATE sqlite_sequence SET seq=? WHERE name=?`, int64(next)-1, table)
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fixtureExec(t, conn, `INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)`, table, int64(next)-1)
	}
}

// seedGroupFixture inserts the group-owned part of a fixture world. The schema's
// creator-membership trigger is lifted while explicit membership IDs are seeded.
func seedGroupFixture(t *testing.T, conn *sql.DB, state map[string]any, clock string) {
	t.Helper()
	for key, u := range records(state, "users") {
		fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,nickname,profile_visibility,is_active,display_name_search)VALUES(?,?,?,'hash','Fixture','Person','2000-01-01',?,?,?,?)`, key, "fixture"+key, "fixture"+key+"@test.local", u["display_name"], u["visibility"], u["is_active"], strings.ToLower(u["display_name"].(string)))
	}
	for key, f := range records(state, "follows") {
		var accepted any
		if f["state"] == "accepted" {
			accepted = clock
		}
		fixtureExec(t, conn, `INSERT INTO follows(id,follower_id,followed_id,state,accepted_at)VALUES(?,?,?,?,?)`, key, f["follower_id"], f["followed_id"], f["state"], accepted)
	}
	var trigger string
	if err := conn.QueryRow(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='group_creator_membership'`).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	fixtureExec(t, conn, `DROP TRIGGER group_creator_membership`)
	for key, g := range records(state, "groups") {
		fixtureExec(t, conn, `INSERT INTO groups(id,creator_id,title,description,title_search,created_at)VALUES(?,?,?,?,?,?)`, key, g["creator_id"], g["title"], g["description"], strings.ToLower(g["title"].(string)), g["created_at"])
	}
	fixtureExec(t, conn, trigger)
	for key, m := range records(state, "group_memberships") {
		fixtureExec(t, conn, `INSERT INTO group_memberships(id,group_id,user_id,role,joined_at)VALUES(?,?,?,?,?)`, key, m["group_id"], m["user_id"], m["role"], m["joined_at"])
	}
	for key, i := range records(state, "group_invitations") {
		fixtureExec(t, conn, `INSERT INTO group_invitations(id,group_id,inviter_id,invitee_id,created_at)VALUES(?,?,?,?,?)`, key, i["group_id"], i["inviter_id"], i["invitee_id"], i["created_at"])
	}
	for key, r := range records(state, "group_join_requests") {
		fixtureExec(t, conn, `INSERT INTO group_join_requests(id,group_id,requester_id,created_at)VALUES(?,?,?,?)`, key, r["group_id"], r["requester_id"], r["created_at"])
	}
	seedGroupContent(t, conn, state)
	for key, n := range records(state, "notifications") {
		switch n["type"] {
		case "group_invitation", "group_join_request":
			fixtureExec(t, conn, `INSERT INTO notifications(id,recipient_id,actor_id,type,group_id,group_entry_id,group_state,is_read,created_at)VALUES(?,?,?,?,?,?,?,?,?)`, key, n["recipient_id"], n["actor_id"], n["type"], n["group_id"], n["entry_id"], n["state"], n["is_read"], n["created_at"])
		default:
			fixtureExec(t, conn, `INSERT INTO notifications(id,recipient_id,actor_id,type,post_id,comment_id,is_read,created_at)VALUES(?,?,?,?,?,?,?,?)`, key, n["recipient_id"], n["actor_id"], n["type"], n["post_id"], n["comment_id"], n["is_read"], n["created_at"])
		}
	}
	next, _ := state["next_ids"].(map[string]any)
	for key, table := range map[string]string{"groups": "groups", "group_memberships": "group_memberships", "group_invitations": "group_invitations", "group_join_requests": "group_join_requests", "notifications": "notifications", "posts": "posts", "comments": "comments", "reactions": "reactions", "media": "media_objects"} {
		if v, ok := next[key].(float64); ok {
			setSequence(t, conn, table, v)
		}
	}
}

// seedGroupContent inserts the content part of a fixture world: categories,
// media bytes, posts (group posts keep the inert stored audience), comments and
// reactions. The membership trigger is lifted while posts whose authors have
// since left their group are seeded, exactly as the creator trigger is above.
func seedGroupContent(t *testing.T, conn *sql.DB, state map[string]any) {
	t.Helper()
	if categories := records(state, "categories"); len(categories) > 0 {
		keep := []any{}
		for key := range categories {
			keep = append(keep, key)
		}
		fixtureExec(t, conn, `DELETE FROM categories WHERE id NOT IN (`+strings.TrimSuffix(strings.Repeat("?,", len(keep)), ",")+`)`, keep...)
		for key, c := range categories {
			fixtureExec(t, conn, `UPDATE categories SET name=?,created_at=? WHERE id=?`, c["name"], c["created_at"], key)
		}
	}
	if media := records(state, "media"); len(media) > 0 {
		root, err := db.AvatarRoot(conn)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "objects"), 0700); err != nil {
			t.Fatal(err)
		}
		for key, m := range media {
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
	}
	var trigger string
	if err := conn.QueryRow(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='group_post_insert'`).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	fixtureExec(t, conn, `DROP TRIGGER group_post_insert`)
	for key, p := range records(state, "posts") {
		audience, group := p["audience"], p["group_id"]
		if group != nil {
			audience = "public"
		}
		fixtureExec(t, conn, `INSERT INTO posts(id,author_id,group_id,title,body,image_url,status,audience,content_version,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,?)`, key, p["author_id"], group, p["title"], p["body"], p["image_url"], p["status"], audience, p["version"], p["created_at"], p["updated_at"])
		categories, _ := p["categories"].([]any)
		for _, v := range categories {
			fixtureExec(t, conn, `INSERT INTO post_categories VALUES(?,?)`, key, v)
		}
		selected, _ := p["selected_follow_ids"].([]any)
		for _, follow := range selected {
			fixtureExec(t, conn, `INSERT INTO post_selected_followers VALUES(?,?)`, key, follow)
		}
	}
	fixtureExec(t, conn, trigger)
	comments := records(state, "comments")
	keys := make([]string, 0, len(comments))
	for key := range comments {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { a, _ := strconv.Atoi(keys[i]); b, _ := strconv.Atoi(keys[j]); return a < b })
	for _, key := range keys {
		c := comments[key]
		fixtureExec(t, conn, `INSERT INTO comments(id,post_id,user_id,parent_comment_id,body,image_url,content_version,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)`, key, c["post_id"], c["user_id"], c["parent_comment_id"], c["body"], c["image_url"], c["version"], c["created_at"], c["updated_at"])
	}
	for key, r := range records(state, "reactions") {
		fixtureExec(t, conn, `INSERT INTO reactions(id,user_id,post_id,comment_id,value)VALUES(?,?,?,?,?)`, key, r["user_id"], r["post_id"], r["comment_id"], r["value"])
	}
}

func groupFixtureRequest(c groupRequest) *http.Request {
	var body bytes.Buffer
	switch {
	case c.RawBody != nil:
		body.WriteString(*c.RawBody)
	case c.RawRepeat.Count > 0:
		body.WriteString(strings.Repeat(c.RawRepeat.Value, c.RawRepeat.Count))
	default:
		body.Write(c.Body)
	}
	r := httptest.NewRequest(c.Method, c.Path, &body)
	if body.Len() > 0 || r.Method != http.MethodGet {
		r.Header.Set("Content-Type", "application/json")
	}
	if r.Method != http.MethodGet {
		r.Header.Set("Origin", "http://localhost:3000")
		r.Header.Set("X-Requested-With", "XMLHttpRequest")
	}
	for k, v := range c.Headers {
		if v == nil {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, *v)
		}
	}
	return r
}

type groupSignalLog struct {
	mu   sync.Mutex
	list []string
}

func (s *groupSignalLog) invalidate(ids []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(ids) == 0 {
		s.list = append(s.list, "social.invalidate:all_authenticated")
		return
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = strconv.FormatInt(id, 10)
	}
	s.list = append(s.list, "social.invalidate:"+strings.Join(parts, ","))
}
func (s *groupSignalLog) notify(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = append(s.list, fmt.Sprintf("notification.new:%d", id))
}
func (s *groupSignalLog) sorted() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]string{}, s.list...)
	sort.Strings(out)
	return out
}
func captureGroupSignals(t *testing.T) *groupSignalLog {
	log := &groupSignalLog{}
	db.SetSocialInvalidationHook(log.invalidate)
	db.SetNotificationHook(log.notify)
	t.Cleanup(func() {
		db.SetSocialInvalidationHook(nil)
		db.SetNotificationHook(nil)
	})
	return log
}
func wantSignals(signals []groupSignal) []string {
	out := []string{}
	for _, s := range signals {
		switch r := s.Recipients.(type) {
		case string:
			out = append(out, s.Type+":"+r)
		case []any:
			parts := make([]string, len(r))
			for i, v := range r {
				parts[i] = strconv.FormatInt(int64(v.(float64)), 10)
			}
			out = append(out, s.Type+":"+strings.Join(parts, ","))
		}
	}
	sort.Strings(out)
	return out
}

func groupStateSnapshot(t *testing.T, conn *sql.DB) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, table := range []string{"groups", "group_memberships", "group_invitations", "group_join_requests", "notifications", "posts", "comments", "reactions", "media_objects"} {
		rows, err := conn.Query(`SELECT * FROM ` + table + ` ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		var b strings.Builder
		for rows.Next() {
			values := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range values {
				ptrs[i] = &values[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintln(&b, values...)
		}
		rows.Close()
		out[table] = b.String()
		var seq sql.NullInt64
		conn.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name=?`, table).Scan(&seq)
		out[table+".seq"] = fmt.Sprint(seq.Int64)
	}
	return out
}

var groupOwnedTables = map[string]bool{
	"groups": true, "group_memberships": true, "group_invitations": true, "group_join_requests": true, "notifications": true,
	"posts": true, "comments": true, "reactions": true,
}

var groupColumn = map[string]map[string]string{
	"notifications": {"entry_id": "group_entry_id", "state": "group_state"},
	"posts":         {"version": "content_version", "audience": "CASE WHEN group_id IS NULL THEN audience ELSE 'group' END"},
	"comments":      {"version": "content_version"},
}

// assertGroupState checks the deep-subset postconditions. Timestamps equal to the
// fixture clock identify rows created by the request and are not comparable.
func assertGroupState(t *testing.T, conn *sql.DB, expect map[string]map[string]map[string]any, clock string) {
	t.Helper()
	for table, rows := range expect {
		if !groupOwnedTables[table] {
			continue // content tables belong to B19
		}
		for id, want := range rows {
			var exists bool
			if err := conn.QueryRow(`SELECT EXISTS(SELECT 1 FROM `+table+` WHERE id=?)`, id).Scan(&exists); err != nil {
				t.Fatal(table, err)
			}
			if want == nil {
				if exists {
					t.Errorf("%s.%s should be absent", table, id)
				}
				continue
			}
			if !exists {
				t.Errorf("%s.%s missing", table, id)
				continue
			}
			for field, expected := range want {
				if s, ok := expected.(string); ok && s == clock {
					continue
				}
				if table == "posts" && field == "categories" {
					ids := []any{}
					rows, err := conn.Query(`SELECT category_id FROM post_categories WHERE post_id=? ORDER BY category_id`, id)
					if err != nil {
						t.Fatal(err)
					}
					for rows.Next() {
						var c int64
						rows.Scan(&c)
						ids = append(ids, float64(c))
					}
					rows.Close()
					if want, _ := expected.([]any); !reflect.DeepEqual(ids, append([]any{}, want...)) {
						t.Errorf("posts.%s.categories = %v want %v", id, ids, expected)
					}
					continue
				}
				column := field
				if mapped, ok := groupColumn[table][field]; ok {
					column = mapped
				}
				var got any
				if err := conn.QueryRow(`SELECT `+column+` FROM `+table+` WHERE id=?`, id).Scan(&got); err != nil {
					t.Fatal(table, field, err)
				}
				switch e := expected.(type) {
				case bool:
					expected = int64(0)
					if e {
						expected = int64(1)
					}
				case float64:
					expected = int64(e)
				}
				if b, ok := got.([]byte); ok {
					got = string(b)
				}
				if !reflect.DeepEqual(got, expected) {
					t.Errorf("%s.%s.%s = %#v want %#v", table, id, field, got, expected)
				}
			}
		}
	}
}

func normalizeGroupResponse(got, want any, mutation bool) {
	gm, gok := got.(map[string]any)
	wm, wok := want.(map[string]any)
	if gok && wok {
		if _, isError := gm["code"]; isError {
			delete(gm, "message")
			delete(wm, "message")
		}
		for k, v := range gm {
			if mutation && (k == "created_at" || k == "joined_at" || k == "updated_at") {
				gm[k] = wm[k]
			} else {
				normalizeGroupResponse(v, wm[k], mutation)
			}
		}
	} else if ga, ok := got.([]any); ok {
		if wa, ok := want.([]any); ok {
			for i := range ga {
				if i < len(wa) {
					normalizeGroupResponse(ga[i], wa[i], mutation)
				}
			}
		}
	}
}

func runGroupRequest(t *testing.T, handler http.Handler, conn *sql.DB, viewer *int64, request groupRequest) *httptest.ResponseRecorder {
	t.Helper()
	r := groupFixtureRequest(request)
	if viewer != nil {
		token := fmt.Sprintf("b18-fixture-%d", *viewer)
		conn.Exec(`INSERT OR IGNORE INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, *viewer, token)
		r.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	return response
}

func assertGroupResponse(t *testing.T, response *httptest.ResponseRecorder, want groupResponse, mutation bool) {
	t.Helper()
	if response.Code != want.Status {
		t.Fatalf("status %d %s; want %d", response.Code, response.Body.String(), want.Status)
	}
	for k, v := range want.Headers {
		if response.Header().Get(k) != v {
			t.Errorf("header %s=%q want %q", k, response.Header().Get(k), v)
		}
	}
	if want.BytesFixture != "" {
		expected, err := os.ReadFile(filepath.Join("../..", want.BytesFixture))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(response.Body.Bytes(), expected) {
			t.Errorf("media bytes differ from %s (%d vs %d bytes)", want.BytesFixture, response.Body.Len(), len(expected))
		}
		return
	}
	if len(want.Body) == 0 {
		if (want.Status == http.StatusNoContent || want.EmptyBody) && response.Body.Len() != 0 {
			t.Errorf("empty response carried a body")
		}
		return
	}
	var got, expected any
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(want.Body, &expected)
	normalizeGroupResponse(got, expected, mutation)
	if !reflect.DeepEqual(got, expected) {
		a, _ := json.Marshal(got)
		b, _ := json.Marshal(expected)
		t.Fatalf("response %s\nwant     %s", a, b)
	}
}

func TestGroupContractFixtures(t *testing.T) {
	pack := loadGroupPack(t)
	ran := 0
	for _, c := range pack.Cases {
		ran++
		t.Run(c.Name, func(t *testing.T) {
			handler, conn := socialAPI(t)
			seedGroupFixture(t, conn, mergeGroupState(pack.State, c.Given), pack.Clock)
			before := groupStateSnapshot(t, conn)
			signals := captureGroupSignals(t)
			response := runGroupRequest(t, handler, conn, c.Viewer, c.Request)
			assertGroupResponse(t, response, c.Response, c.Request.Method != "GET" && response.Code < 300)
			assertGroupState(t, conn, c.ExpectState, pack.Clock)
			if got, want := signals.sorted(), wantSignals(c.Signals); !reflect.DeepEqual(got, want) {
				t.Fatalf("signals %v want %v", got, want)
			}
			if c.Unchanged || response.Code >= 400 {
				if after := groupStateSnapshot(t, conn); !reflect.DeepEqual(before, after) {
					t.Fatalf("denied or no-op request changed state\nbefore %v\nafter  %v", before, after)
				}
			}
		})
	}
	if ran != len(pack.Cases) || ran != 389 {
		t.Fatalf("replayed %d of %d pack cases, want all 389", ran, len(pack.Cases))
	}
	t.Logf("%d B18/B19 fixtures passed", ran)
}

func TestGroupContractSequences(t *testing.T) {
	pack := loadGroupPack(t)
	for _, seq := range pack.Sequences {
		t.Run(seq.Name, func(t *testing.T) {
			handler, conn := socialAPI(t)
			seedGroupFixture(t, conn, mergeGroupState(pack.State, seq.Given), pack.Clock)
			signals := captureGroupSignals(t)
			for i, step := range seq.Steps {
				signals.mu.Lock()
				signals.list = nil
				signals.mu.Unlock()
				viewer := step.Viewer
				response := runGroupRequest(t, handler, conn, &viewer, step.Request)
				assertGroupResponse(t, response, step.Response, step.Request.Method != "GET" && response.Code < 300)
				assertGroupState(t, conn, step.ExpectState, pack.Clock)
				if step.Request.Method != "GET" {
					if got, want := signals.sorted(), wantSignals(step.Signals); !reflect.DeepEqual(got, want) {
						t.Fatalf("step %d signals %v want %v", i+1, got, want)
					}
				}
			}
		})
	}
}

// TestGroupContractRacesBothOrders replays each race sequentially in both orders.
func TestGroupContractRacesBothOrders(t *testing.T) {
	pack := loadGroupPack(t)
	for _, race := range pack.Races {
		for order, outcome := range race.Outcomes {
			t.Run(race.Name+"/"+order, func(t *testing.T) {
				handler, conn := socialAPI(t)
				seedGroupFixture(t, conn, mergeGroupState(pack.State, race.Given), pack.Clock)
				captureGroupSignals(t)
				want := map[string][]any{"A": outcome.A, "B": outcome.B}
				for _, label := range strings.Split(order, ",") {
					op := race.Ops[label]
					viewer := op.Viewer
					response := runGroupRequest(t, handler, conn, &viewer, op.Request)
					assertRaceStatus(t, response, want[label], label)
				}
				assertGroupState(t, conn, outcome.Final, pack.Clock)
			})
		}
	}
}

func assertRaceStatus(t *testing.T, response *httptest.ResponseRecorder, want []any, label string) {
	t.Helper()
	if response.Code != int(want[0].(float64)) {
		t.Fatalf("%s status %d %s; want %v", label, response.Code, response.Body.String(), want[0])
	}
	if want[1] != nil {
		var body struct{ Error struct{ Code string } }
		json.Unmarshal(response.Body.Bytes(), &body)
		if body.Error.Code != want[1] {
			t.Fatalf("%s code %q want %v", label, body.Error.Code, want[1])
		}
	}
}
