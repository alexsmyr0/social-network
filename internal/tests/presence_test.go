// internal/tests/presence_test.go
package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// getUserID calls /api/v1/users/me and returns the authenticated user's id.
func getUserID(t *testing.T, h http.Handler, token string) int64 {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.AddCookie(&http.Cookie{Name: "session_token", Value: token})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("getUserID: unexpected status %d", rec.Code)
	}
	var resp struct {
		Data struct {
			ID int64 `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("getUserID: decode: %v", err)
	}
	return resp.Data.ID
}

// presenceUsers parses the users array from a presence.snapshot payload.
func presenceUsers(t *testing.T, msg map[string]json.RawMessage) []struct {
	UserID   int64 `json:"user_id"`
	IsOnline bool  `json:"is_online"`
} {
	t.Helper()
	var payload struct {
		Users []struct {
			UserID   int64 `json:"user_id"`
			IsOnline bool  `json:"is_online"`
		} `json:"users"`
	}
	if err := json.Unmarshal(msg["payload"], &payload); err != nil {
		t.Fatalf("presenceUsers: %v", err)
	}
	return payload.Users
}

// presenceUpdatePayload parses the payload from a presence.update message.
func presenceUpdatePayload(t *testing.T, msg map[string]json.RawMessage) (userID int64, isOnline bool) {
	t.Helper()
	var payload struct {
		UserID   int64 `json:"user_id"`
		IsOnline bool  `json:"is_online"`
	}
	if err := json.Unmarshal(msg["payload"], &payload); err != nil {
		t.Fatalf("presenceUpdatePayload: %v", err)
	}
	return payload.UserID, payload.IsOnline
}

// readWSMessage reads the next text message from conn with a short deadline.
func readWSMessage(t *testing.T, conn *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("readWSMessage: %v", err)
	}
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("readWSMessage: unmarshal: %v", err)
	}
	return msg
}

/*-----------------------
  PRESENCE SNAPSHOT TESTS
------------------------*/

func TestPresence_SnapshotDeliveredOnConnect(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	// Alice connects first so she is in the snapshot bob receives.
	tokenAlice := registerAndLoginAs(t, h, "snapalice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	defer connAlice.Close()

	// Alice's own snapshot arrives on her connect.
	msg := readWSMessage(t, connAlice)
	if string(msg["type"]) != `"presence.snapshot"` {
		t.Fatalf("expected presence.snapshot, got %s", msg["type"])
	}

	// Bob connects — should receive a snapshot that includes alice.
	tokenBob := registerAndLoginAs(t, h, "snapbob")
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()

	// Alice's channel has two pending messages: her own self-update (from when
	// she connected) and bob's update. Drain the self-update so alice's channel
	// stays clean. Bob's update is not asserted here — that is covered by
	// TestPresence_FirstConnectBroadcastsOnline.
	_ = readWSMessage(t, connAlice) // presence.update: alice came online (self)
	_ = readWSMessage(t, connAlice) // presence.update: bob came online

	snapshot := readWSMessage(t, connBob)
	if string(snapshot["type"]) != `"presence.snapshot"` {
		t.Fatalf("expected presence.snapshot for bob, got %s", snapshot["type"])
	}

	// Snapshot payload must contain at least alice's user_id.
	var payload struct {
		Users []struct {
			UserID   int64 `json:"user_id"`
			IsOnline bool  `json:"is_online"`
		} `json:"users"`
	}
	if err := json.Unmarshal(snapshot["payload"], &payload); err != nil {
		t.Fatalf("unmarshal snapshot payload: %v", err)
	}
	if len(payload.Users) == 0 {
		t.Fatal("expected at least one user in presence snapshot")
	}
	for _, u := range payload.Users {
		if !u.IsOnline {
			t.Errorf("snapshot user %d has is_online=false", u.UserID)
		}
	}
}

/*-----------------------
  PRESENCE UPDATE TESTS
------------------------*/

func TestPresence_FirstConnectBroadcastsOnline(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	// Alice connects as observer.
	tokenAlice := registerAndLoginAs(t, h, "updalice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	defer connAlice.Close()
	_ = readWSMessage(t, connAlice) // consume alice's snapshot
	// BroadcastPresenceUpdate(alice, true) also enqueues to alice's own channel.
	// Drain it now so the next read is guaranteed to be bob's update.
	_ = readWSMessage(t, connAlice) // consume alice's self-update

	// Bob connects — alice should receive a presence.update for bob.
	tokenBob := registerAndLoginAs(t, h, "updbob")
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()

	update := readWSMessage(t, connAlice)
	if string(update["type"]) != `"presence.update"` {
		t.Fatalf("expected presence.update, got %s", update["type"])
	}
	var payload struct {
		UserID   int64 `json:"user_id"`
		IsOnline bool  `json:"is_online"`
	}
	if err := json.Unmarshal(update["payload"], &payload); err != nil {
		t.Fatalf("unmarshal update payload: %v", err)
	}
	if !payload.IsOnline {
		t.Error("expected is_online=true for first connection")
	}
	if payload.UserID == 0 {
		t.Error("expected non-zero user_id in presence.update")
	}
}

func TestPresence_SecondTabReceivesSnapshot(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "tab2snapalice")
	connAlice1, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice tab1 failed")
	}
	defer connAlice1.Close()
	_ = readWSMessage(t, connAlice1) // consume tab1 snapshot
	_ = readWSMessage(t, connAlice1) // consume tab1 self-update

	// Alice opens a second tab — it must still receive a presence snapshot.
	connAlice2, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice tab2 failed")
	}
	defer connAlice2.Close()

	snapshot := readWSMessage(t, connAlice2)
	if string(snapshot["type"]) != `"presence.snapshot"` {
		t.Fatalf("expected presence.snapshot for second tab, got %s", snapshot["type"])
	}
}

func TestPresence_SecondTabDoesNotBroadcast(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "tab2alice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice first tab failed")
	}
	defer connAlice.Close()
	_ = readWSMessage(t, connAlice) // consume alice tab1 snapshot
	_ = readWSMessage(t, connAlice) // consume alice tab1 self-update

	// Observer connects to watch for updates.
	tokenObs := registerAndLoginAs(t, h, "tab2obs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs) // consume observer's snapshot
	// BroadcastPresenceUpdate(observer, true) is sent to all connected clients,
	// including the observer themselves. Consume that self-directed update.
	_ = readWSMessage(t, connObs)   // presence.update: observer came online (self)
	_ = readWSMessage(t, connAlice) // presence.update: observer came online (received by alice)

	// Alice opens a second tab — observer must NOT receive another presence.update.
	// The second tab does receive a snapshot (covered by TestPresence_SecondTabReceivesSnapshot)
	// but that snapshot goes only to the new client, not to the observer.
	connAlice2, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice second tab failed")
	}
	defer connAlice2.Close()
	_ = readWSMessage(t, connAlice2) // consume alice tab2 snapshot

	connObs.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _, err := connObs.ReadMessage()
	if err == nil {
		t.Error("expected no presence.update for a second tab of the same user")
	}
}

func TestPresence_LastDisconnectBroadcastsOffline(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "offalice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	_ = readWSMessage(t, connAlice) // consume alice's snapshot

	tokenObs := registerAndLoginAs(t, h, "offobs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs)   // consume observer's snapshot
	_ = readWSMessage(t, connObs)   // presence.update: observer came online (self)
	_ = readWSMessage(t, connAlice) // presence.update: alice came online (self)

	// Alice disconnects cleanly.
	connAlice.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice.Close()

	update := readWSMessage(t, connObs)
	if string(update["type"]) != `"presence.update"` {
		t.Fatalf("expected presence.update on disconnect, got %s", update["type"])
	}
	var payload struct {
		IsOnline bool `json:"is_online"`
	}
	if err := json.Unmarshal(update["payload"], &payload); err != nil {
		t.Fatalf("unmarshal update payload: %v", err)
	}
	if payload.IsOnline {
		t.Error("expected is_online=false after last disconnect")
	}
}

func TestPresence_NonLastDisconnectDoesNotBroadcast(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "nonlastalice")
	connAlice1, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice tab1 failed")
	}
	_ = readWSMessage(t, connAlice1) // consume snapshot

	connAlice2, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice tab2 failed")
	}
	defer connAlice2.Close()

	tokenObs := registerAndLoginAs(t, h, "nonlastobs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs)    // consume observer's snapshot
	_ = readWSMessage(t, connObs)    // presence.update: observer came online (self)
	_ = readWSMessage(t, connAlice1) // presence.update: alice came online (self)
	_ = readWSMessage(t, connAlice2) // alice tab2's snapshot (first message in its channel)

	// Alice closes only one tab — observer must NOT receive a presence.update.
	connAlice1.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice1.Close()

	connObs.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, _, err := connObs.ReadMessage()
	if err == nil {
		t.Error("expected no presence.update when a non-last connection closes")
	}
}

/*--------------------------
  USER-ID CORRECTNESS TESTS
---------------------------*/

func TestPresence_SnapshotContainsCorrectUserIDs(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "snapidalice")
	aliceID := getUserID(t, h, tokenAlice)

	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	defer connAlice.Close()
	_ = readWSMessage(t, connAlice) // alice's snapshot
	_ = readWSMessage(t, connAlice) // alice's self-update

	tokenBob := registerAndLoginAs(t, h, "snapidbob")
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()
	_ = readWSMessage(t, connAlice) // alice receives bob's update

	snapshot := readWSMessage(t, connBob)
	if string(snapshot["type"]) != `"presence.snapshot"` {
		t.Fatalf("expected presence.snapshot, got %s", snapshot["type"])
	}

	users := presenceUsers(t, snapshot)
	found := false
	for _, u := range users {
		if u.UserID == aliceID {
			found = true
			if !u.IsOnline {
				t.Errorf("alice (id=%d) should be online in snapshot", aliceID)
			}
		}
	}
	if !found {
		t.Errorf("alice (id=%d) missing from bob's snapshot; got %v", aliceID, users)
	}
}

func TestPresence_OnlineBroadcastContainsCorrectUserID(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "onidAlice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	defer connAlice.Close()
	_ = readWSMessage(t, connAlice) // snapshot
	_ = readWSMessage(t, connAlice) // self-update

	tokenBob := registerAndLoginAs(t, h, "onidBob")
	bobID := getUserID(t, h, tokenBob)
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()

	update := readWSMessage(t, connAlice)
	if string(update["type"]) != `"presence.update"` {
		t.Fatalf("expected presence.update, got %s", update["type"])
	}
	uid, isOnline := presenceUpdatePayload(t, update)
	if uid != bobID {
		t.Errorf("expected bob's id (%d) in online update, got %d", bobID, uid)
	}
	if !isOnline {
		t.Error("expected is_online=true")
	}
}

func TestPresence_OfflineBroadcastContainsCorrectUserID(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "offidAlice")
	aliceID := getUserID(t, h, tokenAlice)
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	_ = readWSMessage(t, connAlice) // snapshot
	_ = readWSMessage(t, connAlice) // self-update

	tokenObs := registerAndLoginAs(t, h, "offidObs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs)   // observer's snapshot
	_ = readWSMessage(t, connObs)   // observer's self-update
	_ = readWSMessage(t, connAlice) // observer's broadcast, received by alice when obs connected

	connAlice.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice.Close()

	update := readWSMessage(t, connObs)
	if string(update["type"]) != `"presence.update"` {
		t.Fatalf("expected presence.update, got %s", update["type"])
	}
	uid, isOnline := presenceUpdatePayload(t, update)
	if uid != aliceID {
		t.Errorf("expected alice's id (%d) in offline update, got %d", aliceID, uid)
	}
	if isOnline {
		t.Error("expected is_online=false")
	}
}

func TestPresence_SnapshotExcludesOfflineUsers(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	// Alice connects then disconnects.
	tokenAlice := registerAndLoginAs(t, h, "snappropAlice")
	aliceID := getUserID(t, h, tokenAlice)
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	_ = readWSMessage(t, connAlice) // snapshot
	_ = readWSMessage(t, connAlice) // self-update

	// Observer connects to use the offline update as a synchronization signal —
	// once the observer receives alice's offline event, alice is guaranteed to
	// be removed from the Hub before the next connection's snapshot is built.
	tokenObs := registerAndLoginAs(t, h, "snappropObs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs)   // observer's snapshot
	_ = readWSMessage(t, connObs)   // observer's self-update
	_ = readWSMessage(t, connAlice) // alice receives observer's update

	connAlice.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice.Close()

	// Block until observer confirms alice has gone offline.
	offlineUpdate := readWSMessage(t, connObs)
	uid, _ := presenceUpdatePayload(t, offlineUpdate)
	if uid != aliceID {
		t.Fatalf("expected alice's offline update, got user_id=%d", uid)
	}

	// Bob now connects — alice must not appear in his snapshot.
	tokenBob := registerAndLoginAs(t, h, "snappropBob")
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()

	snapshot := readWSMessage(t, connBob)
	users := presenceUsers(t, snapshot)
	for _, u := range users {
		if u.UserID == aliceID {
			t.Errorf("alice (id=%d) should not appear in snapshot after disconnecting", aliceID)
		}
	}
}

func TestPresence_OfflineBroadcastReachesAllObservers(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "allObsAlice")
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice connection failed")
	}
	_ = readWSMessage(t, connAlice) // snapshot
	_ = readWSMessage(t, connAlice) // self-update

	tokenBob := registerAndLoginAs(t, h, "allObsBob")
	connBob, ok := dialWS(t, srv, tokenBob)
	if !ok {
		t.Fatal("bob connection failed")
	}
	defer connBob.Close()
	_ = readWSMessage(t, connBob)   // bob's snapshot
	_ = readWSMessage(t, connBob)   // bob's self-update
	_ = readWSMessage(t, connAlice) // alice receives bob's update

	tokenCharlie := registerAndLoginAs(t, h, "allObsCharlie")
	connCharlie, ok := dialWS(t, srv, tokenCharlie)
	if !ok {
		t.Fatal("charlie connection failed")
	}
	defer connCharlie.Close()
	_ = readWSMessage(t, connCharlie) // charlie's snapshot
	_ = readWSMessage(t, connCharlie) // charlie's self-update
	_ = readWSMessage(t, connAlice)   // alice receives charlie's update
	_ = readWSMessage(t, connBob)     // bob receives charlie's update

	connAlice.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice.Close()

	for _, tc := range []struct {
		name string
		conn *websocket.Conn
	}{
		{"bob", connBob},
		{"charlie", connCharlie},
	} {
		update := readWSMessage(t, tc.conn)
		if string(update["type"]) != `"presence.update"` {
			t.Errorf("%s: expected presence.update, got %s", tc.name, update["type"])
			continue
		}
		_, isOnline := presenceUpdatePayload(t, update)
		if isOnline {
			t.Errorf("%s: expected is_online=false after alice's disconnect", tc.name)
		}
	}
}

func TestPresence_ReconnectCycle(t *testing.T) {
	requireLocalTCPListener(t)

	h, db := newTestAPI(t)
	defer db.Close()

	srv := httptest.NewServer(h)
	defer srv.Close()

	tokenAlice := registerAndLoginAs(t, h, "reconnAlice")
	aliceID := getUserID(t, h, tokenAlice)

	tokenObs := registerAndLoginAs(t, h, "reconnObs")
	connObs, ok := dialWS(t, srv, tokenObs)
	if !ok {
		t.Fatal("observer connection failed")
	}
	defer connObs.Close()
	_ = readWSMessage(t, connObs) // observer's snapshot (no one else online yet)
	_ = readWSMessage(t, connObs) // observer's self-update

	// Alice connects — observer sees her come online.
	connAlice, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice first connect failed")
	}
	_ = readWSMessage(t, connAlice) // alice's snapshot
	_ = readWSMessage(t, connAlice) // alice's self-update

	onlineUpdate := readWSMessage(t, connObs)
	uid, isOnline := presenceUpdatePayload(t, onlineUpdate)
	if uid != aliceID || !isOnline {
		t.Fatalf("expected alice online update, got user_id=%d is_online=%v", uid, isOnline)
	}

	// Alice disconnects — observer sees her go offline.
	connAlice.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	connAlice.Close()

	offlineUpdate := readWSMessage(t, connObs)
	uid, isOnline = presenceUpdatePayload(t, offlineUpdate)
	if uid != aliceID || isOnline {
		t.Fatalf("expected alice offline update, got user_id=%d is_online=%v", uid, isOnline)
	}

	// Alice reconnects — observer sees her come online again.
	connAlice2, ok := dialWS(t, srv, tokenAlice)
	if !ok {
		t.Fatal("alice reconnect failed")
	}
	defer connAlice2.Close()

	reconnectUpdate := readWSMessage(t, connObs)
	uid, isOnline = presenceUpdatePayload(t, reconnectUpdate)
	if uid != aliceID || !isOnline {
		t.Fatalf("expected alice online again after reconnect, got user_id=%d is_online=%v", uid, isOnline)
	}
}
