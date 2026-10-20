package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"forum/internal/db"
	"forum/internal/handlers"
)

// B23 coverage on real sockets: the approved room cases, role matrix, retries across
// transports, delivery authorization through the socket write, membership
// generations, cursors and the departure-versus-send race.

func isGroupChatCase(path string) bool {
	return strings.Contains(path, "/group-chats") || strings.Contains(path, "/groups/") && strings.Contains(path, "/messages")
}

func (w *dmWorld) roomSend(t *testing.T, from, membership int64, group int, nonce, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return w.as(t, from, "POST", fmt.Sprintf("/api/v1/groups/%d/messages", group), map[string]any{"membership_id": membership, "client_id": nonce, "body": body})
}

// session opens one more authenticated socket for a user who already has one.
func (w *dmWorld) session(t *testing.T, user int64) *dmProbe {
	t.Helper()
	token := fmt.Sprintf("b18-fixture-%d-extra%d", user, len(w.probes))
	fixtureExec(t, w.conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(?,?,'','')`, user, token)
	return openDM(t, w.srv, token)
}

func roomFrames(p *dmProbe) []dmFrame { return p.of("group.message") }

func frameIDs(frames []dmFrame) []int64 {
	out := []int64{}
	for _, f := range frames {
		var m struct{ ID int64 }
		json.Unmarshal(f.Payload, &m)
		out = append(out, m.ID)
	}
	return out
}

// index returns the position of the first frame of a type, or -1.
func frameIndex(p *dmProbe, kind string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, f := range p.frames {
		if f.Type == kind {
			return i
		}
	}
	return -1
}

func TestGroupChatContractFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, c := range pack.Cases {
		if !isGroupChatCase(c.Request.Path) {
			continue
		}
		ran++
		t.Run(c.ID, func(t *testing.T) { replayChatCase(t, pack, c) })
	}
	if ran != 40 {
		t.Fatalf("ran %d room cases, want 40", ran)
	}
}

// Every room cell of the approved role matrix agrees with the replayed HTTP case.
func TestGroupChatRoleMatrixMatchesReplayedCases(t *testing.T) {
	pack := loadDMPack(t)
	raw := loadGroupMatrix(t)
	byID := map[string]dmFixtureCase{}
	for _, c := range pack.Cases {
		byID[c.ID] = c
	}
	cells := 0
	for _, cell := range raw {
		if !strings.HasPrefix(cell.Surface, "room_") {
			continue
		}
		cells++
		c, ok := byID[cell.CaseID]
		if !ok {
			t.Fatalf("matrix cell %s has no replayed case", cell.CaseID)
		}
		if allowed := c.Expect.Status < 400; allowed != cell.Allow {
			t.Fatalf("%s: case status %d, matrix allow=%v", cell.CaseID, c.Expect.Status, cell.Allow)
		}
	}
	if cells != 24 {
		t.Fatalf("%d room cells, want 3 surfaces x 8 roles", cells)
	}
}

func loadDMPackRaw(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-5-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type groupMatrixCell struct {
	CaseID  string `json:"case_id"`
	Role    string
	Surface string
	Allow   bool
}

func loadGroupMatrix(t *testing.T) []groupMatrixCell {
	t.Helper()
	raw := loadDMPackRaw(t)
	var pack struct {
		Matrix []groupMatrixCell `json:"group_matrix"`
		Roles  map[string]int64  `json:"roles"`
	}
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	return pack.Matrix
}

// The same role cells over the socket: allowed roles are acked, everyone else gets
// a not-found error, nothing is stored for them and no one else sees a frame.
func TestGroupChatRoleMatrixOverSockets(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	roles := map[string]int64{"creator": 1, "member": 2, "invitee": 3, "requester": 4, "outsider": 5, "departed": 6, "removed": 7, "departed_author": 8}
	names := make([]string, 0, len(roles))
	for name := range roles {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, role := range names {
		t.Run(role, func(t *testing.T) {
			w := newDMWorld(t, pack, nil)
			user := roles[role]
			membership := map[int64]int64{1: 101, 2: 102}[user]
			if membership == 0 {
				membership = 999
			}
			before := dmSnapshot(t, w.conn)
			w.probes[user].send(t, map[string]any{"type": "group.send", "payload": map[string]any{"group_id": 10, "membership_id": membership, "client_id": nonceA, "body": "hello"}})
			if membership != 999 {
				w.probes[user].waitFor(t, "chat.ack", 1)
				w.probes[1].waitFor(t, "group.message", 1)
				w.probes[2].waitFor(t, "group.message", 1)
			} else {
				frames := w.probes[user].waitFor(t, "chat.error", 1)
				if !strings.Contains(string(frames[0].Payload), `"NOT_FOUND"`) {
					t.Fatalf("%s: %s", role, frames[0].Payload)
				}
				if !reflect.DeepEqual(before, dmSnapshot(t, w.conn)) {
					t.Fatal("a denied role changed state")
				}
			}
			w.quiesce()
			for id, p := range w.probes {
				want := 0
				if membership != 999 && (id == 1 || id == 2) {
					want = 1
				}
				if got := len(p.of("group.message")); got != want {
					t.Fatalf("%s: user %d received %d room frames, want %d", role, id, got, want)
				}
			}
		})
	}
}

/*---------------------------------------------------------------------------
  socket cases
---------------------------------------------------------------------------*/

func TestGroupChatSocketFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, c := range pack.Sockets {
		if !strings.HasPrefix(c.ID, "group-") {
			continue
		}
		ran++
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, c.Given)
			actor := w.probes[c.Actor]
			actor.send(t, json.RawMessage(c.Frame))
			switch {
			case c.Expect.Ack != nil:
				frames := actor.waitFor(t, "chat.ack", 1)
				if !reflect.DeepEqual(normalizePayload(frames[0].Payload), normalizePayload(c.Expect.Ack.Payload)) {
					t.Fatalf("ack %s want %s", frames[0].Payload, c.Expect.Ack.Payload)
				}
			case c.Expect.Error != nil:
				frames := actor.waitFor(t, "chat.error", 1)
				if !reflect.DeepEqual(normalizePayload(frames[0].Payload), normalizePayload(c.Expect.Error.Payload)) {
					t.Fatalf("error %s want %s", frames[0].Payload, c.Expect.Error.Payload)
				}
			}
			w.quiesce()
			for user, probe := range w.probes {
				wantAck, wantErr := 0, 0
				if user == c.Actor && c.Expect.Ack != nil {
					wantAck = 1
				}
				if user == c.Actor && c.Expect.Error != nil {
					wantErr = 1
				}
				if len(probe.of("chat.ack")) != wantAck || len(probe.of("chat.error")) != wantErr {
					t.Fatalf("user %d saw %d acks and %d errors", user, len(probe.of("chat.ack")), len(probe.of("chat.error")))
				}
				for _, f := range probe.frames {
					if bytes.Contains(f.Raw, []byte("x_membership_id")) {
						t.Fatalf("the internal generation reached user %d: %s", user, f.Raw)
					}
				}
			}
			view := map[int64]*dmProbe{}
			for user, probe := range w.probes {
				view[user] = &dmProbe{frames: probe.of("group.message", "chat.read")}
			}
			assertDMSignals(t, c.Expect.Fanout, view)
		})
	}
	if ran != 3 {
		t.Fatalf("ran %d group socket cases, want 3", ran)
	}
}

/*---------------------------------------------------------------------------
  sequences and races
---------------------------------------------------------------------------*/

func TestGroupChatFixtureSequenceRemovalAndReadmission(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, seq := range pack.Sequences {
		if seq.ID != "removal-readmission" {
			continue
		}
		ran++
		t.Run(seq.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, nil)
			for i, step := range seq.Steps {
				got := w.apply(t, step.Action)
				e := step.Expect
				if got.status != e.Status {
					t.Fatalf("step %d %s: status %d want %d", i, step.Action.Op, got.status, e.Status)
				}
				if e.ID != 0 && got.id != e.ID {
					t.Fatalf("step %d: id %d want %d", i, got.id, e.ID)
				}
				if e.Code != "" && got.code != e.Code {
					t.Fatalf("step %d: code %q want %q", i, got.code, e.Code)
				}
				if e.IDs != nil && !reflect.DeepEqual(got.ids, e.IDs) {
					t.Fatalf("step %d: ids %v want %v", i, got.ids, e.IDs)
				}
				if e.UnreadCount != nil && got.unread != *e.UnreadCount {
					t.Fatalf("step %d: unread %d want %d", i, got.unread, *e.UnreadCount)
				}
				if e.Membership != 0 && got.membership != e.Membership {
					t.Fatalf("step %d: membership %d want %d", i, got.membership, e.Membership)
				}
			}
		})
	}
	if ran != 1 {
		t.Fatalf("ran %d sequences", ran)
	}
}

func TestGroupChatFixtureRacesInBothOrders(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, race := range pack.Races {
		if race.ID != "remove-send" {
			continue
		}
		for _, order := range race.Orders {
			ran++
			t.Run(fmt.Sprint(order.Order), func(t *testing.T) {
				w := newDMWorld(t, pack, nil)
				for step, index := range order.Order {
					got := w.apply(t, race.Actions[index])
					if got.status != order.Statuses[step] {
						t.Fatalf("%s step %d: status %d want %d", race.Actions[index].Op, step, got.status, order.Statuses[step])
					}
				}
				w.quiesce()
				stored := w.count(t, `SELECT COUNT(*) FROM group_messages WHERE id>802`)
				delivered := len(w.probes[1].of("group.message"))
				if order.Statuses[1] == 404 {
					// Revocation first: nothing was committed or delivered.
					if stored != 0 || delivered != 0 || len(w.probes[2].of("group.message")) != 0 {
						t.Fatalf("revocation first but stored=%d delivered=%d", stored, delivered)
					}
					return
				}
				// Send first: the message stays stored and reached the remaining member; the
				// removed member's copy was ordered before the removal or suppressed by it.
				if stored != 1 || delivered != 1 {
					t.Fatalf("send first but stored=%d delivered=%d", stored, delivered)
				}
				if n := len(w.probes[2].of("group.message")); n > 1 {
					t.Fatalf("removed member received %d copies", n)
				}
			})
		}
	}
	if ran != 2 {
		t.Fatalf("ran %d ordered race cases, want 2", ran)
	}
}

/*---------------------------------------------------------------------------
  delivery authorization
---------------------------------------------------------------------------*/

// A queued room frame is re-authorized at the socket write against the exact
// membership generation it was queued for.
func TestGroupChatDeliveryFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, c := range pack.Delivery {
		if c.Type != "group.message" && c.Type != "chat.read" && c.Type != "chat.ack" {
			continue
		}
		ran++
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, c.Given)
			if !c.SessionValid {
				fixtureExec(t, w.conn, `UPDATE sessions SET is_valid=0 WHERE token=?`, fmt.Sprintf("b18-fixture-%d", c.Viewer))
			}
			probe := w.probes[c.Viewer]
			if probe == nil {
				t.Fatal("no socket for the viewer")
			}
			var payload any
			switch c.Type {
			case "group.message":
				payload = map[string]any{"id": 803, "group_id": c.Target, "sender_id": c.Sender, "sender_username": "x", "body": "queued", "created_at": pack.Clock, "client_id": nil}
			case "chat.read":
				payload = map[string]any{"kind": "group", "target_id": c.Target, "through_id": 802, "unread_count": 0}
			default:
				payload = map[string]any{"kind": "group", "target_id": c.Target, "client_id": nonceA, "message_id": 803, "duplicate": false}
			}
			if err := w.hub.SendToUser(c.Viewer, handlers.GroupFrame(c.Type, c.Membership, payload)); err != nil {
				t.Fatal(err)
			}
			w.quiesce()
			if got := len(probe.of(c.Type)) == 1; got != c.Deliver {
				t.Fatalf("delivered=%v want %v", got, c.Deliver)
			}
			for _, f := range probe.of(c.Type) {
				if bytes.Contains(f.Raw, []byte("x_membership_id")) {
					t.Fatalf("the internal generation reached the client: %s", f.Raw)
				}
			}
		})
	}
	if ran != 7 {
		t.Fatalf("ran %d room delivery cases, want 7", ran)
	}
}

// A frame that cannot say which generation it belongs to is never written.
func TestGroupChatFrameWithoutGenerationIsSuppressed(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	plain, _ := json.Marshal(map[string]any{"type": "group.message", "payload": map[string]any{
		"id": 803, "group_id": 10, "sender_id": 2, "sender_username": "x", "body": "unstamped", "created_at": pack.Clock, "client_id": nil}})
	if err := w.hub.SendToUser(2, plain); err != nil {
		t.Fatal(err)
	}
	w.quiesce()
	if len(w.probes[2].of("group.message")) != 0 {
		t.Fatal("an unstamped room frame was written")
	}
	select {
	case <-w.probes[2].done:
		t.Fatal("suppressing a frame closed the connection")
	default:
	}
}

func TestGroupChatRevokedSessionReceivesNothingQueued(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	fixtureExec(t, w.conn, `UPDATE sessions SET is_valid=0 WHERE token='b18-fixture-2'`)
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceA, "to a revoked socket"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	select {
	case <-w.probes[2].done:
	case <-time.After(5 * time.Second):
		t.Fatal("revoked session stayed connected")
	}
	if len(w.probes[2].of("group.message")) != 0 {
		t.Fatal("revoked session received a queued message")
	}
}

func TestGroupChatQueuedFrameIsSuppressedWhenMembershipEndsBeforeWrite(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	for _, readmitted := range []bool{false, true} {
		t.Run(fmt.Sprintf("readmitted=%v", readmitted), func(t *testing.T) {
			w := newDMWorld(t, pack, nil)
			w.hub.WithRevocation(func() {
				if rec, _ := w.roomSend(t, 1, 101, 10, nonceA, "in flight"); rec.Code != 201 {
					t.Errorf("send %d", rec.Code)
				}
				// The membership ends after the frame was queued and before it is written.
				fixtureExec(t, w.conn, `DELETE FROM group_memberships WHERE id=102`)
				if readmitted {
					// Back as a new generation: the old frame still must not reach them.
					fixtureExec(t, w.conn, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(10,2,'member')`)
				}
			})
			w.probes[1].waitFor(t, "group.message", 1) // the remaining member's frame stays authorized
			w.quiesce()
			if n := len(w.probes[2].of("group.message")); n != 0 {
				t.Fatalf("former member received %d frames after the membership ended", n)
			}
			// The committed message stays stored for the members who can read it.
			if _, h := w.as(t, 1, "GET", "/api/v1/groups/10/messages", nil); len(dataOf(h)["messages"].([]any)) != 3 {
				t.Fatal("suppressed delivery lost the stored message")
			}
			// A frame written before the departure is delivered once (the other order).
			if readmitted {
				return
			}
			fixtureExec(t, w.conn, `INSERT INTO group_memberships(group_id,user_id,role)VALUES(10,2,'member')`)
			var generation int64
			w.conn.QueryRow(`SELECT id FROM group_memberships WHERE group_id=10 AND user_id=2`).Scan(&generation)
			if rec, _ := w.roomSend(t, 1, 101, 10, nonceB, "after readmission"); rec.Code != 201 {
				t.Fatalf("send %d", rec.Code)
			}
			w.probes[2].waitFor(t, "group.message", 1)
			fixtureExec(t, w.conn, `DELETE FROM group_memberships WHERE id=?`, generation)
			w.quiesce()
			if n := len(w.probes[2].of("group.message")); n != 1 {
				t.Fatalf("former member saw %d frames, want exactly the one written before revocation", n)
			}
		})
	}
}

// A removal must wait for a frame already being written; an ordinary read does not.
func TestGroupChatRemovalWaitsForInFlightDelivery(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	released := make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	w.hub.WithDeliveryAdmission(func() {
		go func() {
			rec, _ := w.as(t, 1, "DELETE", "/api/v1/group-memberships/102", nil)
			done <- rec
		}()
		select {
		case rec := <-done:
			t.Errorf("removal completed (%d) while a delivery write was in flight", rec.Code)
		case <-time.After(200 * time.Millisecond):
		}
		if rec, _ := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); rec.Code != 200 {
			t.Errorf("read blocked by the gate: %d", rec.Code)
		}
		close(released)
	})
	<-released
	if rec := <-done; rec.Code != 204 {
		t.Fatalf("removal %d %s", rec.Code, rec.Body)
	}
	if rec, _ := w.as(t, 2, "GET", "/api/v1/groups/10/messages", nil); rec.Code != 404 {
		t.Fatalf("removed member can read: %d", rec.Code)
	}
}

/*---------------------------------------------------------------------------
  fanout, retries and strict frames
---------------------------------------------------------------------------*/

func TestGroupChatFanoutDeliversOneFramePerMemberSession(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	second := w.session(t, 2)
	third := w.session(t, 1)

	rec, env := w.roomSend(t, 1, 101, 10, nonceA, "hi all 👋")
	if rec.Code != 201 {
		t.Fatalf("send %d %s", rec.Code, rec.Body)
	}
	w.probes[1].waitFor(t, "group.message", 1)
	w.probes[2].waitFor(t, "group.message", 1)
	second.waitFor(t, "group.message", 1)
	third.waitFor(t, "group.message", 1)
	w.quiesce()
	member := map[*dmProbe]bool{w.probes[1]: true, w.probes[2]: true, second: true, third: true}
	probes := []*dmProbe{second, third}
	for _, p := range w.probes {
		probes = append(probes, p)
	}
	for _, p := range probes {
		want := 0
		if member[p] {
			want = 1
		}
		if got := len(p.of("group.message")); got != want {
			t.Fatalf("a session received %d room frames, want %d", got, want)
		}
		if len(p.of("chat.ack")) != 0 {
			t.Fatal("HTTP sends have no socket ack")
		}
		for _, f := range p.frames {
			if bytes.Contains(f.Raw, []byte("x_membership_id")) {
				t.Fatalf("internal generation leaked: %s", f.Raw)
			}
		}
	}
	// The frame is exactly the HTTP message.
	got := normalizePayload(w.probes[2].of("group.message")[0].Payload)
	want := normalizePayload(rawJSON(t, dataOf(env)))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("frame %v differs from response %v", got, want)
	}

	// A socket send: the ack goes only to the requesting socket and precedes its own copy.
	w.probes[2].send(t, map[string]any{"type": "group.send", "payload": map[string]any{"group_id": 10, "membership_id": 102, "client_id": nonceB, "body": "reply"}})
	w.probes[2].waitFor(t, "chat.ack", 1)
	for _, p := range []*dmProbe{w.probes[1], third, second, w.probes[2]} {
		p.waitFor(t, "group.message", 2)
	}
	w.quiesce()
	for _, p := range probes {
		wantAck := 0
		if p == w.probes[2] {
			wantAck = 1
		}
		if len(p.of("chat.ack")) != wantAck {
			t.Fatal("ack reached a socket that did not ask")
		}
	}
	if a, m := frameIndex(w.probes[2], "chat.ack"), frameIndexNth(w.probes[2], "group.message", 2); a < 0 || a > m {
		t.Fatalf("ack at %d after its own copy at %d", a, m)
	}
	if ids := frameIDs(w.probes[1].of("group.message")); !reflect.DeepEqual(ids, []int64{803, 804}) {
		t.Fatalf("frames %v", ids)
	}
}

func frameIndexNth(p *dmProbe, kind string, n int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, f := range p.frames {
		if f.Type == kind {
			if n--; n == 0 {
				return i
			}
		}
	}
	return -1
}

func rawJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestGroupChatRetriesShareOneResultAcrossTransportsAndRestart(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	first, env := w.roomSend(t, 2, 102, 10, nonceA, "once")
	if first.Code != 201 {
		t.Fatalf("send %d", first.Code)
	}
	id := dataOf(env)["id"].(float64)
	w.probes[1].waitFor(t, "group.message", 1)
	// Socket retry of the same payload: the original, flagged duplicate, no fanout.
	w.probes[2].send(t, map[string]any{"type": "group.send", "payload": map[string]any{"group_id": 10, "membership_id": 102, "client_id": nonceA, "body": "once"}})
	acks := w.probes[2].waitFor(t, "chat.ack", 1)
	var ack chatAck
	json.Unmarshal(acks[0].Payload, &ack)
	if !ack.Duplicate || float64(ack.MessageID) != id || ack.Kind != "group" || ack.TargetID != 10 {
		t.Fatalf("retry ack %s", acks[0].Payload)
	}
	// A changed body is a conflict over either transport.
	rec, _ := w.roomSend(t, 2, 102, 10, nonceA, "changed")
	assertConflict(t, "body", rec.Code, rec.Body.String())
	w.probes[2].send(t, map[string]any{"type": "group.send", "payload": map[string]any{"group_id": 10, "membership_id": 102, "client_id": nonceA, "body": "changed"}})
	frames := w.probes[2].waitFor(t, "chat.error", 1)
	if !strings.Contains(string(frames[0].Payload), `"MESSAGE_CONFLICT"`) || !strings.Contains(string(frames[0].Payload), nonceA) {
		t.Fatalf("socket conflict %s", frames[0].Payload)
	}
	w.quiesce()
	if len(w.probes[1].of("group.message")) != 1 {
		t.Fatalf("retries fanned out %d times", len(w.probes[1].of("group.message")))
	}
	// HTTP retry after a restart: 200 with the same message, still no new row or fanout.
	w.restart(t)
	again, env2 := w.roomSend(t, 2, 102, 10, nonceA, "once")
	if again.Code != 200 || dataOf(env2)["id"].(float64) != id {
		t.Fatalf("retry after restart %d %s", again.Code, again.Body)
	}
	w.quiesce()
	if n := w.count(t, `SELECT COUNT(*) FROM group_messages WHERE client_id=?`, nonceA); n != 1 {
		t.Fatalf("%d rows for one nonce", n)
	}
	// Different nonce, same text: a deliberate second message.
	if rec, _ := w.roomSend(t, 2, 102, 10, nonceB, "once"); rec.Code != 201 {
		t.Fatalf("new nonce %d", rec.Code)
	}
}

type chatAck struct {
	Kind      string `json:"kind"`
	TargetID  int64  `json:"target_id"`
	ClientID  string `json:"client_id"`
	MessageID int64  `json:"message_id"`
	Duplicate bool   `json:"duplicate"`
}

func assertConflict(t *testing.T, name string, status int, body string) {
	t.Helper()
	if status != 409 || !strings.Contains(body, `"MESSAGE_CONFLICT"`) {
		t.Fatalf("%s: %d %s", name, status, body)
	}
}

// The nonce belongs to one room and one membership generation.
func TestGroupChatNonceCannotMoveBetweenRoomsOrGenerations(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceA, "here"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	rec, _ := w.roomSend(t, 1, 111, 11, nonceA, "here")
	assertConflict(t, "other room", rec.Code, rec.Body.String())
	// Leave and return: the old nonce no longer matches the new generation either.
	w.apply(t, dmFixtureAction{Op: "remove", User: 2, Group: 10})
	w.apply(t, dmFixtureAction{Op: "admit", User: 2, Group: 10})
	var generation int64
	w.conn.QueryRow(`SELECT id FROM group_memberships WHERE group_id=10 AND user_id=2`).Scan(&generation)
	if rec, _ := w.roomSend(t, 2, generation, 10, nonceC, "new generation"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	if rec, _ := w.roomSend(t, 2, 102, 10, nonceC, "new generation"); rec.Code != 409 || !strings.Contains(rec.Body.String(), "STALE_MEMBERSHIP") {
		t.Fatalf("old generation %d %s", rec.Code, rec.Body)
	}
}

func TestGroupChatSocketRejectionsAreStrictAndStateless(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	p := w.probes[2]
	long := strings.Repeat("x", 2001)
	good := func(extra map[string]any) map[string]any {
		payload := map[string]any{"group_id": 10, "membership_id": 102, "client_id": nonceA, "body": "x"}
		for k, v := range extra {
			if v == nil {
				delete(payload, k)
			} else {
				payload[k] = v
			}
		}
		return map[string]any{"type": "group.send", "payload": payload}
	}
	cases := []struct {
		name  string
		frame any
		code  string
		field string
		echo  string
	}{
		{"no payload", map[string]any{"type": "group.send"}, "INVALID_PAYLOAD", "", ""},
		{"extra envelope key", map[string]any{"type": "group.send", "payload": map[string]any{}, "id": 1}, "INVALID_PAYLOAD", "", ""},
		{"direct payload shape", map[string]any{"type": "group.send", "payload": map[string]any{"recipient_id": 1, "client_id": nonceA, "body": "x"}}, "INVALID_PAYLOAD", "", nonceA},
		{"unknown key", good(map[string]any{"sender_id": 2}), "INVALID_PAYLOAD", "", nonceA},
		{"image key", good(map[string]any{"image_url": "/api/v1/media/701"}), "INVALID_PAYLOAD", "", nonceA},
		{"missing nonce", good(map[string]any{"client_id": nil}), "VALIDATION_ERROR", "client_id", ""},
		{"bad nonce", good(map[string]any{"client_id": "AAAAAAAA-1111-4111-8111-111111111111"}), "VALIDATION_ERROR", "client_id", ""},
		{"missing group", good(map[string]any{"group_id": nil}), "VALIDATION_ERROR", "group_id", nonceA},
		{"unsafe group", good(map[string]any{"group_id": 9007199254740992}), "VALIDATION_ERROR", "group_id", nonceA},
		{"string group", good(map[string]any{"group_id": "10"}), "INVALID_PAYLOAD", "", nonceA},
		{"missing membership", good(map[string]any{"membership_id": nil}), "VALIDATION_ERROR", "membership_id", nonceA},
		{"zero membership", good(map[string]any{"membership_id": 0}), "VALIDATION_ERROR", "membership_id", nonceA},
		{"empty", good(map[string]any{"body": "  \n "}), "VALIDATION_ERROR", "body", nonceA},
		{"missing body", good(map[string]any{"body": nil}), "VALIDATION_ERROR", "body", nonceA},
		{"too long", good(map[string]any{"body": long}), "VALIDATION_ERROR", "body", nonceA},
		{"control character", good(map[string]any{"body": "a\u0007"}), "VALIDATION_ERROR", "body", nonceA},
		{"stale generation", good(map[string]any{"membership_id": 99}), "STALE_MEMBERSHIP", "", nonceA},
		{"unknown group", good(map[string]any{"group_id": 99}), "NOT_FOUND", "", nonceA},
		{"another group", good(map[string]any{"group_id": 11}), "NOT_FOUND", "", nonceA},
	}
	before := dmSnapshot(t, w.conn)
	for i, c := range cases {
		p.send(t, c.frame)
		frames := p.waitFor(t, "chat.error", i+1)
		var payload struct {
			Code     string
			ClientID string            `json:"client_id"`
			Fields   map[string]string `json:"fields"`
		}
		json.Unmarshal(frames[i].Payload, &payload)
		if payload.Code != c.code || payload.ClientID != c.echo {
			t.Fatalf("%s: %s", c.name, frames[i].Payload)
		}
		if c.field != "" && payload.Fields[c.field] == "" {
			t.Fatalf("%s: field %s missing in %s", c.name, c.field, frames[i].Payload)
		}
		if c.field == "" && len(payload.Fields) != 0 {
			t.Fatalf("%s: unexpected fields %s", c.name, frames[i].Payload)
		}
		if strings.Contains(string(frames[i].Payload), "Chess") {
			t.Fatalf("%s: error disclosed group details: %s", c.name, frames[i].Payload)
		}
	}
	p.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":`))
	p.waitFor(t, "chat.error", len(cases)+1)
	w.quiesce()
	if after := dmSnapshot(t, w.conn); !equalSnapshots(before, after) {
		t.Fatal("a rejected frame changed state")
	}
	for id, other := range w.probes {
		if id != 2 && len(other.of("group.message", "chat.error", "chat.ack")) != 0 {
			t.Fatalf("user %d saw frames from rejected sends", id)
		}
	}
	// The connection survives bad frames and a good one still works.
	p.send(t, good(nil))
	p.waitFor(t, "chat.ack", 1)
	// Ownership comes from the session, never from the payload.
	var sender int
	if err := w.conn.QueryRow(`SELECT sender_id FROM group_messages WHERE client_id=?`, nonceA).Scan(&sender); err != nil || sender != 2 {
		t.Fatalf("sender %d %v", sender, err)
	}
	// A frame over 16 KiB closes the socket and changes nothing.
	frame := `{"type":"group.send","payload":{"body":"` + strings.Repeat("x", socketOversize) + `"}}`
	other := w.probes[1]
	other.conn.WriteMessage(websocket.TextMessage, []byte(frame))
	select {
	case <-other.done:
	case <-time.After(5 * time.Second):
		t.Fatal("oversize frame left the socket open")
	}
	if w.count(t, `SELECT COUNT(*) FROM group_messages`) != 3 {
		t.Fatal("oversize frame changed state")
	}
}

const socketOversize = 16385

/*---------------------------------------------------------------------------
  departure, readmission, reconnect and cursors
---------------------------------------------------------------------------*/

func TestGroupChatDepartureHidesTheRoomAndReadmissionRestoresIt(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	if rec, _ := w.roomSend(t, 2, 102, 10, nonceA, "mine"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceB, "theirs"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[2].waitFor(t, "group.message", 2)
	if out := w.apply(t, dmFixtureAction{Op: "remove", User: 2, Group: 10}); out.status != 204 {
		t.Fatalf("remove %d", out.status)
	}
	// Leaving hides every route, even for their own messages, and empties their counts.
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/v1/groups/10/messages"}, {"POST", "/api/v1/groups/10/messages"}, {"PUT", "/api/v1/groups/10/messages/read"},
	} {
		var body any
		switch c.method {
		case "POST":
			body = map[string]any{"membership_id": 102, "client_id": nonceC, "body": "x"}
		case "PUT":
			body = map[string]any{"membership_id": 102, "through_id": 803}
		}
		if rec, _ := w.as(t, 2, c.method, c.path, body); rec.Code != 404 {
			t.Fatalf("%s %s after departure: %d", c.method, c.path, rec.Code)
		}
	}
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats", nil); len(env["data"].([]any)) != 0 {
		t.Fatal("departed member still lists the room")
	}
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatal("departed member still has an unread count")
	}
	// New traffic no longer reaches them; contributions stay for the members.
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceC, "after"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[1].waitFor(t, "group.message", 3)
	w.quiesce()
	if n := len(w.probes[2].of("group.message")); n != 2 {
		t.Fatalf("departed member received %d frames, want only the 2 from before", n)
	}
	if _, h := w.as(t, 1, "GET", "/api/v1/groups/10/messages", nil); len(dataOf(h)["messages"].([]any)) != 5 {
		t.Fatal("departure removed contributions")
	}
	// Readmission is a new generation: the whole room is readable, with no backlog.
	admitted := w.apply(t, dmFixtureAction{Op: "admit", User: 2, Group: 10})
	if admitted.membership == 0 || admitted.membership == 102 {
		t.Fatalf("readmission reused generation %d", admitted.membership)
	}
	if _, h := w.as(t, 2, "GET", "/api/v1/groups/10/messages", nil); len(dataOf(h)["messages"].([]any)) != 5 {
		t.Fatal("readmission did not restore the room's history")
	}
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatal("readmission counted the backlog as unread")
	}
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats", nil); env["data"].([]any)[0].(map[string]any)["membership_id"].(float64) != float64(admitted.membership) {
		t.Fatal("room summary names the old generation")
	}
	if rec, _ := w.roomSend(t, 2, 102, 10, nonceC, "old"); rec.Code != 409 {
		t.Fatalf("old generation after readmission %d", rec.Code)
	}
	// Delivery resumes, once, for the new generation; nothing queued before is replayed.
	if rec, _ := w.roomSend(t, 1, 101, 10, "dddddddd-1111-4111-8111-111111111111", "welcome back"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[2].waitFor(t, "group.message", 3)
	w.quiesce()
	if n := len(w.probes[2].of("group.message")); n != 3 {
		t.Fatalf("readmitted member received %d frames, want 2 old plus 1 new", n)
	}
}

// A departure racing continuous traffic from both sides: nothing is committed for
// the removed member after the removal returned, and nothing newer than the
// removal ever reaches their socket.
func TestGroupChatConcurrentRemovalVersusSend(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	for round := 0; round < 5; round++ {
		w := newDMWorld(t, pack, nil)
		var removed atomic.Bool
		var wg sync.WaitGroup
		var late atomic.Int32
		var stored201 atomic.Int32
		wg.Add(2)
		go func() { // the remaining member keeps talking
			defer wg.Done()
			for n := 0; n < 30; n++ {
				w.as(t, 1, "POST", "/api/v1/groups/10/messages", map[string]any{"membership_id": 101, "client_id": fmt.Sprintf("%08d-1111-4111-8111-111111111111", 1000+n), "body": "talk"})
			}
		}()
		go func() { // the member being removed keeps talking too
			defer wg.Done()
			for n := 0; n < 30; n++ {
				after := removed.Load()
				rec, _ := w.as(t, 2, "POST", "/api/v1/groups/10/messages", map[string]any{"membership_id": 102, "client_id": fmt.Sprintf("%08d-1111-4111-8111-111111111111", 2000+n), "body": "talk"})
				switch rec.Code {
				case 201:
					stored201.Add(1)
					if after {
						late.Add(1) // started after the removal returned, yet committed
					}
				case 404:
				default:
					t.Errorf("send %d %s", rec.Code, rec.Body)
				}
			}
		}()
		time.Sleep(time.Duration(5+round*3) * time.Millisecond)
		rec, _ := w.as(t, 1, "DELETE", "/api/v1/group-memberships/102", nil)
		if rec.Code != 204 {
			t.Fatalf("removal %d", rec.Code)
		}
		var cutoff int64
		w.conn.QueryRow(`SELECT COALESCE(MAX(id),0) FROM group_messages`).Scan(&cutoff)
		removed.Store(true)
		wg.Wait()
		w.quiesce()
		if late.Load() != 0 {
			t.Fatalf("round %d: %d messages committed after the removal returned", round, late.Load())
		}
		if got := w.count(t, `SELECT COUNT(*) FROM group_messages WHERE sender_id=2 AND id>802`); int32(got) != stored201.Load() {
			t.Fatalf("round %d: %d stored for the removed member, %d acknowledged", round, got, stored201.Load())
		}
		for _, id := range frameIDs(w.probes[2].of("group.message")) {
			if id > cutoff {
				t.Fatalf("round %d: message %d, newer than the removal at %d, reached the removed member", round, id, cutoff)
			}
		}
		if rec, _ := w.roomSend(t, 2, 102, 10, "ffffffff-1111-4111-8111-111111111111", "late"); rec.Code != 404 {
			t.Fatalf("round %d: send after removal %d", round, rec.Code)
		}
	}
}

func TestGroupChatConcurrentDuplicateSendsCommitOnce(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec, _ := w.roomSend(t, 2, 102, 10, nonceA, "once")
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		switch c {
		case 201:
			created++
		case 200:
		default:
			t.Fatalf("status %d", c)
		}
	}
	w.probes[1].waitFor(t, "group.message", 1)
	w.quiesce()
	if created != 1 || w.count(t, `SELECT COUNT(*) FROM group_messages WHERE client_id=?`, nonceA) != 1 || len(w.probes[1].of("group.message")) != 1 {
		t.Fatalf("%d creations, %d rows, %d fanouts; want one of each", created, w.count(t, `SELECT COUNT(*) FROM group_messages`), len(w.probes[1].of("group.message")))
	}
}

func TestGroupChatReconnectRefetchRecoversMissedMessagesWithoutReplay(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	w.probes[2].conn.Close()
	<-w.probes[2].done
	for deadline := time.Now().Add(3 * time.Second); w.hub.IsUserOnline(2) && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	for i, nonce := range []string{nonceA, nonceB, nonceC} {
		if rec, _ := w.roomSend(t, 1, 101, 10, nonce, fmt.Sprintf("while away %d", i)); rec.Code != 201 {
			t.Fatalf("send %d", rec.Code)
		}
	}
	back := openDM(t, w.srv, "b18-fixture-2")
	w.quiesce()
	if n := len(back.of("group.message", "chat.ack", "chat.read")); n != 0 {
		t.Fatalf("reconnect replayed %d frames", n)
	}
	// Recovery is a refetch of summaries, totals and history, not a socket replay.
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 4 {
		t.Fatalf("unread after reconnect: %v", env)
	}
	_, env := w.as(t, 2, "GET", "/api/v1/group-chats", nil)
	room := env["data"].([]any)[0].(map[string]any)
	if room["unread_count"].(float64) != 4 || room["last_message"].(map[string]any)["id"].(float64) != 805 {
		t.Fatalf("room summary %v", room)
	}
	// Newest first, then page backwards until the last known ID is reached.
	_, newest := w.as(t, 2, "GET", "/api/v1/groups/10/messages?limit=2", nil)
	d := dataOf(newest)
	if ids := messageIDs(d); !reflect.DeepEqual(ids, []float64{804, 805}) || d["has_more"] != true || d["next_before_id"].(float64) != 804 {
		t.Fatalf("newest page %v", d)
	}
	_, older := w.as(t, 2, "GET", "/api/v1/groups/10/messages?limit=2&before_id=804", nil)
	if ids := messageIDs(dataOf(older)); !reflect.DeepEqual(ids, []float64{802, 803}) {
		t.Fatalf("older page %v", dataOf(older))
	}
	// New traffic is live again on the new socket.
	if rec, _ := w.roomSend(t, 1, 101, 10, "dddddddd-1111-4111-8111-111111111111", "live"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	back.waitFor(t, "group.message", 1)
}

func messageIDs(data map[string]any) []float64 {
	out := []float64{}
	for _, m := range data["messages"].([]any) {
		out = append(out, m.(map[string]any)["id"].(float64))
	}
	return out
}

func TestGroupChatCursorsAcrossSessionsAndRestartStaySeparateFromNotices(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	second := w.session(t, 2)
	noticesBefore := w.count(t, `SELECT COUNT(*) FROM notifications`)
	noticeUnread := func() int {
		page, err := db.ListSocialNotifications(context.Background(), w.conn, 2, 1, 20)
		if err != nil {
			t.Fatal(err)
		}
		return page.UnreadCount
	}
	noticesUnread := noticeUnread()
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceA, "new one"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[2].waitFor(t, "group.message", 1)
	second.waitFor(t, "group.message", 1)
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 2 {
		t.Fatalf("unread %v", env)
	}
	// Fetching, receiving and sending never mark read.
	if noticeUnread() != noticesUnread || w.count(t, `SELECT COUNT(*) FROM notifications`) != noticesBefore {
		t.Fatal("room traffic touched notifications")
	}
	read := func(through int64) (*httptest.ResponseRecorder, map[string]any) {
		return w.as(t, 2, "PUT", "/api/v1/groups/10/messages/read", map[string]any{"membership_id": 102, "through_id": through})
	}
	rec, env := read(803)
	if rec.Code != 200 || dataOf(env)["through_id"].(float64) != 803 || dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatalf("mark read %d %s", rec.Code, rec.Body)
	}
	// Every session of the reader hears about it; nobody else does.
	w.probes[2].waitFor(t, "chat.read", 1)
	second.waitFor(t, "chat.read", 1)
	w.quiesce()
	for id, p := range w.probes {
		if id != 2 && len(p.of("chat.read")) != 0 {
			t.Fatalf("user %d saw another member's read cursor", id)
		}
	}
	// Idempotent and monotonic: repeats and older IDs change nothing and say nothing.
	for _, through := range []int64{803, 802, 0} {
		if rec, env := read(through); rec.Code != 200 || dataOf(env)["through_id"].(float64) != 803 {
			t.Fatalf("read %d: %d %s", through, rec.Code, rec.Body)
		}
	}
	w.quiesce()
	if len(w.probes[2].of("chat.read")) != 1 || len(second.of("chat.read")) != 1 {
		t.Fatal("a no-op mark-read was broadcast")
	}
	// Invalid IDs: another room's, a future one, a different pair's.
	for _, through := range []int64{804, 502, 9007199254740991} {
		rec, _ := read(through)
		if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"through_id":"INVALID_ID"`) {
			t.Fatalf("read %d: %d %s", through, rec.Code, rec.Body)
		}
	}
	// The cursor is persisted per member and survives a restart; other members' differ.
	w.restart(t)
	_, rooms := w.as(t, 2, "GET", "/api/v1/group-chats", nil)
	if room := rooms["data"].([]any)[0].(map[string]any); room["read_through_id"].(float64) != 803 || room["unread_count"].(float64) != 0 {
		t.Fatalf("cursor after restart %v", room)
	}
	_, creator := w.as(t, 1, "GET", "/api/v1/group-chats", nil)
	if creator["data"].([]any)[0].(map[string]any)["read_through_id"].(float64) != 801 {
		t.Fatalf("another member's cursor moved: %v", creator)
	}
	// A message committed after the cursor stays unread whatever order things ran in.
	if rec, _ := w.roomSend(t, 1, 101, 10, nonceB, "later"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	if rec, env := read(803); rec.Code != 200 || dataOf(env)["unread_count"].(float64) != 1 {
		t.Fatalf("old through_id after a new commit %d %s", rec.Code, rec.Body)
	}
	if noticeUnread() != noticesUnread || w.count(t, `SELECT COUNT(*) FROM notifications`) != noticesBefore {
		t.Fatal("cursor changes touched notifications")
	}
	// Notification reads never move the message cursor either.
	if rec, _ := w.as(t, 2, "PATCH", "/api/v1/notifications/read-all", nil); rec.Code >= 500 {
		t.Fatalf("notification read-all %d", rec.Code)
	}
	if _, env := w.as(t, 2, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 1 {
		t.Fatal("a notification read changed the message count")
	}
}

/*---------------------------------------------------------------------------
  shapes, validation and routes
---------------------------------------------------------------------------*/

func TestGroupChatPrivateAuthorsExposeNoExtraFields(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	// User 2's profile is private; the creator (who does not follow them) reads their message.
	if rec, _ := w.roomSend(t, 2, 102, 10, nonceA, "from a private profile"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[1].waitFor(t, "group.message", 1)
	keys := func(raw []byte) []string {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	message := []string{"body", "client_id", "created_at", "group_id", "id", "sender_id", "sender_username"}
	if got := keys(w.probes[1].of("group.message")[0].Payload); !reflect.DeepEqual(got, message) {
		t.Fatalf("frame keys %v", got)
	}
	_, env := w.as(t, 1, "GET", "/api/v1/groups/10/messages", nil)
	for _, m := range dataOf(env)["messages"].([]any) {
		got := []string{}
		for k := range m.(map[string]any) {
			got = append(got, k)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, message) {
			t.Fatalf("history keys %v", got)
		}
	}
	_, rooms := w.as(t, 1, "GET", "/api/v1/group-chats", nil)
	room := rooms["data"].([]any)[0].(map[string]any)
	got := []string{}
	for k := range room {
		got = append(got, k)
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, []string{"group", "last_message", "membership_id", "read_through_id", "unread_count"}) {
		t.Fatalf("room keys %v", got)
	}
	// Attribution is the retained author; an inactive author becomes unavailable.
	fixtureExec(t, w.conn, `UPDATE users SET is_active=0 WHERE id=2`)
	_, env = w.as(t, 1, "GET", "/api/v1/groups/10/messages", nil)
	for _, m := range dataOf(env)["messages"].([]any) {
		if m.(map[string]any)["sender_id"].(float64) == 2 && m.(map[string]any)["sender_username"] != "Unavailable account" {
			t.Fatalf("inactive author shown as %v", m)
		}
	}
}

func TestGroupChatQueryBodyAndRouteValidation(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, nil)
	before := dmSnapshot(t, w.conn)
	for _, path := range []string{
		"/api/v1/groups/10/messages?limit=0", "/api/v1/groups/10/messages?limit=51", "/api/v1/groups/10/messages?limit=1.5",
		"/api/v1/groups/10/messages?before_id=0", "/api/v1/groups/10/messages?before_id=abc", "/api/v1/groups/10/messages?before_id=9007199254740992",
		"/api/v1/groups/10/messages?before_id=1&before_id=2", "/api/v1/groups/10/messages?page=1", "/api/v1/groups/10/messages?foo=1",
		"/api/v1/group-chats?page=0", "/api/v1/group-chats?per_page=51", "/api/v1/group-chats?before_id=1", "/api/v1/group-chats/unread?x=1",
		"/api/v1/groups/abc/messages", "/api/v1/groups/0/messages", "/api/v1/groups/9007199254740992/messages",
	} {
		if rec, _ := w.as(t, 2, "GET", path, nil); rec.Code != 400 {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body)
		}
	}
	actor := int64(2)
	post := func(raw string, contentType string) *httptest.ResponseRecorder {
		r := dmFixtureRequest{Actor: &actor, Method: "POST", Path: "/api/v1/groups/10/messages", RawJSON: &raw, ContentType: contentType}
		return w.do(t, r)
	}
	for name, c := range map[string]struct {
		raw, contentType string
		status           int
	}{
		"duplicate key":     {`{"membership_id":102,"client_id":"` + nonceA + `","body":"a","body":"b"}`, "", 400},
		"trailing data":     {`{"membership_id":102,"client_id":"` + nonceA + `","body":"a"} {}`, "", 400},
		"null body":         {`{"membership_id":102,"client_id":"` + nonceA + `","body":null}`, "", 400},
		"numeric body":      {`{"membership_id":102,"client_id":"` + nonceA + `","body":5}`, "", 400},
		"float membership":  {`{"membership_id":102.5,"client_id":"` + nonceA + `","body":"a"}`, "", 400},
		"string membership": {`{"membership_id":"102","client_id":"` + nonceA + `","body":"a"}`, "", 400},
		"lone surrogate":    {`{"membership_id":102,"client_id":"` + nonceA + `","body":"\ud800"}`, "", 400},
		"array":             {`[]`, "", 400},
		"form content":      {`{}`, "application/x-www-form-urlencoded", 415},
		"oversize":          {`{"body":"` + strings.Repeat("x", 17<<10) + `"}`, "", 413},
	} {
		if rec := post(c.raw, c.contentType); rec.Code != c.status {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body)
		}
	}
	w.quiesce()
	if after := dmSnapshot(t, w.conn); !equalSnapshots(before, after) {
		t.Fatal("a rejected request changed state")
	}
	// Method lists are exact and come before the origin check.
	for _, c := range []struct{ method, path, allow string }{
		{"POST", "/api/v1/group-chats", "GET"}, {"DELETE", "/api/v1/group-chats/unread", "GET"},
		{"PUT", "/api/v1/groups/10/messages", "GET, POST"}, {"GET", "/api/v1/groups/10/messages/read", "PUT"},
		{"POST", "/api/v1/groups/10/messages/read", "PUT"},
	} {
		origin := "https://evil.test"
		rec := w.do(t, dmFixtureRequest{Actor: &actor, Method: c.method, Path: c.path, Origin: &origin})
		if rec.Code != 405 || rec.Header().Get("Allow") != c.allow {
			t.Fatalf("%s %s: %d Allow %q", c.method, c.path, rec.Code, rec.Header().Get("Allow"))
		}
	}
	// Writes need the same origin and header discipline as every other write.
	origin := "https://evil.test"
	if rec := w.do(t, dmFixtureRequest{Actor: &actor, Method: "POST", Path: "/api/v1/groups/10/messages", JSON: rawJSON(t, map[string]any{"membership_id": 102, "client_id": nonceA, "body": "x"}), Origin: &origin}); rec.Code != 403 {
		t.Fatalf("foreign origin %d", rec.Code)
	}
	no := false
	if rec := w.do(t, dmFixtureRequest{Actor: &actor, Method: "PUT", Path: "/api/v1/groups/10/messages/read", JSON: rawJSON(t, map[string]any{"membership_id": 102, "through_id": 0}), XHR: &no}); rec.Code != 403 {
		t.Fatalf("missing XHR header %d", rec.Code)
	}
	// Anonymous callers get 401 on every route.
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/v1/group-chats"}, {"GET", "/api/v1/group-chats/unread"}, {"GET", "/api/v1/groups/10/messages"},
	} {
		rec := w.do(t, dmFixtureRequest{Method: c.method, Path: c.path})
		if rec.Code != 401 {
			t.Fatalf("%s %s anonymous: %d", c.method, c.path, rec.Code)
		}
	}
}

// A real journey through the public API on a freshly registered service: creating a
// group opens its room immediately, admission starts the member at the latest
// message, and leaving and returning follow the generation rules.
func TestGroupChatRealJourneyFromGroupCreationToReadmission(t *testing.T) {
	requireLocalTCPListener(t)
	handler, conn, hub := socialAPIWithHub(t)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Cleanup(func() { drainHub(hub) })
	alice := registerSocialUser(t, handler, "alice@example.com")
	bob := registerSocialUser(t, handler, "bob@example.com")
	call := func(token, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		var raw []byte
		contentType := ""
		if body != nil {
			raw, _ = json.Marshal(body)
			contentType = "application/json"
		}
		rec := socialRequest(t, handler, method, path, contentType, raw, token)
		var envelope map[string]any
		json.Unmarshal(rec.Body.Bytes(), &envelope)
		return rec, envelope
	}
	rec, env := call(alice, "POST", "/api/v1/groups", map[string]any{"title": "Fresh", "description": "New group"})
	if rec.Code != 201 {
		t.Fatalf("create group %d %s", rec.Code, rec.Body)
	}
	group := int(dataOf(env)["id"].(float64))
	room := fmt.Sprintf("/api/v1/groups/%d/messages", group)
	membership := func(user string) int64 {
		var id int64
		if err := conn.QueryRow(`SELECT m.id FROM group_memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND u.email=?`, group, user).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	aliceGen := membership("alice@example.com")
	_, rooms := call(alice, "GET", "/api/v1/group-chats", nil)
	first := rooms["data"].([]any)[0].(map[string]any)
	if first["last_message"] != nil || first["unread_count"].(float64) != 0 || first["membership_id"].(float64) != float64(aliceGen) {
		t.Fatalf("empty room summary %v", first)
	}
	if rec, _ := call(alice, "POST", room, map[string]any{"membership_id": aliceGen, "client_id": nonceA, "body": "before bob"}); rec.Code != 201 {
		t.Fatalf("first message %d %s", rec.Code, rec.Body)
	}
	// Bob asks to join and the creator accepts: a new generation that starts caught up.
	if rec, _ := call(bob, "GET", room, nil); rec.Code != 404 {
		t.Fatalf("outsider read %d", rec.Code)
	}
	rec, env = call(bob, "POST", fmt.Sprintf("/api/v1/groups/%d/join-requests", group), nil)
	if rec.Code != 201 {
		t.Fatalf("join request %d %s", rec.Code, rec.Body)
	}
	rec, env = call(alice, "PATCH", fmt.Sprintf("/api/v1/group-join-requests/%d", int(dataOf(env)["id"].(float64))), map[string]any{"decision": "accept"})
	if rec.Code != 200 {
		t.Fatalf("accept %d %s", rec.Code, rec.Body)
	}
	bobGen := membership("bob@example.com")
	if _, h := call(bob, "GET", room, nil); len(dataOf(h)["messages"].([]any)) != 1 {
		t.Fatal("a new member cannot read the room's history")
	}
	if _, env := call(bob, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatal("admission counted the backlog as unread")
	}
	pa, pb := openDM(t, srv, alice), openDM(t, srv, bob)
	if rec, _ := call(alice, "POST", room, map[string]any{"membership_id": aliceGen, "client_id": nonceB, "body": "hello bob"}); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	pa.waitFor(t, "group.message", 1)
	pb.waitFor(t, "group.message", 1)
	if _, env := call(bob, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 1 {
		t.Fatal("a new message after admission is not unread")
	}
	if rec, env := call(bob, "PUT", room+"/read", map[string]any{"membership_id": bobGen, "through_id": 2}); rec.Code != 200 || dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatalf("mark read %d %s", rec.Code, rec.Body)
	}
	// Bob leaves; the room is gone for him while his and the creator's messages stay.
	if rec, _ := call(bob, "POST", room, map[string]any{"membership_id": bobGen, "client_id": nonceC, "body": "bye"}); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	pa.waitFor(t, "group.message", 2)
	if rec, _ := call(bob, "DELETE", fmt.Sprintf("/api/v1/group-memberships/%d", bobGen), nil); rec.Code != 204 {
		t.Fatalf("leave %d", rec.Code)
	}
	if rec, _ := call(bob, "GET", room, nil); rec.Code != 404 {
		t.Fatalf("history after leaving %d", rec.Code)
	}
	if rec, _ := call(alice, "POST", room, map[string]any{"membership_id": aliceGen, "client_id": "dddddddd-1111-4111-8111-111111111111", "body": "alone"}); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	pa.waitFor(t, "group.message", 3)
	time.Sleep(120 * time.Millisecond)
	if n := len(pb.of("group.message")); n != 2 {
		t.Fatalf("a former member received %d frames, want the 2 sent while a member", n)
	}
	// Returning is a new generation with the whole room readable and nothing unread.
	rec, env = call(bob, "POST", fmt.Sprintf("/api/v1/groups/%d/join-requests", group), nil)
	if rec.Code != 201 {
		t.Fatalf("second join request %d %s", rec.Code, rec.Body)
	}
	if rec, _ := call(alice, "PATCH", fmt.Sprintf("/api/v1/group-join-requests/%d", int(dataOf(env)["id"].(float64))), map[string]any{"decision": "accept"}); rec.Code != 200 {
		t.Fatalf("second accept %d", rec.Code)
	}
	if again := membership("bob@example.com"); again == bobGen {
		t.Fatal("readmission reused the generation")
	}
	if _, h := call(bob, "GET", room, nil); len(dataOf(h)["messages"].([]any)) != 4 {
		t.Fatal("readmission did not restore the whole room")
	}
	if _, env := call(bob, "GET", "/api/v1/group-chats/unread", nil); dataOf(env)["unread_count"].(float64) != 0 {
		t.Fatal("readmission counted the backlog as unread")
	}
	if rec, _ := call(bob, "POST", room, map[string]any{"membership_id": bobGen, "client_id": "eeeeeeee-1111-4111-8111-111111111111", "body": "old"}); rec.Code != 409 {
		t.Fatalf("old generation %d", rec.Code)
	}
}
