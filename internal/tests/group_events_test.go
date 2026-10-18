package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"forum/internal/db"
)

type eventFixtureRequest struct {
	Actor        *int64
	Method, Path string
	JSON         json.RawMessage `json:"json"`
	Origin       *string
}
type eventFixtureExpect struct {
	Status    int
	Body      json.RawMessage
	Signals   []groupSignal
	State     map[string]any
	Unchanged bool
}
type eventFixtureCase struct {
	ID      string
	Given   map[string]any
	Request eventFixtureRequest
	Expect  eventFixtureExpect
}
type eventFixturePack struct {
	Clock string
	State map[string]any
	Cases []eventFixtureCase `json:"http_cases"`
}

func loadEventPack(t *testing.T) eventFixturePack {
	t.Helper()
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-5-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var p eventFixturePack
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	return p
}
func seedEventFixture(t *testing.T, conn *sql.DB, state map[string]any, clock string) {
	t.Helper()
	for key, u := range records(state, "users") {
		fixtureExec(t, conn, `INSERT INTO users(id,username,email,password_hash,first_name,last_name,date_of_birth,nickname,profile_visibility,is_active,display_name_search)VALUES(?,?,?,'hash','Fixture','Person','2000-01-01',?,?,?,?)`, key, "fixture"+key, "fixture"+key+"@test.local", u["display_name"], u["visibility"], u["active"], strings.ToLower(u["display_name"].(string)))
		fixtureExec(t, conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, key, "b18-fixture-"+key)
	}
	for key, raw := range state["follows"].(map[string]any) {
		if raw == "none" {
			continue
		}
		p := strings.Split(key, ":")
		var accepted any
		if raw == "accepted" {
			accepted = clock
		}
		fixtureExec(t, conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(?,?,?,?)`, p[0], p[1], raw, accepted)
	}
	fixtureExec(t, conn, `DROP TRIGGER group_creator_membership`)
	for key, g := range records(state, "groups") {
		fixtureExec(t, conn, `INSERT INTO groups(id,creator_id,title,description,title_search,created_at)VALUES(?,?,?,'Description',?,?)`, key, g["creator_id"], g["title"], strings.ToLower(g["title"].(string)), clock)
	}
	for key, m := range records(state, "memberships") {
		role := "member"
		g := records(state, "groups")[fmt.Sprint(int(m["group_id"].(float64)))]
		if m["user_id"] == g["creator_id"] {
			role = "creator"
		}
		fixtureExec(t, conn, `INSERT INTO group_memberships(id,group_id,user_id,role,joined_at)VALUES(?,?,?,?,?)`, key, m["group_id"], m["user_id"], role, clock)
	}
	for key, i := range records(state, "invitations") {
		fixtureExec(t, conn, `INSERT INTO group_invitations(id,group_id,inviter_id,invitee_id)VALUES(?,?,1,?)`, key, i["group_id"], i["user_id"])
	}
	for key, i := range records(state, "requests") {
		fixtureExec(t, conn, `INSERT INTO group_join_requests(id,group_id,requester_id)VALUES(?,?,?)`, key, i["group_id"], i["user_id"])
	}
	for key, e := range records(state, "events") {
		fixtureExec(t, conn, `INSERT INTO group_events(id,group_id,creator_id,title,description,starts_at,created_at)VALUES(?,?,?,?,?,?,?)`, key, e["group_id"], e["creator_id"], e["title"], e["description"], e["starts_at"], e["created_at"])
	}
	for key, r := range records(state, "responses") {
		p := strings.Split(key, ":")
		fixtureExec(t, conn, `INSERT INTO group_event_responses(event_id,user_id,membership_id,choice,version)VALUES(?,?,?,?,?)`, p[0], r["user_id"], p[1], r["choice"], r["version"])
	}
	for key, n := range records(state, "notices") {
		fixtureExec(t, conn, `INSERT INTO notifications(id,recipient_id,actor_id,type,group_id,event_id,is_read,created_at)VALUES(?,?,?,'group_event',10,?,?,?)`, key, n["recipient_id"], n["actor_id"], n["event_id"], n["is_read"], clock)
	}
	next := state["next_ids"].(map[string]any)
	for k, table := range map[string]string{"event": "group_events", "notice": "notifications", "membership": "group_memberships"} {
		setSequence(t, conn, table, next[k].(float64))
	}
}
func eventSnapshot(t *testing.T, conn *sql.DB) map[string]string {
	t.Helper()
	out := groupStateSnapshot(t, conn)
	for _, q := range []struct{ name, sql string }{{"events", "SELECT * FROM group_events ORDER BY id"}, {"responses", "SELECT * FROM group_event_responses ORDER BY event_id,membership_id"}, {"sequences", "SELECT * FROM sqlite_sequence ORDER BY name"}} {
		rows, err := conn.Query(q.sql)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		var b strings.Builder
		for rows.Next() {
			v := make([]any, len(cols))
			ptr := make([]any, len(cols))
			for i := range v {
				ptr[i] = &v[i]
			}
			if err := rows.Scan(ptr...); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintln(&b, v...)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		rows.Close()
		out[q.name] = b.String()
	}
	return out
}
func runEventFixture(t *testing.T, handler http.Handler, conn *sql.DB, r eventFixtureRequest) *httptest.ResponseRecorder {
	t.Helper()
	request := groupRequest{Method: r.Method, Path: r.Path, Body: r.JSON}
	if r.Origin != nil {
		request.Headers = map[string]*string{"Origin": r.Origin}
	}
	req := groupFixtureRequest(request)
	if r.Actor != nil {
		req.AddCookie(&http.Cookie{Name: "session_token", Value: fmt.Sprintf("b18-fixture-%d", *r.Actor)})
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// Normalize only server-created times and inherited error wording. New Phase 5
// errors and validation messages are pinned separately below.
func TestGroupEventContractFixtures(t *testing.T) {
	pack := loadEventPack(t)
	ran := 0
	for _, c := range pack.Cases {
		if !strings.Contains(c.Request.Path, "/events") && !strings.Contains(c.Request.Path, "/notifications") {
			continue
		}
		ran++
		t.Run(c.ID, func(t *testing.T) {
			h, conn := socialAPI(t)
			seedEventFixture(t, conn, mergeGroupState(pack.State, c.Given), pack.Clock)
			before := eventSnapshot(t, conn)
			signals := captureGroupSignals(t)
			rec := runEventFixture(t, h, conn, c.Request)
			if strings.Contains(c.Request.Path, "/events") && (rec.Code == 409 || rec.Code == 404 || rec.Code == 400 && bytes.Contains(c.Expect.Body, []byte("VALIDATION_ERROR"))) {
				var actual, expected any
				if err := json.Unmarshal(rec.Body.Bytes(), &actual); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(c.Expect.Body, &expected); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("pinned Phase 5 error %s want %s", rec.Body, c.Expect.Body)
				}
			}
			body := c.Expect.Body
			if c.Expect.Status == 204 {
				body = nil
			}
			assertGroupResponse(t, rec, groupResponse{Status: c.Expect.Status, Body: body}, c.Request.Method != "GET" && rec.Code < 300)
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
			if got, want := signals.sorted(), wantSignals(c.Expect.Signals); !reflect.DeepEqual(got, want) {
				t.Fatalf("signals %v want %v", got, want)
			}
			if c.Expect.Unchanged || rec.Code >= 400 {
				if !reflect.DeepEqual(before, eventSnapshot(t, conn)) {
					t.Fatal("denied/no-op request mutated persisted state")
				}
			}
			for key, v := range c.Expect.State {
				switch key {
				case "events_count":
					var n int
					conn.QueryRow(`SELECT COUNT(*) FROM group_events`).Scan(&n)
					if n != int(v.(float64)) {
						t.Fatalf("events %d", n)
					}
				case "notice_recipients_902":
					rows, err := conn.Query(`SELECT recipient_id FROM notifications WHERE event_id=902 ORDER BY recipient_id`)
					if err != nil {
						t.Fatal(err)
					}
					got := []any{}
					for rows.Next() {
						var n int64
						rows.Scan(&n)
						got = append(got, float64(n))
					}
					rows.Close()
					if !reflect.DeepEqual(got, v) {
						t.Fatalf("recipients %v want %v", got, v)
					}
				case "notice_unread":
					visible, err := db.ListSocialNotifications(context.Background(), conn, *c.Request.Actor, 1, 20)
					if err != nil {
						t.Fatal(err)
					}
					if visible.UnreadCount != int(v.(float64)) {
						t.Fatalf("visible unread %d want %v", visible.UnreadCount, v)
					}
				default:
					t.Fatalf("unchecked fixture postcondition %s", key)
				}
			}
		})
	}
	if ran != 85 {
		t.Fatalf("ran %d want all 85 B21 fixtures", ran)
	}
}

func eventRequest(t *testing.T, h http.Handler, conn *sql.DB, actor int64, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	return runEventFixture(t, h, conn, eventFixtureRequest{Actor: &actor, Method: method, Path: path, JSON: json.RawMessage(body)})
}
func eventData(t *testing.T, rec *httptest.ResponseRecorder, want int) db.GroupEvent {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var out struct{ Data db.GroupEvent }
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Data
}
func TestGroupEventStrictValidationAndMethods(t *testing.T) {
	pack := loadEventPack(t)
	h, conn := socialAPI(t)
	seedEventFixture(t, conn, pack.State, pack.Clock)
	base := `{"membership_id":102,"title":"New","description":"Games","starts_at":"2026-10-16T18:00:00Z"}`
	cases := []struct {
		name, body  string
		status      int
		field, code string
	}{
		{"duplicate", strings.Replace(base, `"title":"New"`, `"title":"New","title":"Again"`, 1), 400, "", "BAD_REQUEST"},
		{"unknown", strings.Replace(base, `"title"`, `"unknown"`, 1), 400, "", "BAD_REQUEST"},
		{"null", "null", 400, "", "BAD_REQUEST"}, {"trailing", base + " {}", 400, "", "BAD_REQUEST"},
		{"null-title", strings.Replace(base, `"New"`, `null`, 1), 400, "", "BAD_REQUEST"},
		{"float-id", strings.Replace(base, `102`, `102.0`, 1), 400, "", "BAD_REQUEST"},
		{"huge-id", strings.Replace(base, `102`, `9007199254740992`, 1), 400, "membership_id", "VALIDATION_ERROR"},
		{"surrogate", strings.Replace(base, `New`, `\ud800`, 1), 400, "", "BAD_REQUEST"},
		{"low-surrogate", strings.Replace(base, `New`, `\udc00`, 1), 400, "", "BAD_REQUEST"},
		{"fraction-time", strings.Replace(base, `18:00:00Z`, `18:00:00.0Z`, 1), 400, "starts_at", "VALIDATION_ERROR"},
		{"invalid-calendar", strings.Replace(base, `10-16`, `02-30`, 1), 400, "starts_at", "VALIDATION_ERROR"},
		{"offset-hour", strings.Replace(base, `Z"`, `+24:00"`, 1), 400, "starts_at", "VALIDATION_ERROR"},
		{"offset-minute", strings.Replace(base, `Z"`, `+01:60"`, 1), 400, "starts_at", "VALIDATION_ERROR"},
		{"utc-year-zero", strings.Replace(base, `2026-10-16T18:00:00Z`, `0001-01-01T00:00:00+01:00`, 1), 400, "starts_at", "VALIDATION_ERROR"},
		{"oversize", strings.Repeat("x", 16385), 413, "", "PAYLOAD_TOO_LARGE"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := eventSnapshot(t, conn)
			r := eventRequest(t, h, conn, 2, "POST", "/api/v1/groups/10/events", c.body)
			if r.Code != c.status {
				t.Fatalf("status %d: %s", r.Code, r.Body)
			}
			var out struct {
				Error struct {
					Code, Message string
					Fields        map[string]string
				}
			}
			json.Unmarshal(r.Body.Bytes(), &out)
			if out.Error.Code != c.code {
				t.Fatalf("error %s", r.Body)
			}
			if c.field != "" && (out.Error.Fields[c.field] == "" || out.Error.Message != "Validation failed") {
				t.Fatal(r.Body)
			}
			if !reflect.DeepEqual(before, eventSnapshot(t, conn)) {
				t.Fatal("invalid input changed state")
			}
		})
	}
	// Exact method lists precede write-origin and authentication checks.
	for path, allow := range map[string]string{"/groups/10/events": "GET, POST", "/groups/10/events/901": "GET", "/groups/10/events/901/responses": "GET", "/groups/10/events/901/response": "PUT"} {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest("DELETE", "/api/v1"+path, nil))
		if r.Code != 405 || r.Header().Get("Allow") != allow {
			t.Fatalf("%s: %d Allow %s", path, r.Code, r.Header().Get("Allow"))
		}
	}
	for _, q := range []string{"?unknown=1", "?page=1&page=2", "?per_page=0"} {
		r := eventRequest(t, h, conn, 2, "GET", "/api/v1/groups/10/events"+q, "")
		if r.Code != 400 {
			t.Fatal(r.Code, r.Body)
		}
	}
	// Unicode bounds, valid surrogate pair, multiline normalization and past dates.
	valid := strings.Replace(base, `New`, `  \ud83d\udc4b  `, 1)
	valid = strings.Replace(valid, `Games`, `  a\r\nb\t  `, 1)
	valid = strings.Replace(valid, `2026-10-16`, `2000-01-01`, 1)
	e := eventData(t, eventRequest(t, h, conn, 2, "POST", "/api/v1/groups/10/events", valid), 201)
	if e.Title != "👋" || e.Description != "a\nb" || e.ViewerResponse != nil {
		t.Fatalf("event %#v", e)
	}
	// Per-route guards preserve session and CSRF precedence over malformed input.
	r := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/v1/groups/10/events", strings.NewReader("bad"))
	h.ServeHTTP(r, req)
	if r.Code != 403 {
		t.Fatal(r.Code)
	}
	req = groupFixtureRequest(groupRequest{Method: "POST", Path: "/api/v1/groups/10/events", Body: json.RawMessage("bad")})
	r = httptest.NewRecorder()
	h.ServeHTTP(r, req)
	if r.Code != 401 {
		t.Fatal(r.Code)
	}
}

func TestGroupEventMembershipLifecycleAndNoticeRecovery(t *testing.T) {
	pack := loadEventPack(t)
	h, conn := socialAPI(t)
	seedEventFixture(t, conn, pack.State, pack.Clock)
	e := eventData(t, eventRequest(t, h, conn, 1, "POST", "/api/v1/groups/10/events", `{"membership_id":101,"title":"New","description":"Games","starts_at":"2026-10-16T18:00:00Z"}`), 201)
	if e.ID != 902 {
		t.Fatal(e.ID)
	}
	// Later joiner receives history but no retroactive notice.
	fixtureExec(t, conn, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(10,3,'member')`)
	n, err := db.ListSocialNotifications(context.Background(), conn, 3, 1, 20)
	if err != nil || n.UnreadCount != 0 {
		t.Fatal(n, err)
	}
	e, err = db.RespondGroupEvent(context.Background(), conn, 2, 10, 902, 102, 0, "going")
	if err != nil || e.Counts.Going != 1 {
		t.Fatal(e, err)
	}
	if err := db.RemoveGroupMembership(context.Background(), conn, 1, 102); err != nil {
		t.Fatal(err)
	}
	e, err = db.GetGroupEvent(context.Background(), conn, 1, 10, 902)
	if err != nil || e.Counts.Going != 0 {
		t.Fatal(e, err)
	}
	n, err = db.ListSocialNotifications(context.Background(), conn, 2, 1, 20)
	if err != nil || n.Total != 0 || n.UnreadCount != 0 {
		t.Fatal(n, err)
	}
	if err := db.MarkSocialNotificationsRead(context.Background(), conn, 2, 0); err != nil {
		t.Fatal(err)
	}
	if err := db.MarkSocialNotificationsRead(context.Background(), conn, 2, 1002); err != db.ErrNotFound {
		t.Fatal(err)
	}
	fixtureExec(t, conn, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(10,2,'member')`)
	e, err = db.GetGroupEvent(context.Background(), conn, 2, 10, 902)
	if err != nil || e.ViewerResponse != nil || e.Counts.Going != 0 {
		t.Fatal(e, err)
	}
	n, err = db.ListSocialNotifications(context.Background(), conn, 2, 1, 20)
	if err != nil || n.UnreadCount != 1 {
		t.Fatal(n, err)
	}
	r := eventRequest(t, h, conn, 2, "PUT", "/api/v1/groups/10/events/902/response", `{"membership_id":102,"choice":"going","expected_version":0}`)
	if r.Code != 409 || !strings.Contains(r.Body.String(), "Membership changed; refresh before acting") {
		t.Fatal(r.Code, r.Body)
	}
	var current int64
	conn.QueryRow(`SELECT id FROM group_memberships WHERE group_id=10 AND user_id=2`).Scan(&current)
	e, err = db.RespondGroupEvent(context.Background(), conn, 2, 10, 902, current, 0, "not_going")
	if err != nil || e.ViewerResponse.Version != 1 {
		t.Fatal(e, err)
	}
	// Inactive contributors retain event attribution but do not count as respondents.
	fixtureExec(t, conn, `UPDATE users SET is_active=0 WHERE id=8`)
	e, err = db.GetGroupEvent(context.Background(), conn, 1, 10, 901)
	if err != nil || e.Creator.DisplayName != "Unavailable account" {
		t.Fatal(e, err)
	}
	fixtureExec(t, conn, `UPDATE users SET is_active=0 WHERE id=2`)
	e, err = db.GetGroupEvent(context.Background(), conn, 1, 10, 902)
	if err != nil || e.Counts.NotGoing != 0 {
		t.Fatal(e, err)
	}
}

func TestGroupEventSocketDeliveryAndMissedSignalRecovery(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadEventPack(t)
	h, conn, hub := socialAPIWithHub(t)
	seedEventFixture(t, conn, pack.State, pack.Clock)
	wireSocialSocketHooks(t, hub)
	srv := httptest.NewServer(h)
	defer srv.Close()
	owner := openSocialSocket(t, srv, "b18-fixture-1")
	member := openSocialSocket(t, srv, "b18-fixture-2")
	outsider := openSocialSocket(t, srv, "b18-fixture-5")
	fixtureExec(t, conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(2,'second-member','','')`)
	memberSecond := openSocialSocket(t, srv, "second-member")
	// Hook verifies notice and event are visible on another connection before send.
	db.SetNotificationHook(func(recipient int64) {
		var n int
		if err := conn.QueryRow(`SELECT COUNT(*) FROM notifications n JOIN group_events e ON e.id=n.event_id WHERE n.recipient_id=? AND e.id=902`, recipient).Scan(&n); err != nil || n != 1 {
			t.Errorf("notice signal before commit: %d %v", n, err)
		}
		hub.NotifyNotification(recipient)
	})
	e := eventData(t, eventRequest(t, h, conn, 1, "POST", "/api/v1/groups/10/events", `{"membership_id":101,"title":"New","description":"Games","starts_at":"2026-10-16T18:00:00Z"}`), 201)
	owner.expect(t, "social.invalidate")
	member.expect(t, "notification.new", "social.invalidate")
	memberSecond.expect(t, "notification.new", "social.invalidate")
	outsider.silent(t)
	response := eventRequest(t, h, conn, 2, "PUT", "/api/v1/groups/10/events/902/response", `{"membership_id":102,"choice":"going","expected_version":0}`)
	eventData(t, response, 200)
	owner.expect(t, "social.invalidate")
	member.expect(t, "social.invalidate")
	memberSecond.expect(t, "social.invalidate")
	outsider.silent(t)
	fixtureExec(t, conn, `CREATE TRIGGER fail_event_notice BEFORE INSERT ON notifications WHEN NEW.type='group_event' BEGIN SELECT RAISE(ABORT,'injected');END`)
	response = eventRequest(t, h, conn, 1, "POST", "/api/v1/groups/10/events", `{"membership_id":101,"title":"Failed","description":"Games","starts_at":"2026-10-16T18:00:00Z"}`)
	if response.Code != 500 {
		t.Fatal(response.Code, response.Body)
	}
	owner.silent(t)
	member.silent(t)
	memberSecond.silent(t)
	outsider.silent(t)
	fixtureExec(t, conn, `DROP TRIGGER fail_event_notice`)
	// Dropped post-commit signals do not lose durable notice or response history.
	db.SetNotificationHook(nil)
	db.SetSocialInvalidationHook(nil)
	if _, err := db.RespondGroupEvent(context.Background(), conn, 2, 10, e.ID, 102, 1, "not_going"); err != nil {
		t.Fatal(err)
	}
	socialUnread(t, h, "b18-fixture-2", 1)
	restored, err := db.GetGroupEvent(context.Background(), conn, 2, 10, e.ID)
	if err != nil || restored.ViewerResponse.Version != 2 || restored.Counts.NotGoing != 1 {
		t.Fatal(restored, err)
	}
}
