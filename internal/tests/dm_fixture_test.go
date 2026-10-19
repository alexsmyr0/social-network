package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/color/palette"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"forum/internal/db"
	"forum/internal/ws"
)

// The approved Phase 5 pack's chat cases replay against the real router, migrated
// SQLite and actual WebSocket connections: online users hold real sockets, and a
// "signal" is a frame that really arrived on one of them.

type dmFixtureRequest struct {
	Actor       *int64
	Method      string
	Path        string
	JSON        json.RawMessage `json:"json"`
	RawJSON     *string         `json:"raw_json"`
	BodyBytes   int             `json:"body_bytes"`
	ContentType string          `json:"content_type"`
	XHR         *bool           `json:"xhr"`
	Origin      *string
	Multipart   []struct {
		Name        string
		FixtureFile string `json:"fixture_file"`
		Value       string
	}
}
type dmSignal struct {
	Type       string
	Recipients []int64
	Payload    json.RawMessage
}
type dmFixtureExpect struct {
	Status    int
	Body      json.RawMessage
	Signals   []dmSignal
	State     map[string]any
	Unchanged bool
	Allow     string
}
type dmFixtureCase struct {
	ID      string
	Given   map[string]any
	Request dmFixtureRequest
	Expect  dmFixtureExpect
}
type dmFixtureAction struct {
	Op           string
	Actor        int64
	Target       int64
	From, To     int64
	State        string
	ClientID     string `json:"client_id"`
	Body         string
	ThroughID    int64 `json:"through_id"`
	MembershipID int64 `json:"membership_id"`
}
type dmFixtureStep struct {
	Action dmFixtureAction
	Expect struct {
		Status      int
		ID          int64
		Code        string
		IDs         []int64
		UnreadCount *int `json:"unread_count"`
	}
}
type dmFixturePack struct {
	Clock     string
	State     map[string]any
	Cases     []dmFixtureCase `json:"http_cases"`
	Sequences []struct {
		ID    string
		Steps []dmFixtureStep
	}
	Races []struct {
		ID      string
		Actions []dmFixtureAction
		Orders  []struct {
			Order    []int
			Statuses []int
		}
	}
	Delivery []struct {
		ID           string
		Type         string
		Viewer       int64
		Sender       int64
		Target       int64
		Given        map[string]any
		SessionValid bool `json:"session_valid"`
		Deliver      bool
	} `json:"delivery_cases"`
	Upgrade struct {
		SourceVersion int `json:"source_version"`
		Messages      []map[string]any
		Expected      []map[string]any          `json:"expected_messages"`
		Cursors       map[string]int64          `json:"expected_dm_cursors"`
		MediaBefore   map[string]map[string]any `json:"media_before"`
		MediaAfter    map[string]map[string]any `json:"media_after"`
	}
	Media []struct {
		ID          string
		Mime        string
		Bytes       int
		BodyBytes   int `json:"body_bytes"`
		Width       int
		Height      int
		Frames      int
		Valid       bool
		Status      int
		DecodedMime string `json:"decoded_mime"`
		Corrupt     bool
		ExtraPart   bool `json:"extra_part"`
	} `json:"media_cases"`
	Matrix []struct {
		CaseID     string `json:"case_id"`
		Outgoing   string
		Incoming   string
		Visibility string `json:"recipient_visibility"`
		Online     bool   `json:"recipient_online"`
		CanSend    bool   `json:"can_send"`
		Live       bool   `json:"recipient_live"`
		Presence   bool   `json:"presence_visible"`
	} `json:"dm_matrix"`
	Sockets []struct {
		ID     string
		Actor  int64
		Given  map[string]any
		Frame  json.RawMessage
		Raw    int `json:"frame_bytes"`
		Expect struct {
			Ack    *dmSignal `json:"ack"`
			Error  *dmSignal `json:"error"`
			Fanout []dmSignal
			Close  int
		}
	} `json:"socket_cases"`
}

func loadDMPack(t *testing.T) dmFixturePack {
	t.Helper()
	raw, err := os.ReadFile("../../docs/social-network/fixtures/phase-5-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var pack dmFixturePack
	if err := json.Unmarshal(raw, &pack); err != nil {
		t.Fatal(err)
	}
	return pack
}

var fixtureAvatar = map[string]string{"image/png": "avatar.png", "image/jpeg": "avatar.jpg", "image/gif": "avatar.gif"}

func fixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("../../SPA/tests/fixtures/a07", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// seedDMFixture adds the DM half of the shared pack state: private media rows and
// bytes, messages (with their media links), and persisted cursors.
func seedDMFixture(t *testing.T, conn *sql.DB, state map[string]any, clock string) {
	t.Helper()
	seedEventFixture(t, conn, state, clock)
	root, err := db.AvatarRoot(conn)
	if err != nil {
		t.Fatal(err)
	}
	png := fixtureBytes(t, "avatar.png")
	media := records(state, "media")
	ids := make([]string, 0, len(media))
	for id := range media {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		key := "o" + id + ".png"
		if err := os.WriteFile(filepath.Join(root, "objects", key), png, 0o600); err != nil {
			t.Fatal(err)
		}
		fixtureExec(t, conn, `INSERT INTO media_objects(id,source_key,object_key,mime_type,byte_count,state)VALUES(?,?,?,'image/png',?,'ready')`, id, "new:"+key, key, len(png))
		if media[id]["message_id"] == nil {
			fixtureExec(t, conn, `INSERT INTO media_pending(media_id,uploader_id,recipient_id,kind)VALUES(?,?,?,'dm')`, id, media[id]["uploader_id"], media[id]["recipient_id"])
		}
	}
	dms := records(state, "dms")
	keys := make([]string, 0, len(dms))
	for id := range dms {
		keys = append(keys, id)
	}
	sort.Slice(keys, func(i, j int) bool { a, _ := strconv.Atoi(keys[i]); b, _ := strconv.Atoi(keys[j]); return a < b })
	for _, id := range keys {
		m := dms[id]
		fixtureExec(t, conn, `INSERT INTO private_messages(id,sender_id,recipient_id,body,image_path,created_at,client_id)VALUES(?,?,?,?,?,?,?)`,
			id, m["sender_id"], m["recipient_id"], m["body"], m["image_url"], m["created_at"], m["client_id"])
	}
	cursors, _ := state["dm_cursors"].(map[string]any)
	for pair, through := range cursors {
		p := strings.Split(pair, ":")
		fixtureExec(t, conn, `INSERT INTO dm_read_cursors(viewer_id,other_id,through_id)VALUES(?,?,?)`, p[0], p[1], through)
	}
}

func dmSnapshot(t *testing.T, conn *sql.DB) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, q := range []struct{ name, sql string }{
		{"messages", `SELECT * FROM private_messages ORDER BY id`},
		{"cursors", `SELECT * FROM dm_read_cursors ORDER BY viewer_id,other_id`},
		{"objects", `SELECT * FROM media_objects ORDER BY id`},
		{"pending", `SELECT * FROM media_pending ORDER BY media_id`},
		{"links", `SELECT * FROM media_links ORDER BY id`},
		{"notices", `SELECT * FROM notifications ORDER BY id`},
		{"sequences", `SELECT * FROM sqlite_sequence ORDER BY name`},
	} {
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
		rows.Close()
		out[q.name] = b.String()
	}
	return out
}

/*---------------------------------------------------------------------------
  real sockets
---------------------------------------------------------------------------*/

type dmFrame struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}
type dmProbe struct {
	conn   *websocket.Conn
	wmu    sync.Mutex // gorilla permits one concurrent writer
	mu     sync.Mutex
	frames []dmFrame
	ready  chan struct{}
	done   chan struct{}
}

func dialDM(t *testing.T, srv *httptest.Server, token string) (*dmProbe, error) {
	t.Helper()
	headers := http.Header{"Origin": {"http://localhost:3000"}, "Cookie": {"session_token=" + token}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", headers)
	if err != nil {
		return nil, err
	}
	p := &dmProbe{conn: conn, ready: make(chan struct{}), done: make(chan struct{})}
	t.Cleanup(func() { conn.Close() })
	go func() {
		defer close(p.done)
		first := true
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var f dmFrame
			if json.Unmarshal(raw, &f) != nil {
				continue
			}
			p.mu.Lock()
			p.frames = append(p.frames, f)
			p.mu.Unlock()
			if first && f.Type == "presence.snapshot" {
				first = false
				close(p.ready)
			}
		}
	}()
	select {
	case <-p.ready:
	case <-p.done:
		return nil, fmt.Errorf("socket closed before it was registered")
	case <-time.After(5 * time.Second):
		return nil, fmt.Errorf("socket never registered")
	}
	return p, nil
}

func openDM(t *testing.T, srv *httptest.Server, token string) *dmProbe {
	t.Helper()
	p, err := dialDM(t, srv, token)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func (p *dmProbe) send(t *testing.T, v any) {
	t.Helper()
	p.wmu.Lock()
	defer p.wmu.Unlock()
	if err := p.conn.WriteJSON(v); err != nil {
		t.Fatal(err)
	}
}

// of returns the frames of the given types seen so far.
func (p *dmProbe) of(types ...string) []dmFrame {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []dmFrame{}
	for _, f := range p.frames {
		for _, kind := range types {
			if f.Type == kind {
				out = append(out, f)
			}
		}
	}
	return out
}

// waitFor blocks until n frames of the type have arrived, or fails.
func (p *dmProbe) waitFor(t *testing.T, kind string, n int) []dmFrame {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := p.of(kind); len(got) >= n {
			return got
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("waiting for %d %s frames, have %v", n, kind, p.of(kind))
	return nil
}

func (p *dmProbe) closedWithin(d time.Duration) (int, bool) {
	select {
	case <-p.done:
		return 0, true
	case <-time.After(d):
		return 0, false
	}
}

var chatFrameTypes = []string{"dm.message", "chat.read", "chat.ack", "chat.error"}

func normalizePayload(raw json.RawMessage) any {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	var walk func(any)
	walk = func(x any) {
		if m, ok := x.(map[string]any); ok {
			if _, ok := m["created_at"]; ok {
				m["created_at"] = "T"
			}
			for _, c := range m {
				walk(c)
			}
		}
	}
	walk(v)
	return v
}

// assertDMSignals checks, per signal type, exactly which users' real sockets
// received a frame and that its payload matches. Unlisted chat frame types must
// not have reached anyone.
func assertDMSignals(t *testing.T, want []dmSignal, probes map[int64]*dmProbe) {
	t.Helper()
	expected := map[string]dmSignal{}
	for _, s := range want {
		expected[s.Type] = s
	}
	for _, kind := range chatFrameTypes {
		signal, listed := expected[kind]
		recipients := map[int64]bool{}
		for _, id := range signal.Recipients {
			recipients[id] = true
		}
		for user, probe := range probes {
			frames := probe.of(kind)
			switch {
			case listed && recipients[user]:
				if len(frames) != 1 {
					t.Fatalf("user %d received %d %s frames, want 1", user, len(frames), kind)
				}
				if got, wantPayload := normalizePayload(frames[0].Payload), normalizePayload(signal.Payload); !reflect.DeepEqual(got, wantPayload) {
					g, _ := json.Marshal(got)
					w, _ := json.Marshal(wantPayload)
					t.Fatalf("%s payload to %d\n got %s\nwant %s", kind, user, g, w)
				}
			case len(frames) != 0:
				t.Fatalf("user %d unexpectedly received %s: %s", user, kind, frames[0].Payload)
			}
		}
	}
}

/*---------------------------------------------------------------------------
  request construction
---------------------------------------------------------------------------*/

func (r dmFixtureRequest) build(t *testing.T) *http.Request {
	t.Helper()
	var body bytes.Buffer
	contentType := ""
	switch {
	case r.Multipart != nil:
		w := multipart.NewWriter(&body)
		for _, part := range r.Multipart {
			if part.FixtureFile != "" {
				name := filepath.Base(part.FixtureFile)
				h := textproto.MIMEHeader{}
				h.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, part.Name, name))
				mimeType := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif"}[filepath.Ext(name)]
				h.Set("Content-Type", mimeType)
				fw, err := w.CreatePart(h)
				if err != nil {
					t.Fatal(err)
				}
				fw.Write(fixtureBytes(t, name))
			} else if err := w.WriteField(part.Name, part.Value); err != nil {
				t.Fatal(err)
			}
		}
		w.Close()
		contentType = w.FormDataContentType()
	case r.RawJSON != nil:
		body.WriteString(*r.RawJSON)
		contentType = "application/json"
	case len(r.JSON) > 0:
		body.Write(r.JSON)
		contentType = "application/json"
		if r.BodyBytes > body.Len() {
			body.WriteString(strings.Repeat(" ", r.BodyBytes-body.Len()))
		}
	}
	req := httptest.NewRequest(r.Method, r.Path, &body)
	if r.ContentType != "" && r.Multipart == nil {
		contentType = r.ContentType
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if r.Method != http.MethodGet {
		origin := "http://localhost:3000"
		if r.Origin != nil {
			origin = *r.Origin
		}
		req.Header.Set("Origin", origin)
		if r.XHR == nil || *r.XHR {
			req.Header.Set("X-Requested-With", "XMLHttpRequest")
		}
	}
	if r.Actor != nil {
		req.AddCookie(&http.Cookie{Name: "session_token", Value: fmt.Sprintf("b18-fixture-%d", *r.Actor)})
	}
	return req
}

func onlineUsers(state map[string]any) []int64 {
	out := []int64{}
	for id, u := range records(state, "users") {
		if active, _ := u["active"].(bool); !active {
			continue
		}
		if online, _ := u["online"].(bool); online {
			n, _ := strconv.ParseInt(id, 10, 64)
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// dmWorld is one seeded service with a real listener and sockets for online users.
type dmWorld struct {
	handler http.Handler
	conn    *sql.DB
	hub     *ws.Hub
	srv     *httptest.Server
	probes  map[int64]*dmProbe
}

func newDMWorld(t *testing.T, pack dmFixturePack, given map[string]any) *dmWorld {
	t.Helper()
	handler, conn, hub := socialAPIWithHub(t)
	state := mergeGroupState(pack.State, given)
	seedDMFixture(t, conn, state, pack.Clock)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Cleanup(func() { drainHub(hub) })
	w := &dmWorld{handler: handler, conn: conn, hub: hub, srv: srv, probes: map[int64]*dmProbe{}}
	for _, id := range onlineUsers(state) {
		w.probes[id] = openDM(t, srv, fmt.Sprintf("b18-fixture-%d", id))
	}
	return w
}

func (w *dmWorld) do(t *testing.T, r dmFixtureRequest) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, r.build(t))
	return rec
}

// drainHub waits for every server-side socket pump to unregister, so no goroutine
// touches the database or its temp directory after the test finishes.
func drainHub(hub *ws.Hub) {
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline) && len(hub.GetOnlineUserIDs()) > 0; {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
}

func (w *dmWorld) quiesce() { time.Sleep(120 * time.Millisecond) }

/*---------------------------------------------------------------------------
  HTTP cases
---------------------------------------------------------------------------*/

func TestDirectMessageContractFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran, matrix := 0, 0
	for _, c := range pack.Cases {
		if !strings.Contains(c.Request.Path, "/chats") {
			continue
		}
		ran++
		if strings.HasPrefix(c.ID, "dm-") && strings.Count(c.ID, "-") == 4 {
			matrix++
		}
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, c.Given)
			before := dmSnapshot(t, w.conn)
			rec := w.do(t, c.Request)
			w.quiesce()
			if c.Expect.Status == 404 || c.Expect.Status == 409 || c.Expect.Status == 400 && bytes.Contains(c.Expect.Body, []byte("VALIDATION_ERROR")) {
				var actual, expected any
				if err := json.Unmarshal(rec.Body.Bytes(), &actual); err != nil {
					t.Fatal(err)
				}
				json.Unmarshal(c.Expect.Body, &expected)
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("pinned error %s want %s", rec.Body, c.Expect.Body)
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
			if c.Expect.Allow != "" && rec.Header().Get("Allow") != c.Expect.Allow {
				t.Fatalf("Allow %q want %q", rec.Header().Get("Allow"), c.Expect.Allow)
			}
			assertDMSignals(t, c.Expect.Signals, w.probes)
			if c.Expect.Unchanged || rec.Code >= 400 {
				if !reflect.DeepEqual(before, dmSnapshot(t, w.conn)) {
					t.Fatal("denied or read-only request changed persisted state")
				}
			}
			assertDMState(t, w, c)
		})
	}
	if ran != 86 || matrix != 36 {
		t.Fatalf("ran %d chat cases (%d matrix cells), want 86 and 36", ran, matrix)
	}
}

func assertDMState(t *testing.T, w *dmWorld, c dmFixtureCase) {
	t.Helper()
	ctx := context.Background()
	for key, want := range c.Expect.State {
		switch key {
		case "dms_count":
			var n int
			w.conn.QueryRow(`SELECT COUNT(*) FROM private_messages`).Scan(&n)
			if n != int(want.(float64)) {
				t.Fatalf("messages %d want %v", n, want)
			}
		case "recipient_unread":
			n, err := db.DirectUnreadTotal(ctx, w.conn, 2)
			if err != nil || n != int(want.(float64)) {
				t.Fatalf("recipient unread %d (%v) want %v", n, err, want)
			}
		case "media_701_message":
			var n int
			if err := w.conn.QueryRow(`SELECT message_id FROM media_links WHERE media_id=701`).Scan(&n); err != nil || n != int(want.(float64)) {
				t.Fatalf("media 701 message %d (%v) want %v", n, err, want)
			}
		case "notice_unread":
			page, err := db.ListSocialNotifications(ctx, w.conn, *c.Request.Actor, 1, 20)
			if err != nil || page.UnreadCount != int(want.(float64)) {
				t.Fatalf("notification unread %d (%v) want %v", page.UnreadCount, err, want)
			}
		case "dm_cursor":
			target := strings.Split(strings.TrimPrefix(c.Request.Path, "/api/v1/chats/"), "/")[0]
			var n int
			if err := w.conn.QueryRow(`SELECT through_id FROM dm_read_cursors WHERE viewer_id=? AND other_id=?`, *c.Request.Actor, target).Scan(&n); err != nil || n != int(want.(float64)) {
				t.Fatalf("cursor %d (%v) want %v", n, err, want)
			}
		default:
			t.Fatalf("unchecked fixture postcondition %s", key)
		}
	}
}

/*---------------------------------------------------------------------------
  socket cases
---------------------------------------------------------------------------*/

func TestDirectMessageSocketFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, c := range pack.Sockets {
		if strings.HasPrefix(c.ID, "group-") {
			continue // B23 owns the group frames
		}
		ran++
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, c.Given)
			actor := w.probes[c.Actor]
			if c.Raw > 0 {
				// Larger than the 16 KiB frame limit: the socket closes with 1009.
				frame := `{"type":"dm.send","payload":{"body":"` + strings.Repeat("x", c.Raw) + `"}}`
				if err := actor.conn.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
					t.Fatal(err)
				}
				select {
				case <-actor.done:
				case <-time.After(5 * time.Second):
					t.Fatal("oversize frame left the socket open")
				}
				if _, _, err := actor.conn.ReadMessage(); !websocket.IsCloseError(err, c.Expect.Close) {
					t.Fatalf("close %v want %d", err, c.Expect.Close)
				}
				var count int
				w.conn.QueryRow(`SELECT COUNT(*) FROM private_messages`).Scan(&count)
				if count != 2 {
					t.Fatal("oversize frame changed state")
				}
				return
			}
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
			// Ack and error reach only the requesting socket, and exactly once.
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
			}
			// Fanout recipients are real sockets, checked like the HTTP cases.
			view := map[int64]*dmProbe{}
			for user, probe := range w.probes {
				view[user] = &dmProbe{frames: probe.of("dm.message", "chat.read")}
			}
			assertDMSignals(t, c.Expect.Fanout, view)
		})
	}
	if ran != 5 {
		t.Fatalf("ran %d socket cases", ran)
	}
}

/*---------------------------------------------------------------------------
  sequences and races (direct-message operations only)
---------------------------------------------------------------------------*/

type dmOutcome struct {
	status int
	id     int64
	code   string
	ids    []int64
	unread int
}

func (w *dmWorld) restart(t *testing.T) {
	t.Helper()
	var path string
	if err := w.conn.QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
		t.Fatal(err)
	}
	w.conn.Close()
	conn, err := db.InitDB(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	w.conn = conn
	w.handler = routerFor(conn, w.hub)
}

func (w *dmWorld) apply(t *testing.T, a dmFixtureAction) dmOutcome {
	t.Helper()
	call := func(actor int64, method, path string, body any) dmOutcome {
		r := dmFixtureRequest{Actor: &actor, Method: method, Path: path}
		if body != nil {
			r.JSON, _ = json.Marshal(body)
		}
		rec := w.do(t, r)
		out := dmOutcome{status: rec.Code}
		var parsed struct {
			Data  json.RawMessage `json:"data"`
			Error struct{ Code string }
		}
		json.Unmarshal(rec.Body.Bytes(), &parsed)
		out.code = parsed.Error.Code
		var data struct {
			ID          int64 `json:"id"`
			UnreadCount int   `json:"unread_count"`
			Messages    []struct {
				ID int64 `json:"id"`
			} `json:"messages"`
		}
		json.Unmarshal(parsed.Data, &data)
		out.id, out.unread = data.ID, data.UnreadCount
		for _, m := range data.Messages {
			out.ids = append(out.ids, m.ID)
		}
		return out
	}
	switch a.Op {
	case "dm_send":
		return call(a.Actor, "POST", fmt.Sprintf("/api/v1/chats/%d/messages", a.Target), map[string]any{"client_id": a.ClientID, "body": a.Body})
	case "dm_history":
		return call(a.Actor, "GET", fmt.Sprintf("/api/v1/chats/%d/messages", a.Target), nil)
	case "dm_unread":
		return call(a.Actor, "GET", "/api/v1/chats/unread", nil)
	case "dm_read":
		return call(a.Actor, "PUT", fmt.Sprintf("/api/v1/chats/%d/read", a.Target), map[string]any{"through_id": a.ThroughID})
	case "media":
		return call(a.Actor, "GET", fmt.Sprintf("/api/v1/media/%d", a.Target), nil)
	case "follow":
		if a.State == "none" {
			fixtureExec(t, w.conn, `DELETE FROM follows WHERE follower_id=? AND followed_id=?`, a.From, a.To)
		} else {
			fixtureExec(t, w.conn, `INSERT OR REPLACE INTO follows(follower_id,followed_id,state,accepted_at)VALUES(?,?,?,?)`, a.From, a.To, a.State, "2026-10-15T12:00:00Z")
		}
		return dmOutcome{status: 204}
	case "restart":
		w.restart(t)
		return dmOutcome{status: 204}
	}
	t.Fatalf("unsupported operation %s", a.Op)
	return dmOutcome{}
}

func dmOp(op string) bool {
	switch op {
	case "dm_send", "dm_history", "dm_unread", "dm_read", "media", "follow", "restart":
		return true
	}
	return false
}

func TestDirectMessageFixtureSequences(t *testing.T) {
	pack := loadDMPack(t)
	ran := 0
	for _, seq := range pack.Sequences {
		if seq.ID != "unfollow-refollow" && seq.ID != "nonce-retry" {
			continue
		}
		ran++
		t.Run(seq.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, nil)
			for i, step := range seq.Steps {
				if !dmOp(step.Action.Op) {
					t.Fatalf("step %d: unsupported operation %s", i, step.Action.Op)
				}
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
			}
		})
	}
	if ran != 2 {
		t.Fatalf("ran %d direct-message sequences", ran)
	}
}

func TestDirectMessageFixtureRacesInBothOrders(t *testing.T) {
	pack := loadDMPack(t)
	ran := 0
	for _, race := range pack.Races {
		isDM := true
		for _, a := range race.Actions {
			isDM = isDM && dmOp(a.Op)
		}
		if !isDM {
			continue
		}
		for _, order := range race.Orders {
			ran++
			t.Run(fmt.Sprintf("%s/%v", race.ID, order.Order), func(t *testing.T) {
				w := newDMWorld(t, pack, nil)
				for step, index := range order.Order {
					got := w.apply(t, race.Actions[index])
					if got.status != order.Statuses[step] {
						t.Fatalf("%s step %d: status %d want %d", race.Actions[index].Op, step, got.status, order.Statuses[step])
					}
				}
				if race.ID == "read-send" {
					// Either order leaves the new message unread.
					if n, _ := db.DirectUnreadTotal(context.Background(), w.conn, 2); n != 1 {
						t.Fatalf("recipient unread %d want 1 after both orders", n)
					}
				}
				if race.ID == "unfollow-send" || race.ID == "duplicate-send" || race.ID == "conflicting-send" {
					var n int
					w.conn.QueryRow(`SELECT COUNT(*) FROM private_messages WHERE id>502`).Scan(&n)
					if n > 1 {
						t.Fatalf("%d new messages", n)
					}
				}
			})
		}
	}
	if ran != 8 {
		t.Fatalf("ran %d ordered race cases, want 8", ran)
	}
}

/*---------------------------------------------------------------------------
  delivery authorization and image bounds
---------------------------------------------------------------------------*/

// A queued dm.message is re-authorized at the socket write: the recipient's
// session receives it only while the live predicate holds.
func TestDirectMessageDeliveryFixtures(t *testing.T) {
	requireLocalTCPListener(t)
	pack := loadDMPack(t)
	ran := 0
	for _, c := range pack.Delivery {
		if c.Type != "dm.message" {
			continue
		}
		ran++
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, c.Given)
			probe := w.probes[c.Viewer]
			if probe == nil {
				if c.Deliver {
					t.Fatal("viewer could not connect but delivery was expected")
				}
				return // an inactive account has no session to deliver to
			}
			frame, _ := json.Marshal(map[string]any{"type": "dm.message", "payload": map[string]any{
				"id": 503, "sender_id": c.Sender, "recipient_id": c.Target, "sender_username": "x", "body": "queued", "created_at": pack.Clock, "client_id": nil,
			}})
			if err := w.hub.SendToUser(c.Viewer, frame); err != nil {
				t.Fatal(err)
			}
			w.quiesce()
			if got := len(probe.of("dm.message")) == 1; got != c.Deliver {
				t.Fatalf("delivered=%v want %v", got, c.Deliver)
			}
		})
	}
	if ran != 5 {
		t.Fatalf("ran %d dm.message delivery cases, want 5", ran)
	}
}

func paddedImage(t *testing.T, format string, width, height, total int) []byte {
	t.Helper()
	img := image.NewPaletted(image.Rect(0, 0, width, height), palette.Plan9[:16])
	var b bytes.Buffer
	switch format {
	case "image/png":
		if err := png.Encode(&b, img); err != nil {
			t.Fatal(err)
		}
	case "image/jpeg":
		if err := jpeg.Encode(&b, img, nil); err != nil {
			t.Fatal(err)
		}
	default:
		if err := gif.Encode(&b, img, nil); err != nil {
			t.Fatal(err)
		}
	}
	out := b.Bytes()
	need := total - len(out)
	if need < 0 {
		t.Fatalf("%s is already %d bytes, over %d", format, len(out), total)
	}
	if format != "image/gif" {
		return append(out, make([]byte, need)...) // trailing bytes after the end marker
	}
	// A GIF must end at its trailer: pad with a comment extension before it.
	data := need - 3
	for blocks := (data + 254) / 255; 3+data+blocks != need; {
		data--
		blocks = (data + 254) / 255
	}
	ext := []byte{0x21, 0xfe}
	for left := data; left > 0; {
		n := left
		if n > 255 {
			n = 255
		}
		ext = append(ext, byte(n))
		ext = append(ext, make([]byte, n)...)
		left -= n
	}
	ext = append(ext, 0)
	return append(append(append([]byte{}, out[:len(out)-1]...), ext...), 0x3b)
}

func manyFrameGIF(t *testing.T, frames, canvas, size int) []byte {
	t.Helper()
	g := &gif.GIF{Config: image.Config{ColorModel: color.Palette(palette.Plan9[:2]), Width: canvas, Height: canvas}}
	for i := 0; i < frames; i++ {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, size, size), palette.Plan9[:2]))
		g.Delay = append(g.Delay, 0)
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, g); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func postDMImage(t *testing.T, w *dmWorld, actor int64, target int, name, contentType string, data []byte, extra map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image"; filename=%q`, name))
	h.Set("Content-Type", contentType)
	part, err := form.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	part.Write(data)
	for k, v := range extra {
		form.WriteField(k, v)
	}
	form.Close()
	req := httptest.NewRequest("POST", fmt.Sprintf("/api/v1/chats/%d/images", target), &body)
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.AddCookie(&http.Cookie{Name: "session_token", Value: fmt.Sprintf("b18-fixture-%d", actor)})
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, req)
	return rec
}

func TestDirectMessageImageBoundFixtures(t *testing.T) {
	pack := loadDMPack(t)
	if len(pack.Media) != 12 {
		t.Fatalf("pack has %d media cases", len(pack.Media))
	}
	for _, c := range pack.Media {
		t.Run(c.ID, func(t *testing.T) {
			w := newDMWorld(t, pack, map[string]any{"users": map[string]any{"2": map[string]any{"online": false}, "3": map[string]any{"online": false}}})
			name := map[string]string{"image/png": "a.png", "image/jpeg": "a.jpg", "image/gif": "a.gif", "image/svg+xml": "a.svg"}[c.Mime]
			var data []byte
			extra := map[string]string(nil)
			switch {
			case c.Valid:
				data = paddedImage(t, c.Mime, c.Width, c.Height, c.Bytes)
			case c.Bytes > 5<<20:
				data = make([]byte, c.Bytes)
			case c.BodyBytes > 10<<20:
				data = make([]byte, c.BodyBytes)
			case c.Frames > 1 && c.Width == c.Height && c.Width > 1000:
				data = manyFrameGIF(t, c.Frames, c.Width, 1)
			case c.Frames > 1:
				data = manyFrameGIF(t, c.Frames, c.Width, c.Width)
			case c.DecodedMime != "":
				data = paddedImage(t, c.DecodedMime, 8, 8, 400)
			case c.Corrupt:
				data = []byte("GIF89a\x01\x00\x01")
			case c.Mime == "image/svg+xml":
				data = []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>`)
			case c.Width > 4096:
				data = paddedImage(t, "image/png", c.Width, c.Height, 5000)
				name, c.Mime = "a.png", "image/png"
			default:
				data = paddedImage(t, c.Mime, c.Width, c.Height, 1000)
			}
			if c.ExtraPart {
				extra = map[string]string{"user_id": "2"}
			}
			before := dmSnapshot(t, w.conn)
			rec := postDMImage(t, w, 1, 2, name, c.Mime, data, extra)
			if rec.Code != c.Status {
				t.Fatalf("status %d (%s) want %d", rec.Code, strings.TrimSpace(rec.Body.String()), c.Status)
			}
			if c.Status != 200 {
				if !reflect.DeepEqual(before, dmSnapshot(t, w.conn)) {
					t.Fatal("rejected upload changed state")
				}
				return
			}
			var staged struct {
				Data struct {
					URL string `json:"image_url"`
				}
			}
			json.Unmarshal(rec.Body.Bytes(), &staged)
			read := httptest.NewRecorder()
			req := httptest.NewRequest("GET", staged.Data.URL, nil)
			req.AddCookie(&http.Cookie{Name: "session_token", Value: "b18-fixture-1"})
			w.handler.ServeHTTP(read, req)
			if read.Code != 200 || !bytes.Equal(read.Body.Bytes(), data) {
				t.Fatalf("uploader read %d, %d bytes", read.Code, read.Body.Len())
			}
		})
	}
}
