package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"sync"
	"testing"

	"forum/internal/db"
)

// TestDiscussionContractFixtures replays every approved Phase 3 HTTP case that
// SN-B15 does not own (comments, reactions, profile/private activity, categories,
// navigation, legacy-media aliases and notices) through the real router, checking
// bodies, headers, persisted postconditions, unchanged state and exact signals.
func TestDiscussionContractFixtures(t *testing.T) {
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
		if publishingFixtureRoute(c.Request.Path) {
			continue
		}
		ran++
		t.Run(c.Name, func(t *testing.T) {
			handler, conn := socialAPI(t)
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
			before := publishingStateSnapshot(t, conn)
			var mu sync.Mutex
			signals := []string{}
			record := func(kind string, ids []int64) {
				mu.Lock()
				defer mu.Unlock()
				if kind == "social.invalidate" && len(ids) == 0 {
					signals = append(signals, kind+":all")
				}
				for _, id := range ids {
					signals = append(signals, fmt.Sprintf("%s:%d", kind, id))
				}
			}
			db.SetSocialInvalidationHook(func(ids []int64) { record("social.invalidate", ids) })
			db.SetNotificationHook(func(id int64) { record("notification.new", []int64{id}) })
			t.Cleanup(func() { db.SetSocialInvalidationHook(nil); db.SetNotificationHook(nil) })
			request := publishingFixtureRequest(t, c)
			if c.Viewer != nil {
				fixtureExec(t, conn, `INSERT INTO sessions(user_id,token,ip,user_agent)VALUES(?,'b16-fixture','','')`, *c.Viewer)
				request.AddCookie(&http.Cookie{Name: "session_token", Value: "b16-fixture"})
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
			if len(c.Response.Body) > 0 {
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
			} else if response.Body.Len() != 0 {
				t.Fatalf("expected empty body, got %s", response.Body.String())
			}
			assertPublishingFixtureState(t, conn, c.ExpectState, c.Viewer)
			want := []string{}
			for _, s := range c.Signals {
				recipients, _ := s.Recipients.([]any)
				if s.Recipients == "all_authenticated" {
					want = append(want, s.Type+":all")
				}
				for _, id := range recipients {
					want = append(want, fmt.Sprintf("%s:%v", s.Type, id))
				}
			}
			sort.Strings(want)
			mu.Lock()
			sort.Strings(signals)
			got := append([]string{}, signals...)
			mu.Unlock()
			if !reflect.DeepEqual(append([]string{}, got...), append([]string{}, want...)) {
				t.Fatalf("signals %v want %v", got, want)
			}
			if c.Unchanged {
				if after := publishingStateSnapshot(t, conn); !reflect.DeepEqual(before, after) {
					t.Fatalf("failed/noop request mutated content\nbefore %v\nafter %v", before, after)
				}
			}
		})
	}
	if ran != 62 {
		t.Fatalf("B16 fixture ownership filter ran %d cases, want 62", ran)
	}
}
