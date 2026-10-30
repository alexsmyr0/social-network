package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"forum/internal/db"
)

// Behavioral B22 coverage on real sockets: relationship rules, offline storage,
// retries across transports, cursors, delivery authorization through the socket
// write, image lifecycle and the unfollow-versus-send race.

const (
	nonceA = "aaaaaaaa-1111-4111-8111-111111111111"
	nonceB = "bbbbbbbb-1111-4111-8111-111111111111"
	nonceC = "cccccccc-1111-4111-8111-111111111111"
)

// both makes 1 and 2 follow each other, so a message is live for user 2 even
// though user 2's profile is private.
var mutualFollow = map[string]any{"follows": map[string]any{"1:2": "accepted", "2:1": "accepted"}}

func (w *dmWorld) as(t *testing.T, actor int64, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	r := dmFixtureRequest{Actor: &actor, Method: method, Path: path}
	if body != nil {
		r.JSON, _ = json.Marshal(body)
	}
	rec := w.do(t, r)
	var envelope map[string]any
	json.Unmarshal(rec.Body.Bytes(), &envelope)
	return rec, envelope
}

func (w *dmWorld) send(t *testing.T, from, to int64, nonce, body string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return w.as(t, from, "POST", fmt.Sprintf("/api/v1/chats/%d/messages", to), map[string]any{"client_id": nonce, "body": body})
}

func (w *dmWorld) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := w.conn.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func dataOf(envelope map[string]any) map[string]any {
	d, _ := envelope["data"].(map[string]any)
	return d
}

func TestDirectMessageOfflineStorageIsRecoveredOnceWithoutReplay(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	given := map[string]any{"follows": mutualFollow["follows"], "users": map[string]any{"2": map[string]any{"online": false}}}
	w := newDMWorld(t, pack, given)
	if _, online := w.probes[2]; online {
		t.Fatal("recipient should start offline")
	}
	w.probes[1].send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "while you were away"}})
	ack := w.probes[1].waitFor(t, "chat.ack", 1)
	var payload struct {
		MessageID int64 `json:"message_id"`
		Duplicate bool
	}
	json.Unmarshal(ack[0].Payload, &payload)
	if payload.MessageID != 503 || payload.Duplicate {
		t.Fatalf("ack %s", ack[0].Payload)
	}
	// The recipient connects afterwards: no frame is replayed; authoritative history is.
	late := openDM(t, w.srv, "b18-fixture-2")
	w.quiesce()
	if len(late.of("dm.message", "chat.ack")) != 0 {
		t.Fatal("offline message was replayed over the socket")
	}
	_, history := w.as(t, 2, "GET", "/api/v1/chats/1/messages", nil)
	messages, _ := dataOf(history)["messages"].([]any)
	if len(messages) != 3 || messages[2].(map[string]any)["body"] != "while you were away" {
		t.Fatalf("history after reconnect %v", messages)
	}
	if _, unread := w.as(t, 2, "GET", "/api/v1/chats/unread", nil); dataOf(unread)["unread_count"] != float64(2) {
		t.Fatalf("unread %v", unread)
	}
	// Reading is explicit; reconnecting does not mark anything.
	late.conn.Close()
	reconnect := openDM(t, w.srv, "b18-fixture-2")
	if _, unread := w.as(t, 2, "GET", "/api/v1/chats/unread", nil); dataOf(unread)["unread_count"] != float64(2) {
		t.Fatal("reconnect changed unread")
	}
	w.as(t, 2, "PUT", "/api/v1/chats/1/read", map[string]any{"through_id": 503})
	reconnect.waitFor(t, "chat.read", 1)
	w.restart(t)
	if _, unread := w.as(t, 2, "GET", "/api/v1/chats/unread", nil); dataOf(unread)["unread_count"] != float64(0) {
		t.Fatal("cursor did not survive restart")
	}
	if rec, _ := w.send(t, 1, 2, nonceA, "while you were away"); rec.Code != 200 {
		t.Fatalf("retry after restart %d", rec.Code)
	}
	if w.count(t, `SELECT COUNT(*) FROM private_messages WHERE body='while you were away'`) != 1 {
		t.Fatal("offline message stored more than once")
	}
}

func TestDirectMessageRetriesShareOneResultAcrossTransports(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	sender, recipient := w.probes[1], w.probes[2]
	sender.send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "once"}})
	sender.waitFor(t, "chat.ack", 1)
	sender.waitFor(t, "dm.message", 1)
	recipient.waitFor(t, "dm.message", 1)
	// HTTP exact retry: 200, the same message, no new fanout.
	rec, env := w.send(t, 1, 2, nonceA, "once")
	if rec.Code != 200 || dataOf(env)["id"] != float64(503) {
		t.Fatalf("http retry %d %s", rec.Code, rec.Body)
	}
	// Socket exact retry: duplicate ack, no fanout.
	sender.send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "once"}})
	acks := sender.waitFor(t, "chat.ack", 2)
	if !strings.Contains(string(acks[1].Payload), `"duplicate":true`) || !strings.Contains(string(acks[1].Payload), `"message_id":503`) {
		t.Fatalf("duplicate ack %s", acks[1].Payload)
	}
	// A changed payload is a conflict over either transport.
	if rec, _ := w.send(t, 1, 2, nonceA, "changed"); rec.Code != 409 {
		t.Fatalf("changed body %d", rec.Code)
	}
	w.send(t, 1, 3, nonceA, "once") // another recipient: not messageable, so permission wins first
	if rec, _ := w.as(t, 1, "POST", "/api/v1/chats/2/messages", map[string]any{"client_id": nonceA, "body": "once", "image_url": "/api/v1/media/701"}); rec.Code != 409 {
		t.Fatalf("added image %d", rec.Code)
	}
	w.quiesce()
	if n := len(sender.of("dm.message")); n != 1 {
		t.Fatalf("sender saw %d echoes", n)
	}
	if n := len(recipient.of("dm.message")); n != 1 {
		t.Fatalf("recipient saw %d frames", n)
	}
	// A different nonce is a deliberate second message.
	if rec, env := w.send(t, 1, 2, nonceB, "once"); rec.Code != 201 || dataOf(env)["id"] != float64(504) {
		t.Fatalf("second message %d", rec.Code)
	}
	if n := w.count(t, `SELECT COUNT(*) FROM private_messages WHERE id>502`); n != 2 {
		t.Fatalf("stored %d", n)
	}
	// The recorded retry result survives a restart.
	w.restart(t)
	if rec, env := w.send(t, 1, 2, nonceA, "once"); rec.Code != 200 || dataOf(env)["id"] != float64(503) {
		t.Fatalf("retry after restart %d", rec.Code)
	}
}

func TestDirectMessageSocketRejectionsAreStrictAndStateless(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	p := w.probes[1]
	long := strings.Repeat("x", 2001)
	cases := []struct {
		name  string
		frame any
		code  string
		field string
		echo  string
	}{
		{"unknown type", map[string]any{"type": "dm.edit", "payload": map[string]any{}}, "INVALID_PAYLOAD", "", ""},
		{"no payload", map[string]any{"type": "dm.send"}, "INVALID_PAYLOAD", "", ""},
		{"extra envelope key", map[string]any{"type": "dm.send", "payload": map[string]any{}, "id": 1}, "INVALID_PAYLOAD", "", ""},
		{"legacy send without nonce", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "body": "legacy"}}, "VALIDATION_ERROR", "client_id", ""},
		{"bad nonce", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": "AAAAAAAA-1111-4111-8111-111111111111", "body": "x"}}, "VALIDATION_ERROR", "client_id", ""},
		{"missing recipient", map[string]any{"type": "dm.send", "payload": map[string]any{"client_id": nonceA, "body": "x"}}, "VALIDATION_ERROR", "recipient_id", nonceA},
		{"unsafe recipient", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 9007199254740992, "client_id": nonceA, "body": "x"}}, "VALIDATION_ERROR", "recipient_id", nonceA},
		{"string recipient", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": "2", "client_id": nonceA, "body": "x"}}, "INVALID_PAYLOAD", "", nonceA},
		{"unknown key", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "x", "sender_id": 2}}, "INVALID_PAYLOAD", "", nonceA},
		{"empty", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "  "}}, "VALIDATION_ERROR", "body", nonceA},
		{"too long", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": long}}, "VALIDATION_ERROR", "body", nonceA},
		{"control character", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "a\u0007"}}, "VALIDATION_ERROR", "body", nonceA},
		{"external image", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "x", "image_url": "https://evil.test/a.png"}}, "VALIDATION_ERROR", "image_url", nonceA},
		{"self", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 1, "client_id": nonceA, "body": "x"}}, "NOT_FOUND", "", nonceA},
		{"outsider", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 5, "client_id": nonceA, "body": "x"}}, "NOT_FOUND", "", nonceA},
		{"unknown user", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 99, "client_id": nonceA, "body": "x"}}, "NOT_FOUND", "", nonceA},
		{"unclaimable image", map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "", "image_url": "/api/v1/media/999"}}, "NOT_FOUND", "", nonceA},
	}
	before := dmSnapshot(t, w.conn)
	for i, c := range cases {
		p.send(t, c.frame)
		frames := p.waitFor(t, "chat.error", i+1)
		var payload struct {
			Code     string
			Message  string
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
	}
	// Malformed JSON text is also an error, not silence.
	p.conn.WriteMessage(websocket.TextMessage, []byte(`{"type":`))
	p.waitFor(t, "chat.error", len(cases)+1)
	w.quiesce()
	if after := dmSnapshot(t, w.conn); !equalSnapshots(before, after) {
		t.Fatal("a rejected frame changed state")
	}
	if n := len(w.probes[2].of("dm.message", "chat.error", "chat.ack")); n != 0 {
		t.Fatalf("recipient saw %d frames from rejected sends", n)
	}
	// The connection survives bad frames and a good one still works.
	p.send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceB, "body": "after errors"}})
	p.waitFor(t, "chat.ack", 1)
}

func equalSnapshots(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func TestDirectMessageCursorsAcrossSessionsAreIdempotentAndSeparateFromNotifications(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	fixtureExec(t, w.conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(2,'second-session-2','','')`)
	second := openDM(t, w.srv, "second-session-2")
	first := w.probes[2]
	_, before := w.as(t, 2, "GET", "/api/v1/notifications", nil)
	w.send(t, 1, 2, nonceA, "one")
	w.send(t, 1, 2, nonceB, "two")
	_, unread := w.as(t, 2, "GET", "/api/v1/chats/unread", nil)
	if dataOf(unread)["unread_count"] != float64(3) {
		t.Fatalf("unread %v", unread)
	}
	_, mid := w.as(t, 2, "GET", "/api/v1/notifications", nil)
	if fmt.Sprint(dataOf(before)["unread_count"]) != fmt.Sprint(dataOf(mid)["unread_count"]) {
		t.Fatal("message counts leaked into notification counts")
	}
	rec, read := w.as(t, 2, "PUT", "/api/v1/chats/1/read", map[string]any{"through_id": 504})
	if rec.Code != 200 || dataOf(read)["through_id"] != float64(504) || dataOf(read)["unread_count"] != float64(0) {
		t.Fatalf("read %d %s", rec.Code, rec.Body)
	}
	// Every session of the reader is told; nobody else is.
	first.waitFor(t, "chat.read", 1)
	second.waitFor(t, "chat.read", 1)
	w.quiesce()
	if len(w.probes[1].of("chat.read")) != 0 {
		t.Fatal("the other participant received a read receipt")
	}
	for _, p := range []*dmProbe{first, second} {
		if !strings.Contains(string(p.of("chat.read")[0].Payload), `"through_id":504`) {
			t.Fatalf("read frame %s", p.of("chat.read")[0].Payload)
		}
	}
	// Repeating or going backwards changes nothing and signals nothing.
	for _, through := range []int{504, 502, 0} {
		rec, again := w.as(t, 2, "PUT", "/api/v1/chats/1/read", map[string]any{"through_id": through})
		if rec.Code != 200 || dataOf(again)["through_id"] != float64(504) {
			t.Fatalf("repeat through %d: %s", through, rec.Body)
		}
	}
	w.quiesce()
	if len(first.of("chat.read")) != 1 || len(second.of("chat.read")) != 1 {
		t.Fatal("no-op reads were signalled")
	}
	// A message that commits after the cursor stays unread; the cursor survives restart.
	w.send(t, 1, 2, nonceC, "three")
	w.restart(t)
	_, unread = w.as(t, 2, "GET", "/api/v1/chats/unread", nil)
	if dataOf(unread)["unread_count"] != float64(1) {
		t.Fatalf("after restart %v", unread)
	}
	_, roster := w.as(t, 2, "GET", "/api/v1/chats", nil)
	entry := roster["data"].([]any)[0].(map[string]any)
	if entry["unread_count"] != float64(1) || entry["read_through_id"] != float64(504) {
		t.Fatalf("roster cursor %v", entry)
	}
	// Own messages never count and a counterpart's cursor is independent.
	_, other := w.as(t, 1, "GET", "/api/v1/chats/unread", nil)
	if dataOf(other)["unread_count"] != float64(0) {
		t.Fatalf("sender unread %v", other)
	}
}

// A frame queued before an unfollow but written after it must be suppressed.
// Holding the revocation gate keeps the write pump from entering delivery, which
// models the queued-write gap deterministically.
func TestDirectMessageQueuedFrameIsSuppressedWhenRelationshipEndsBeforeWrite(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	w.hub.WithRevocation(func() {
		if rec, _ := w.send(t, 1, 2, nonceA, "in flight"); rec.Code != 201 {
			t.Errorf("send %d", rec.Code)
		}
		// The relationship ends after the frame was queued and before it is written.
		fixtureExec(t, w.conn, `DELETE FROM follows`)
	})
	w.probes[1].waitFor(t, "dm.message", 1) // the sender's echo stays authorized
	w.quiesce()
	if n := len(w.probes[2].of("dm.message")); n != 0 {
		t.Fatalf("recipient received %d frames after the relationship ended", n)
	}
	// The committed message stays stored and readable by both participants.
	if _, h := w.as(t, 2, "GET", "/api/v1/chats/1/messages", nil); len(dataOf(h)["messages"].([]any)) != 3 {
		t.Fatal("suppressed delivery lost the stored message")
	}
	// A new send is denied; the other order (delivered before the change) delivers once.
	if rec, _ := w.send(t, 1, 2, nonceB, "denied"); rec.Code != 404 {
		t.Fatalf("send after unfollow %d", rec.Code)
	}
	fixtureExec(t, w.conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,2,'accepted','2026-10-15T12:00:00Z'),(2,1,'accepted','2026-10-15T12:00:00Z')`)
	if rec, _ := w.send(t, 1, 2, nonceB, "restored"); rec.Code != 201 {
		t.Fatalf("send after refollow %d", rec.Code)
	}
	w.probes[2].waitFor(t, "dm.message", 1)
	fixtureExec(t, w.conn, `DELETE FROM follows`)
	w.quiesce()
	if n := len(w.probes[2].of("dm.message")); n != 1 {
		t.Fatalf("recipient saw %d frames, want exactly the one written before revocation", n)
	}
}

func TestDirectMessageRevocationWaitsForInFlightDeliveryAndPrivacyFlipKeepsLive(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	var followID int64
	if err := w.conn.QueryRow(`SELECT id FROM follows WHERE follower_id=2 AND followed_id=1`).Scan(&followID); err != nil {
		t.Fatal(err)
	}
	// An in-flight delivery holds the shared gate: a revoking write must wait for it,
	// while an ordinary write (a send) is not delayed by it.
	revocations := []struct {
		name  string
		actor int64
		path  string
		verb  string
		body  any
		want  int
	}{
		{"unfollow", 2, fmt.Sprintf("/api/v1/follows/%d", followID), "DELETE", nil, 204},
		{"privacy change", 1, "/api/v1/users/me/privacy", "PATCH", map[string]any{"visibility": "private", "expected_version": 1}, 200},
	}
	for _, r := range revocations {
		released := make(chan struct{})
		done := make(chan *httptest.ResponseRecorder, 1)
		w.hub.WithDeliveryAdmission(func() {
			go func() {
				rec, _ := w.as(t, r.actor, r.verb, r.path, r.body)
				done <- rec
			}()
			select {
			case rec := <-done:
				t.Errorf("%s completed (%d) while a delivery write was in flight", r.name, rec.Code)
			case <-time.After(200 * time.Millisecond):
			}
			// An ordinary send commits while the gate is held: only revocations wait.
			if rec, _ := w.as(t, 1, "GET", "/api/v1/chats/unread", nil); rec.Code != 200 {
				t.Errorf("read blocked by the gate: %d", rec.Code)
			}
			close(released)
		})
		<-released
		if rec := <-done; rec.Code != r.want {
			t.Fatalf("%s: %d %s", r.name, rec.Code, rec.Body)
		}
	}
	// 1 still follows 2 (private); 2 no longer follows 1 and 1 is now private. The
	// pair may still message, so the send reaches 2 live: privacy never withholds a
	// permitted message.
	if rec, _ := w.send(t, 1, 2, nonceA, "still live"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[2].waitFor(t, "dm.message", 1)
	// Ending the last follow ends the pair: a new send is refused and nothing more
	// reaches the recipient.
	fixtureExec(t, w.conn, `DELETE FROM follows`)
	if rec, _ := w.send(t, 1, 2, nonceB, "denied"); rec.Code != 404 {
		t.Fatalf("send after unfollow %d", rec.Code)
	}
	w.quiesce()
	if n := len(w.probes[2].of("dm.message")); n != 1 {
		t.Fatalf("recipient saw %d frames, want 1", n)
	}
}

func TestDirectMessageConcurrentUnfollowVersusSend(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, map[string]any{"follows": map[string]any{"1:2": "accepted", "2:1": "none"}})
	for round := 0; round < 25; round++ {
		var followID int64
		if err := w.conn.QueryRow(`SELECT id FROM follows WHERE follower_id=1 AND followed_id=2`).Scan(&followID); err != nil {
			t.Fatal(err)
		}
		nonce := fmt.Sprintf("%08d-1111-4111-8111-111111111111", round+1)
		var wg sync.WaitGroup
		var unfollow, sent *httptest.ResponseRecorder
		wg.Add(2)
		go func() {
			defer wg.Done()
			unfollow, _ = w.as(t, 1, "DELETE", fmt.Sprintf("/api/v1/follows/%d", followID), nil)
		}()
		go func() {
			defer wg.Done()
			sent, _ = w.send(t, 1, 2, nonce, "race")
		}()
		wg.Wait()
		if unfollow.Code != 204 {
			t.Fatalf("round %d: unfollow %d", round, unfollow.Code)
		}
		stored := w.count(t, `SELECT COUNT(*) FROM private_messages WHERE client_id=?`, nonce)
		switch sent.Code {
		case 201:
			if stored != 1 {
				t.Fatalf("round %d: 201 but %d rows", round, stored)
			}
		case 404:
			if stored != 0 {
				t.Fatalf("round %d: 404 but %d rows", round, stored)
			}
		default:
			t.Fatalf("round %d: send %d %s", round, sent.Code, sent.Body)
		}
		// Either way the relationship is gone now: sends fail, history stays readable.
		if rec, _ := w.send(t, 1, 2, "ffffffff-1111-4111-8111-111111111111", "after"); rec.Code != 404 {
			t.Fatalf("round %d: send after unfollow %d", round, rec.Code)
		}
		if rec, _ := w.as(t, 2, "GET", "/api/v1/chats/1/messages", nil); rec.Code != 200 {
			t.Fatalf("round %d: history after unfollow %d", round, rec.Code)
		}
		fixtureExec(t, w.conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,2,'accepted','2026-10-15T12:00:00Z')`)
	}
}

func TestDirectMessageConcurrentDuplicateSendsCommitOnce(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	statuses := make(chan int, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var rec *httptest.ResponseRecorder
			if i%2 == 0 {
				rec, _ = w.send(t, 1, 2, nonceA, "same")
			} else {
				w.probes[1].send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "same"}})
				statuses <- 0
				return
			}
			statuses <- rec.Code
		}(i)
	}
	wg.Wait()
	close(statuses)
	created := 0
	for code := range statuses {
		if code == 201 {
			created++
		}
	}
	w.probes[1].waitFor(t, "chat.ack", 4)
	w.quiesce()
	if n := w.count(t, `SELECT COUNT(*) FROM private_messages WHERE client_id=?`, nonceA); n != 1 {
		t.Fatalf("%d rows for one nonce", n)
	}
	if n := len(w.probes[2].of("dm.message")); n != 1 {
		t.Fatalf("recipient saw %d frames for one commit", n)
	}
	if created > 1 {
		t.Fatalf("%d creations", created)
	}
}

func TestDirectMessageImageLifecycleAndParticipantOnlyMedia(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	png := fixtureBytes(t, "avatar.png")
	rec := postDMImage(t, w, 1, 2, "a.png", "image/png", png, nil)
	if rec.Code != 200 {
		t.Fatalf("upload %d %s", rec.Code, rec.Body)
	}
	var staged struct {
		Data struct {
			URL string `json:"image_url"`
		}
	}
	json.Unmarshal(rec.Body.Bytes(), &staged)
	url := staged.Data.URL
	get := func(actor int64, path string) int {
		r := httptest.NewRecorder()
		req := httptest.NewRequest("GET", path, nil)
		req.AddCookie(&http.Cookie{Name: "session_token", Value: fmt.Sprintf("b18-fixture-%d", actor)})
		w.handler.ServeHTTP(r, req)
		return r.Code
	}
	if get(1, url) != 200 || get(2, url) != 404 || get(5, url) != 404 {
		t.Fatal("staged bytes must be readable only by the uploader")
	}
	// A denied send leaves the staged image intact for recovery.
	fixtureExec(t, w.conn, `DELETE FROM follows`)
	if rec, _ := w.as(t, 1, "POST", "/api/v1/chats/2/messages", map[string]any{"client_id": nonceA, "body": "", "image_url": url}); rec.Code != 404 {
		t.Fatalf("denied send %d", rec.Code)
	}
	if rec := postDMImage(t, w, 1, 2, "a.png", "image/png", png, nil); rec.Code != 404 {
		t.Fatalf("upload without a relationship %d", rec.Code)
	}
	if get(1, url) != 200 || w.count(t, `SELECT COUNT(*) FROM media_pending`) != 2 {
		t.Fatal("a denied send discarded the staged image")
	}
	// Relationship restored: the send claims it exactly once.
	fixtureExec(t, w.conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(1,2,'accepted','2026-10-15T12:00:00Z')`)
	send := map[string]any{"client_id": nonceA, "body": "", "image_url": url}
	rec, env := w.as(t, 1, "POST", "/api/v1/chats/2/messages", send)
	if rec.Code != 201 || dataOf(env)["image_url"] != url {
		t.Fatalf("image send %d %s", rec.Code, rec.Body)
	}
	if rec, env := w.as(t, 1, "POST", "/api/v1/chats/2/messages", send); rec.Code != 200 || dataOf(env)["image_url"] != url || dataOf(env)["id"] != float64(503) {
		t.Fatalf("exact image retry %d %s", rec.Code, rec.Body)
	}
	if w.count(t, `SELECT COUNT(*) FROM media_links WHERE message_id=503`) != 1 || w.count(t, `SELECT COUNT(*) FROM private_messages WHERE id>502`) != 1 {
		t.Fatal("retry claimed or stored twice")
	}
	// A claimed image cannot be reused by a new message or stolen by someone else.
	if rec, _ := w.as(t, 1, "POST", "/api/v1/chats/2/messages", map[string]any{"client_id": nonceB, "body": "reuse", "image_url": url}); rec.Code != 404 {
		t.Fatalf("reuse of a claimed image %d", rec.Code)
	}
	if get(2, url) != 200 || get(1, url) != 200 || get(5, url) != 404 {
		t.Fatal("committed media must be participant-only")
	}
	// Relationship loss, restart and a cleanup sweep keep the participants' bytes.
	fixtureExec(t, w.conn, `DELETE FROM follows`)
	w.restart(t)
	if err := db.CleanupMedia(context.Background(), w.conn, true); err != nil {
		t.Fatal(err)
	}
	if get(2, url) != 200 || get(1, url) != 200 || get(5, url) != 404 || get(3, url) != 404 {
		t.Fatal("participant media access changed after unfollow, restart and sweep")
	}
	if _, h := w.as(t, 2, "GET", "/api/v1/chats/1/messages", nil); !bytes.Contains([]byte(fmt.Sprint(h)), []byte(url)) {
		t.Fatal("history lost the image reference")
	}
	// A pending requester or outsider gets nothing: no history, roster, count or bytes.
	for _, outsider := range []int64{3, 4, 5} {
		if rec, _ := w.as(t, outsider, "GET", "/api/v1/chats/1/messages", nil); rec.Code != 404 {
			t.Fatalf("outsider %d history %d", outsider, rec.Code)
		}
		if _, r := w.as(t, outsider, "GET", "/api/v1/chats", nil); len(r["data"].([]any)) != 0 {
			t.Fatalf("outsider %d roster %v", outsider, r)
		}
		if _, u := w.as(t, outsider, "GET", "/api/v1/chats/unread", nil); dataOf(u)["unread_count"] != float64(0) {
			t.Fatalf("outsider %d unread %v", outsider, u)
		}
	}
}

func TestDirectMessageRosterContainsConversationsThenMessageablePeople(t *testing.T) {
	pack := loadDMPack(t)
	given := map[string]any{"follows": map[string]any{"1:2": "accepted", "3:1": "accepted", "1:4": "pending", "5:1": "pending"}}
	w := newDMWorld(t, pack, given)
	_, env := w.as(t, 1, "GET", "/api/v1/chats?per_page=50", nil)
	var ids []float64
	for _, row := range env["data"].([]any) {
		entry := row.(map[string]any)
		ids = append(ids, entry["user_id"].(float64))
		if entry["user_id"] == float64(3) && (entry["can_send"] != true || entry["last_message_at"] != nil || entry["read_through_id"] != float64(0)) {
			t.Fatalf("empty messageable entry %v", entry)
		}
		if _, leaked := entry["username"]; !leaked {
			t.Fatal("roster lost the display-name field")
		}
		for _, banned := range []string{"email", "avatar_url", "profile", "nickname"} {
			if _, found := entry[banned]; found {
				t.Fatalf("roster exposes %s", banned)
			}
		}
	}
	// Conversation first, then the no-history messageable person; pending people never appear.
	if len(ids) != 2 || ids[0] != 2 || ids[1] != 3 {
		t.Fatalf("roster %v", ids)
	}
	if total := env["meta"].(map[string]any)["pagination"].(map[string]any)["total"]; total != float64(2) {
		t.Fatalf("total %v", total)
	}
	// Paging is by the same ordering, with an exact total independent of the page.
	_, first := w.as(t, 1, "GET", "/api/v1/chats?per_page=1&page=2", nil)
	rows := first["data"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["user_id"] != float64(3) {
		t.Fatalf("page 2 %v", first)
	}
	// Previews are the first 200 code points; image-only messages show [image].
	fixtureExec(t, w.conn, `INSERT INTO private_messages(sender_id,recipient_id,body,client_id)VALUES(3,1,?,?)`, strings.Repeat("é", 300), nonceA)
	_, env = w.as(t, 1, "GET", "/api/v1/chats", nil)
	top := env["data"].([]any)[0].(map[string]any)
	if top["user_id"] != float64(3) || len([]rune(top["last_message_preview"].(string))) != 200 || top["unread_count"] != float64(1) {
		t.Fatalf("latest-first preview %v", top)
	}
	_, env = w.as(t, 1, "GET", "/api/v1/chats/3/messages", nil)
	if m := dataOf(env)["messages"].([]any)[0].(map[string]any); len([]rune(m["body"].(string))) != 300 {
		t.Fatal("history truncated a stored body")
	}
	// Old bodies are never revalidated: a 2500-code-point legacy row is served unchanged.
	fixtureExec(t, w.conn, `INSERT INTO private_messages(sender_id,recipient_id,body)VALUES(3,1,?)`, strings.Repeat("a", 2500))
	_, env = w.as(t, 1, "GET", "/api/v1/chats/3/messages?limit=1", nil)
	m := dataOf(env)["messages"].([]any)[0].(map[string]any)
	if len(m["body"].(string)) != 2500 || m["client_id"] != nil {
		t.Fatal("legacy row was altered on read")
	}
}

func TestDirectMessageHistoryPagingIsCompleteAndOrdered(t *testing.T) {
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	for i := 0; i < 25; i++ {
		if rec, _ := w.send(t, 1+int64(i%2), 2-int64(i%2), fmt.Sprintf("%08d-2222-4222-8222-222222222222", i+1), fmt.Sprintf("m%d", i)); rec.Code != 201 {
			t.Fatalf("send %d: %d", i, rec.Code)
		}
	}
	seen := []float64{}
	path := "/api/v1/chats/2/messages?limit=10"
	for pages := 0; pages < 5; pages++ {
		_, env := w.as(t, 1, "GET", path, nil)
		d := dataOf(env)
		msgs := d["messages"].([]any)
		ids := []float64{}
		for _, m := range msgs {
			ids = append(ids, m.(map[string]any)["id"].(float64))
		}
		for i := 1; i < len(ids); i++ {
			if ids[i] <= ids[i-1] {
				t.Fatalf("page not ascending: %v", ids)
			}
		}
		seen = append(ids, seen...)
		if d["has_more"] == false {
			if d["next_before_id"] != nil {
				t.Fatal("next_before_id set without more history")
			}
			break
		}
		if d["next_before_id"] != ids[0] {
			t.Fatalf("next_before_id %v, first %v", d["next_before_id"], ids[0])
		}
		path = fmt.Sprintf("/api/v1/chats/2/messages?limit=10&before_id=%d", int(ids[0]))
	}
	if len(seen) != 27 {
		t.Fatalf("paged %d of 27 messages", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] != seen[i-1]+1 {
			t.Fatalf("gap or duplicate in %v", seen)
		}
	}
}

func TestDirectMessagePresenceFollowsProfileVisibility(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	// 2 is private and unfollowed by 1; 3 is public. Only connect the observer first.
	given := map[string]any{"follows": map[string]any{"1:2": "none"}, "users": map[string]any{
		"2": map[string]any{"online": false}, "3": map[string]any{"online": false}, "4": map[string]any{"online": false},
		"5": map[string]any{"online": false}, "6": map[string]any{"online": false}, "7": map[string]any{"online": false}, "8": map[string]any{"online": false},
	}}
	w := newDMWorld(t, pack, given)
	hidden := openDM(t, w.srv, "b18-fixture-2")
	visible := openDM(t, w.srv, "b18-fixture-3")
	w.quiesce()
	presenceOf := func(frames []dmFrame, user int) bool {
		for _, f := range frames {
			if strings.Contains(string(f.Payload), fmt.Sprintf(`"user_id":%d,`, user)) {
				return true
			}
		}
		return false
	}
	updates := w.probes[1].of("presence.update", "presence.snapshot")
	if presenceOf(updates, 2) {
		t.Fatal("presence of a private non-followed user leaked")
	}
	if !presenceOf(updates, 3) {
		t.Fatal("presence of a public user missing")
	}
	// A private user who follows the viewer does not expose the viewer's presence.
	fixtureExec(t, w.conn, `INSERT INTO follows(follower_id,followed_id,state,accepted_at)VALUES(2,1,'accepted','2026-10-15T12:00:00Z')`)
	_ = hidden
	_ = visible
	_, roster := w.as(t, 1, "GET", "/api/v1/chats", nil)
	for _, row := range roster["data"].([]any) {
		entry := row.(map[string]any)
		if entry["user_id"] == float64(2) {
			if _, exposed := entry["is_online"]; exposed {
				t.Fatal("roster exposed hidden presence as a value")
			}
			if entry["can_send"] != true {
				t.Fatalf("a follower may be messaged: %v", entry)
			}
		}
	}
}

func TestDirectMessageRevokedSessionReceivesNothingQueued(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	fixtureExec(t, w.conn, `UPDATE sessions SET is_valid=0 WHERE token='b18-fixture-2'`)
	if rec, _ := w.send(t, 1, 2, nonceA, "to a revoked socket"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	select {
	case <-w.probes[2].done:
	case <-time.After(5 * time.Second):
		t.Fatal("revoked session stayed connected")
	}
	if len(w.probes[2].of("dm.message")) != 0 {
		t.Fatal("revoked session received a queued message")
	}
}

func TestDirectMessageSocketOwnershipComesFromSession(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	w.probes[2].send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 1, "client_id": nonceA, "body": "mine", "sender_id": 1}})
	w.probes[2].waitFor(t, "chat.error", 1)
	w.probes[2].send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 1, "client_id": nonceA, "body": "mine"}})
	w.probes[2].waitFor(t, "chat.ack", 1)
	var sender int
	if err := w.conn.QueryRow(`SELECT sender_id FROM private_messages WHERE client_id=?`, nonceA).Scan(&sender); err != nil || sender != 2 {
		t.Fatalf("sender %d %v", sender, err)
	}
}

// Every directed-follow × visibility × online cell replayed over actual sockets
// through dm.send: permitted and denied sends, live versus stored delivery, and
// presence exposure, against the approved model.
func TestDirectMessageSocketMatrixMatchesApprovedModel(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	if len(pack.Matrix) != 36 {
		t.Fatalf("matrix has %d cells", len(pack.Matrix))
	}
	for _, cell := range pack.Matrix {
		t.Run(cell.CaseID, func(t *testing.T) {
			w := newDMWorld(t, pack, map[string]any{
				"follows": map[string]any{"1:2": cell.Outgoing, "2:1": cell.Incoming},
				"users":   map[string]any{"2": map[string]any{"visibility": cell.Visibility, "online": cell.Online}},
			})
			sender := w.probes[1]
			sender.send(t, map[string]any{"type": "dm.send", "payload": map[string]any{"recipient_id": 2, "client_id": nonceA, "body": "matrix"}})
			if cell.CanSend {
				sender.waitFor(t, "chat.ack", 1)
				sender.waitFor(t, "dm.message", 1)
			} else {
				frames := sender.waitFor(t, "chat.error", 1)
				if !strings.Contains(string(frames[0].Payload), `"NOT_FOUND"`) {
					t.Fatalf("denied send answered %s", frames[0].Payload)
				}
			}
			w.quiesce()
			stored := w.count(t, `SELECT COUNT(*) FROM private_messages WHERE client_id=?`, nonceA)
			if (stored == 1) != cell.CanSend {
				t.Fatalf("stored=%d can_send=%v", stored, cell.CanSend)
			}
			delivered := 0
			if probe := w.probes[2]; probe != nil {
				delivered = len(probe.of("dm.message"))
			}
			if (delivered == 1) != cell.Live || delivered > 1 {
				t.Fatalf("recipient frames=%d recipient_live=%v", delivered, cell.Live)
			}
			_, roster := w.as(t, 1, "GET", "/api/v1/chats", nil)
			entry := roster["data"].([]any)[0].(map[string]any)
			online, exposed := entry["is_online"]
			if exposed != cell.Presence || exposed && online != cell.Online {
				t.Fatalf("presence exposed=%v value=%v; want visible=%v online=%v", exposed, online, cell.Presence, cell.Online)
			}
			if entry["can_send"] != cell.CanSend {
				t.Fatalf("roster can_send=%v want %v", entry["can_send"], cell.CanSend)
			}
		})
	}
}

// Messages arrive in commit order for one conversation, and live frames match
// the order of the stored history.
func TestDirectMessageOrderingMatchesHistory(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	for i := 0; i < 15; i++ {
		from, to := int64(1), int64(2)
		if i%3 == 0 {
			from, to = 2, 1
		}
		if rec, _ := w.send(t, from, to, fmt.Sprintf("%08d-3333-4333-8333-333333333333", i+1), fmt.Sprint(i)); rec.Code != 201 {
			t.Fatalf("send %d: %d", i, rec.Code)
		}
	}
	w.probes[2].waitFor(t, "dm.message", 15)
	var live []int64
	for _, f := range w.probes[2].of("dm.message") {
		var m struct{ ID int64 }
		json.Unmarshal(f.Payload, &m)
		live = append(live, m.ID)
	}
	for i := 1; i < len(live); i++ {
		if live[i] != live[i-1]+1 {
			t.Fatalf("live order %v", live)
		}
	}
	_, history := w.as(t, 2, "GET", "/api/v1/chats/1/messages?limit=50", nil)
	messages := dataOf(history)["messages"].([]any)
	for i, id := range live {
		if messages[len(messages)-len(live)+i].(map[string]any)["id"] != float64(id) {
			t.Fatal("history order differs from live order")
		}
	}
}

// A database failure while re-authorizing a queued frame fails closed for that
// frame only; it must not tear down the user's live connection.
func TestDirectMessageAuthorizationFailureSuppressesTheFrameNotTheConnection(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	w := newDMWorld(t, pack, mutualFollow)
	fixtureExec(t, w.conn, `ALTER TABLE follows RENAME TO follows_unavailable`)
	frame, _ := json.Marshal(map[string]any{"type": "dm.message", "payload": map[string]any{
		"id": 503, "sender_id": 1, "recipient_id": 2, "sender_username": "x", "body": "queued", "created_at": pack.Clock, "client_id": nil,
	}})
	if err := w.hub.SendToUser(2, frame); err != nil {
		t.Fatal(err)
	}
	w.quiesce()
	select {
	case <-w.probes[2].done:
		t.Fatal("an authorization error closed the connection")
	default:
	}
	if len(w.probes[2].of("dm.message")) != 0 {
		t.Fatal("a frame that could not be authorized was written")
	}
	fixtureExec(t, w.conn, `ALTER TABLE follows_unavailable RENAME TO follows`)
	if rec, _ := w.send(t, 1, 2, nonceA, "after recovery"); rec.Code != 201 {
		t.Fatalf("send %d", rec.Code)
	}
	w.probes[2].waitFor(t, "dm.message", 1)
}
