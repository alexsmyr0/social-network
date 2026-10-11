package tests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"forum/internal/db"
	"forum/internal/router"
	"forum/internal/ws"
)

// assertGroupInvariants checks the state every committed history must satisfy,
// whatever interleaving produced it.
func assertGroupInvariants(t *testing.T, conn *sql.DB) {
	t.Helper()
	one := func(label, query string) {
		t.Helper()
		var n int
		if err := conn.QueryRow(query).Scan(&n); err != nil {
			t.Fatal(label, err)
		}
		if n != 0 {
			t.Errorf("invariant %q violated by %d rows", label, n)
		}
	}
	one("duplicate membership", `SELECT COUNT(*) FROM (SELECT group_id,user_id FROM group_memberships GROUP BY 1,2 HAVING COUNT(*)>1)`)
	one("group without one creator", `SELECT COUNT(*) FROM groups g WHERE (SELECT COUNT(*) FROM group_memberships m WHERE m.group_id=g.id AND m.role='creator' AND m.user_id=g.creator_id)<>1`)
	one("pending invitation from nonmember", `SELECT COUNT(*) FROM group_invitations i WHERE NOT EXISTS(SELECT 1 FROM group_memberships m WHERE m.group_id=i.group_id AND m.user_id=i.inviter_id)`)
	one("pending invitation to member", `SELECT COUNT(*) FROM group_invitations i WHERE EXISTS(SELECT 1 FROM group_memberships m WHERE m.group_id=i.group_id AND m.user_id=i.invitee_id)`)
	one("pending request from member", `SELECT COUNT(*) FROM group_join_requests r WHERE EXISTS(SELECT 1 FROM group_memberships m WHERE m.group_id=r.group_id AND m.user_id=r.requester_id)`)
	one("pending notice without live entry", `SELECT COUNT(*) FROM notifications n WHERE n.group_state='pending' AND
 NOT EXISTS(SELECT 1 FROM group_invitations i WHERE n.type='group_invitation' AND i.id=n.group_entry_id) AND
 NOT EXISTS(SELECT 1 FROM group_join_requests r WHERE n.type='group_join_request' AND r.id=n.group_entry_id)`)
	one("resolved notice with live entry", `SELECT COUNT(*) FROM notifications n WHERE n.group_state IN('accepted','refused','cancelled','superseded') AND
 (EXISTS(SELECT 1 FROM group_invitations i WHERE n.type='group_invitation' AND i.id=n.group_entry_id) OR
  EXISTS(SELECT 1 FROM group_join_requests r WHERE n.type='group_join_request' AND r.id=n.group_entry_id))`)
	one("live entry without exactly one notice", `SELECT COUNT(*) FROM (
 SELECT i.id FROM group_invitations i WHERE (SELECT COUNT(*) FROM notifications n WHERE n.type='group_invitation' AND n.group_entry_id=i.id)<>1
 UNION ALL SELECT r.id FROM group_join_requests r WHERE (SELECT COUNT(*) FROM notifications n WHERE n.type='group_join_request' AND n.group_entry_id=r.id)<>1)`)
	one("resolved notice left unread", `SELECT COUNT(*) FROM notifications WHERE group_state IN('accepted','refused','cancelled','superseded') AND is_read=0`)
}

type raceReply struct {
	status int
	code   string
}

func replyOf(response *httptest.ResponseRecorder) raceReply {
	var body struct{ Error struct{ Code string } }
	json.Unmarshal(response.Body.Bytes(), &body)
	return raceReply{response.Code, body.Error.Code}
}

func TestGroupConcurrentRacesPreserveOneValidResult(t *testing.T) {
	pack := loadGroupPack(t)
	for _, race := range pack.Races {
		t.Run(race.Name, func(t *testing.T) {
			for round := 0; round < 12; round++ {
				handler, conn := socialAPI(t)
				seedGroupFixture(t, conn, mergeGroupState(pack.State, race.Given), pack.Clock)
				for _, op := range race.Ops {
					viewer := op.Viewer
					conn.Exec(`INSERT OR IGNORE INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, viewer, fmt.Sprintf("b18-fixture-%d", viewer))
				}
				var wg sync.WaitGroup
				start := make(chan struct{})
				replies := map[string]raceReply{}
				var mu sync.Mutex
				for label, op := range race.Ops {
					wg.Add(1)
					go func() {
						defer wg.Done()
						<-start
						viewer := op.Viewer
						response := runGroupRequest(t, handler, conn, &viewer, op.Request)
						mu.Lock()
						replies[label] = replyOf(response)
						mu.Unlock()
					}()
				}
				close(start)
				wg.Wait()
				matched := ""
				for order, outcome := range race.Outcomes {
					okA := replies["A"].status == int(outcome.A[0].(float64)) && (outcome.A[1] == nil || outcome.A[1] == replies["A"].code)
					okB := replies["B"].status == int(outcome.B[0].(float64)) && (outcome.B[1] == nil || outcome.B[1] == replies["B"].code)
					if okA && okB {
						matched = order
					}
				}
				if matched == "" {
					t.Fatalf("round %d: replies %+v match neither serial order", round, replies)
				}
				assertGroupState(t, conn, race.Outcomes[matched].Final, pack.Clock)
				assertGroupInvariants(t, conn)
			}
		})
	}
}

func TestGroupParallelWritersKeepInvariants(t *testing.T) {
	pack := loadGroupPack(t)
	handler, conn := socialAPI(t)
	seedGroupFixture(t, conn, pack.State, pack.Clock)
	users := []int64{42, 7, 8, 9, 10, 11, 12, 99}
	for _, u := range users {
		conn.Exec(`INSERT OR IGNORE INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, u, fmt.Sprintf("b18-fixture-%d", u))
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	failures := []string{}
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			for i := 0; i < 60; i++ {
				viewer := users[rng.Intn(len(users))]
				target := users[rng.Intn(len(users))]
				id := rng.Intn(12) + 1
				var request groupRequest
				switch rng.Intn(6) {
				case 0:
					request = groupRequest{Method: "POST", Path: "/api/v1/groups/301/invitations", Body: json.RawMessage(fmt.Sprintf(`{"user_id":%d}`, target))}
				case 1:
					request = groupRequest{Method: "POST", Path: "/api/v1/groups/301/join-requests"}
				case 2:
					request = groupRequest{Method: "PATCH", Path: fmt.Sprintf("/api/v1/group-invitations/%d", 600+id), Body: json.RawMessage(`{"decision":"accept"}`)}
				case 3:
					request = groupRequest{Method: "PATCH", Path: fmt.Sprintf("/api/v1/group-join-requests/%d", 700+id), Body: json.RawMessage([]byte(fmt.Sprintf(`{"decision":%q}`, []string{"accept", "refuse"}[rng.Intn(2)])))}
				case 4:
					request = groupRequest{Method: "PATCH", Path: fmt.Sprintf("/api/v1/group-invitations/%d", 600+id), Body: json.RawMessage(`{"decision":"refuse"}`)}
				default:
					request = groupRequest{Method: "DELETE", Path: fmt.Sprintf("/api/v1/group-memberships/%d", 500+id)}
				}
				response := runGroupRequest(t, handler, conn, &viewer, request)
				if response.Code >= 500 {
					mu.Lock()
					failures = append(failures, fmt.Sprintf("%s %s -> %d %s", request.Method, request.Path, response.Code, response.Body.String()))
					mu.Unlock()
				}
			}
		}(int64(worker + 1))
	}
	wg.Wait()
	if len(failures) > 0 {
		t.Fatalf("%d requests failed server-side, first: %s", len(failures), failures[0])
	}
	assertGroupInvariants(t, conn)
}

func TestGroupAtomicNoticeFailureRollsBackSilently(t *testing.T) {
	pack := loadGroupPack(t)
	cases := []struct {
		name, trigger string
		viewer        int64
		request       groupRequest
	}{
		{"invite notice insert", `CREATE TRIGGER inject BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 7,
			groupRequest{Method: "POST", Path: "/api/v1/groups/301/invitations", Body: json.RawMessage(`{"user_id":99}`)}},
		{"request notice insert", `CREATE TRIGGER inject BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 99,
			groupRequest{Method: "POST", Path: "/api/v1/groups/301/join-requests"}},
		{"accept invitation notice update", `CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 8,
			groupRequest{Method: "PATCH", Path: "/api/v1/group-invitations/601", Body: json.RawMessage(`{"decision":"accept"}`)}},
		{"refuse invitation notice update", `CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 8,
			groupRequest{Method: "PATCH", Path: "/api/v1/group-invitations/601", Body: json.RawMessage(`{"decision":"refuse"}`)}},
		{"accept request notice update", `CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 42,
			groupRequest{Method: "PATCH", Path: "/api/v1/group-join-requests/701", Body: json.RawMessage(`{"decision":"accept"}`)}},
		{"leave cancels invitations", `CREATE TRIGGER inject BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END`, 7,
			groupRequest{Method: "DELETE", Path: "/api/v1/group-memberships/502"}},
		{"membership insert", `CREATE TRIGGER inject BEFORE INSERT ON group_memberships BEGIN SELECT RAISE(ABORT,'injected'); END`, 8,
			groupRequest{Method: "PATCH", Path: "/api/v1/group-invitations/601", Body: json.RawMessage(`{"decision":"accept"}`)}},
		{"membership delete", `CREATE TRIGGER inject BEFORE DELETE ON group_memberships BEGIN SELECT RAISE(ABORT,'injected'); END`, 42,
			groupRequest{Method: "DELETE", Path: "/api/v1/group-memberships/502"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			handler, conn := socialAPI(t)
			seedGroupFixture(t, conn, pack.State, pack.Clock)
			fixtureExec(t, conn, c.trigger)
			before := groupStateSnapshot(t, conn)
			signals := captureGroupSignals(t)
			viewer := c.viewer
			response := runGroupRequest(t, handler, conn, &viewer, c.request)
			if response.Code != http.StatusInternalServerError {
				t.Fatalf("status %d %s, want 500", response.Code, response.Body.String())
			}
			if after := groupStateSnapshot(t, conn); !reflect.DeepEqual(before, after) {
				t.Fatalf("failed transaction left state behind\nbefore %v\nafter  %v", before, after)
			}
			if got := signals.sorted(); len(got) != 0 {
				t.Fatalf("rollback emitted signals %v", got)
			}
		})
	}
}

func TestGroupForgedAndConfusedIdentitiesCannotAdmit(t *testing.T) {
	pack := loadGroupPack(t)
	handler, conn := socialAPI(t)
	seedGroupFixture(t, conn, pack.State, pack.Clock)
	signals := captureGroupSignals(t)
	do := func(viewer int64, method, path, body string) *httptest.ResponseRecorder {
		request := groupRequest{Method: method, Path: path}
		if body != "" {
			request.Body = json.RawMessage(body)
		}
		return runGroupRequest(t, handler, conn, &viewer, request)
	}
	members := func() int {
		var n int
		conn.QueryRow(`SELECT COUNT(*) FROM group_memberships`).Scan(&n)
		return n
	}
	start := members()
	// A notification ID is not an invitation ID; the invitee cannot use notice 801 as a credential.
	if r := do(8, "PATCH", "/api/v1/group-invitations/801", `{"decision":"accept"}`); r.Code != 409 || replyOf(r).code != "STALE_INVITATION" {
		t.Fatalf("notice ID accepted as invitation: %d %s", r.Code, r.Body.String())
	}
	// Notice 802 belongs to the creator; nobody else can read, mark or act through it.
	for _, viewer := range []int64{7, 8, 9, 99} {
		if r := do(viewer, "PATCH", "/api/v1/notifications/802/read", ""); r.Code != 404 {
			t.Fatalf("foreign notice read by %d: %d", viewer, r.Code)
		}
		if r := do(viewer, "PATCH", "/api/v1/group-join-requests/701", `{"decision":"accept"}`); r.Code != 404 {
			t.Fatalf("non-creator %d decided a request: %d", viewer, r.Code)
		}
	}
	// Wrong participants cannot decide, remove or accept for someone else.
	for _, c := range []struct {
		viewer int64
		method string
		path   string
		body   string
	}{
		{42, "PATCH", "/api/v1/group-invitations/601", `{"decision":"accept"}`},
		{7, "PATCH", "/api/v1/group-invitations/601", `{"decision":"accept"}`},
		{9, "PATCH", "/api/v1/group-invitations/601", `{"decision":"refuse"}`},
		{8, "DELETE", "/api/v1/group-memberships/502", ""},
		{7, "DELETE", "/api/v1/group-memberships/501", ""},
		{99, "DELETE", "/api/v1/group-memberships/502", ""},
	} {
		if r := do(c.viewer, c.method, c.path, c.body); r.Code != 404 {
			t.Fatalf("%d %s %s -> %d, want 404", c.viewer, c.method, c.path, r.Code)
		}
	}
	// The creator can never leave, directly or through removal.
	if r := do(42, "DELETE", "/api/v1/group-memberships/501", ""); r.Code != 409 || replyOf(r).code != "CREATOR_CANNOT_LEAVE" {
		t.Fatalf("creator departure: %d %s", r.Code, r.Body.String())
	}
	if members() != start || len(signals.sorted()) != 0 {
		t.Fatalf("forged actions changed membership or signalled %v", signals.sorted())
	}
	assertGroupInvariants(t, conn)
	// Duplicate membership is impossible through the API: the second accept is stale.
	if r := do(8, "PATCH", "/api/v1/group-invitations/601", `{"decision":"accept"}`); r.Code != 200 {
		t.Fatalf("accept %d %s", r.Code, r.Body.String())
	}
	if r := do(8, "PATCH", "/api/v1/group-invitations/601", `{"decision":"accept"}`); r.Code != 409 {
		t.Fatalf("replayed accept %d", r.Code)
	}
	if r := do(8, "POST", "/api/v1/groups/301/join-requests", ""); r.Code != 409 || replyOf(r).code != "ALREADY_MEMBER" {
		t.Fatalf("member request %d %s", r.Code, r.Body.String())
	}
	if members() != start+1 {
		t.Fatalf("membership count %d, want %d", members(), start+1)
	}
	assertGroupInvariants(t, conn)
}

func openGroupAPI(t *testing.T, path string) (http.Handler, *sql.DB) {
	t.Helper()
	conn, err := db.InitDB(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return router.NewRouter(conn, ws.NewHub()), conn
}

func apiJSON(t *testing.T, handler http.Handler, token, method, path, body string, want int) json.RawMessage {
	t.Helper()
	contentType := ""
	var raw []byte
	if body != "" {
		contentType = "application/json"
		raw = []byte(body)
	}
	response := socialRequest(t, handler, method, path, contentType, raw, token)
	if response.Code != want {
		t.Fatalf("%s %s -> %d %s, want %d", method, path, response.Code, response.Body.String(), want)
	}
	var envelope struct{ Data json.RawMessage }
	json.Unmarshal(response.Body.Bytes(), &envelope)
	return envelope.Data
}

// TestGroupRealAccountsRestartAndMissedSignalRecovery drives registered accounts
// with no socket attached: every committed change is recovered purely by reads
// and survives restarts, and resolved identities never become usable again.
func TestGroupRealAccountsRestartAndMissedSignalRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "restart.db")
	handler, _ := openGroupAPI(t, path)
	owner := registerSocialUser(t, handler, "owner@example.com")
	ada := registerSocialUser(t, handler, "ada@example.com")
	bob := registerSocialUser(t, handler, "bob@example.com")
	cy := registerSocialUser(t, handler, "cy@example.com")

	var group struct {
		ID     int64
		Viewer struct {
			Role         string
			MembershipID int64 `json:"membership_id"`
		}
		MemberCount int `json:"member_count"`
	}
	json.Unmarshal(apiJSON(t, handler, owner, "POST", "/api/v1/groups", `{"title":" Book  Club ","description":"Monthly reads"}`, 201), &group)
	if group.Viewer.Role != "creator" || group.MemberCount != 1 {
		t.Fatalf("created group %+v", group)
	}
	base := fmt.Sprintf("/api/v1/groups/%d", group.ID)
	var request struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, ada, "POST", base+"/join-requests", "", 201), &request)
	var invitation struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, owner, "POST", base+"/invitations", `{"user_id":3}`, 201), &invitation)
	apiJSON(t, handler, owner, "POST", base+"/invitations", `{"user_id":4}`, 201)

	// Restart with no signal delivery at all: pending work is read back.
	handler, conn := openGroupAPI(t, path)
	var pending struct {
		Notifications []struct {
			Type    string
			Actions []string
			Target  struct {
				State   string
				Request int64 `json:"request_id"`
				Invite  int64 `json:"invitation_id"`
			}
		}
		UnreadCount int `json:"unread_count"`
	}
	json.Unmarshal(apiJSON(t, handler, owner, "GET", "/api/v1/notifications", "", 200), &pending)
	if pending.UnreadCount != 1 || len(pending.Notifications) != 1 || pending.Notifications[0].Type != "group_join_request" ||
		!reflect.DeepEqual(pending.Notifications[0].Actions, []string{"accept", "refuse"}) || pending.Notifications[0].Target.Request != request.ID {
		t.Fatalf("restart lost the creator's pending request notice: %+v", pending)
	}
	var mine []struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, bob, "GET", "/api/v1/users/me/group-invitations", "", 200), &mine)
	if len(mine) != 1 || mine[0].ID != invitation.ID {
		t.Fatalf("restart lost the invitee's invitation: %+v", mine)
	}

	// Accept and refuse, restart again, and replay every resolved identity.
	var membership struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, bob, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", invitation.ID), `{"decision":"accept"}`, 200), &membership)
	bobMembership := membership.ID
	apiJSON(t, handler, owner, "PATCH", fmt.Sprintf("/api/v1/group-join-requests/%d", request.ID), `{"decision":"refuse"}`, 204)
	handler, conn = openGroupAPI(t, path)
	apiJSON(t, handler, bob, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", invitation.ID), `{"decision":"accept"}`, 409)
	apiJSON(t, handler, owner, "PATCH", fmt.Sprintf("/api/v1/group-join-requests/%d", request.ID), `{"decision":"accept"}`, 409)
	json.Unmarshal(apiJSON(t, handler, owner, "GET", "/api/v1/notifications", "", 200), &pending)
	if pending.UnreadCount != 0 || len(pending.Notifications) != 1 || pending.Notifications[0].Target.State != "refused" || len(pending.Notifications[0].Actions) != 0 {
		t.Fatalf("resolved history after restart: %+v", pending)
	}

	// Bob leaves, restarts, and cannot use the old membership; Cy's invitation from
	// the departed member's group stays valid because its inviter is the creator.
	apiJSON(t, handler, bob, "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", bobMembership), "", 204)
	handler, conn = openGroupAPI(t, path)
	apiJSON(t, handler, owner, "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", bobMembership), "", 409)
	apiJSON(t, handler, bob, "GET", base+"/members", "", 404)
	json.Unmarshal(apiJSON(t, handler, cy, "GET", "/api/v1/users/me/group-invitations", "", 200), &mine)
	if len(mine) != 1 {
		t.Fatalf("an unrelated invitation was cancelled: %+v", mine)
	}

	// Identities keep increasing across deletion and restart.
	var returned struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, owner, "POST", base+"/invitations", `{"user_id":3}`, 201), &returned)
	if returned.ID <= invitation.ID {
		t.Fatalf("invitation ID %d not greater than resolved %d", returned.ID, invitation.ID)
	}
	json.Unmarshal(apiJSON(t, handler, bob, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", returned.ID), `{"decision":"accept"}`, 200), &membership)
	if membership.ID <= bobMembership {
		t.Fatalf("membership generation %d not greater than %d", membership.ID, bobMembership)
	}
	assertGroupInvariants(t, conn)
}

func TestGroupSocketSignalsAreRecipientScopedAndPayloadFree(t *testing.T) {
	requireLocalTCPListener(t)
	handler, _, hub := socialAPIWithHub(t)
	wireSocialSocketHooks(t, hub)
	owner := registerSocialUser(t, handler, "owner@example.com")
	invitee := registerSocialUser(t, handler, "invitee@example.com")
	bystander := registerSocialUser(t, handler, "bystander@example.com")
	srv := httptest.NewServer(handler)
	defer srv.Close()
	ownerSocket := openSocialSocket(t, srv, owner)
	inviteeSocket := openSocialSocket(t, srv, invitee)
	bystanderSocket := openSocialSocket(t, srv, bystander)

	// Group creation refreshes discovery for every authenticated socket.
	var group struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, owner, "POST", "/api/v1/groups", `{"title":"Go","description":"Gophers"}`, 201), &group)
	ownerSocket.expect(t, "social.invalidate")
	inviteeSocket.expect(t, "social.invalidate")
	bystanderSocket.expect(t, "social.invalidate")

	// Invitation: notice and refresh to the invitee, refresh to the inviter, nothing to others.
	var invitation struct{ ID int64 }
	json.Unmarshal(apiJSON(t, handler, owner, "POST", fmt.Sprintf("/api/v1/groups/%d/invitations", group.ID), `{"user_id":2}`, 201), &invitation)
	inviteeSocket.expect(t, "notification.new", "social.invalidate")
	ownerSocket.expect(t, "social.invalidate")
	bystanderSocket.silent(t)
	// Duplicates, stale decisions and denials are silent.
	apiJSON(t, handler, owner, "POST", fmt.Sprintf("/api/v1/groups/%d/invitations", group.ID), `{"user_id":2}`, 200)
	apiJSON(t, handler, bystander, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", invitation.ID), `{"decision":"accept"}`, 404)
	apiJSON(t, handler, invitee, "PATCH", "/api/v1/group-invitations/999", `{"decision":"accept"}`, 409)
	for _, probe := range []*socialSocketProbe{ownerSocket, inviteeSocket, bystanderSocket} {
		probe.silent(t)
	}
	// Admission refreshes the participants and members, not the bystander.
	apiJSON(t, handler, invitee, "PATCH", fmt.Sprintf("/api/v1/group-invitations/%d", invitation.ID), `{"decision":"accept"}`, 200)
	inviteeSocket.expect(t, "social.invalidate")
	ownerSocket.expect(t, "social.invalidate")
	bystanderSocket.silent(t)
	// A join request notifies only the creator.
	apiJSON(t, handler, bystander, "POST", fmt.Sprintf("/api/v1/groups/%d/join-requests", group.ID), "", 201)
	ownerSocket.expect(t, "notification.new", "social.invalidate")
	bystanderSocket.expect(t, "social.invalidate")
	inviteeSocket.silent(t)
	// Removal refreshes the removed member and remaining members.
	var members []struct {
		Membership struct{ ID int64 }
		ID         int64
	}
	json.Unmarshal(apiJSON(t, handler, owner, "GET", fmt.Sprintf("/api/v1/groups/%d/members", group.ID), "", 200), &members)
	var inviteeMembership int64
	for _, m := range members {
		if m.ID == 2 {
			inviteeMembership = m.Membership.ID
		}
	}
	apiJSON(t, handler, owner, "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", inviteeMembership), "", 204)
	inviteeSocket.expect(t, "social.invalidate")
	ownerSocket.expect(t, "social.invalidate")
	bystanderSocket.silent(t)
}
