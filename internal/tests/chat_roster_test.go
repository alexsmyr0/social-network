// internal/tests/chat_roster_test.go
package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestChatRoster_Unauthorized(t *testing.T) {
	h, _ := newTestAPI(t)

	rec, _ := doRequest(t, h, http.MethodGet, "/api/v1/chats", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestChatRoster_OnlyOtherUsers(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	rec, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, body)
	}

	var resp struct {
		Data []struct {
			UserID   int64  `json:"user_id"`
			Username string `json:"username"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// alice should never appear in alice's own roster; bob must appear.
	seenBob := false
	for _, e := range resp.Data {
		if e.UserID == aliceID {
			t.Errorf("viewer must not appear in own roster")
		}
		if e.UserID == bobID {
			seenBob = true
		}
	}
	if !seenBob {
		t.Errorf("expected bob (%d) in roster", bobID)
	}
}

func TestChatRoster_PresenceReflected(t *testing.T) {
	h, sqlDB, hub := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}
	charlieID, _, err := createUserForTest(ctx, sqlDB, "charlie", now)
	if err != nil {
		t.Fatal(err)
	}

	// Mark bob online (charlie stays offline). nil conn is fine — presence-only,
	// we never write to the connection in this test.
	hub.Add(bobID, nil)

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var resp struct {
		Data []struct {
			UserID   int64 `json:"user_id"`
			IsOnline bool  `json:"is_online"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got := map[int64]bool{}
	for _, e := range resp.Data {
		got[e.UserID] = e.IsOnline
	}
	if !got[bobID] {
		t.Errorf("bob should be online")
	}
	if got[charlieID] {
		t.Errorf("charlie should be offline")
	}
}

// TestChatRoster_OrderingByLastMessage verifies that users with message history
// come first, sorted by last_message_at DESC, and users without history follow,
// sorted by username ASC (case-insensitive).
func TestChatRoster_OrderingByLastMessage(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	// bob: oldest message with alice
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}
	// carol: newest message with alice → should sort first
	carolID, _, err := createUserForTest(ctx, sqlDB, "carol", now)
	if err != nil {
		t.Fatal(err)
	}
	// zach: no history, alphabetical fallback
	zachID, _, err := createUserForTest(ctx, sqlDB, "zach", now)
	if err != nil {
		t.Fatal(err)
	}
	// Adam: no history; uppercase to verify case-insensitive sort places it
	// before "zach".
	adamID, _, err := createUserForTest(ctx, sqlDB, "Adam", now)
	if err != nil {
		t.Fatal(err)
	}

	// alice ↔ bob first (older), then alice ↔ carol (newer). The auto-increment
	// ID dictates the row order; created_at follows id by construction in the
	// test path because inserts happen sequentially.
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "old hi"); err != nil {
		t.Fatal(err)
	}
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		carolID, aliceID, "new hi"); err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var resp struct {
		Data []struct {
			UserID   int64 `json:"user_id"`
			Username string
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Filter to the IDs we created — the seed test fixture also creates a user
	// (id=1) which legitimately appears in the roster.
	tracked := map[int64]bool{bobID: true, carolID: true, zachID: true, adamID: true}
	var gotOrder []int64
	for _, e := range resp.Data {
		if tracked[e.UserID] {
			gotOrder = append(gotOrder, e.UserID)
		}
	}
	wantOrder := []int64{carolID, bobID, adamID, zachID}
	if fmt.Sprint(gotOrder) != fmt.Sprint(wantOrder) {
		t.Errorf("order mismatch:\n  got:  %v\n  want: %v", gotOrder, wantOrder)
	}
}

// TestChatRoster_DBError_Returns500 drives the DB-error branch of the handler.
// Auth uses the `users` and `sessions` tables; we drop `private_messages` after
// login so the session validates but the roster query fails. The handler must
// surface a 500 with the agreed error envelope.
func TestChatRoster_DBError_Returns500(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	token := loginTestUserByEmail(t, h, aliceEmail)

	if _, err := sqlDB.ExecContext(ctx, `DROP TABLE private_messages`); err != nil {
		t.Fatalf("drop table: %v", err)
	}

	rec, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d body=%s", rec.Code, body)
	}
	if !strings.Contains(string(body), "INTERNAL_SERVER_ERROR") {
		t.Errorf("expected error code INTERNAL_SERVER_ERROR in body: %s", body)
	}
}

// TestChatRoster_ResponseShape locks the JSON contract: every entry must carry
// exactly the field names defined in SDS § 5.3. Catches accidental field-name
// drift (e.g. `lastMessageAt` instead of `last_message_at`).
func TestChatRoster_ResponseShape(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := createUserForTest(ctx, sqlDB, "bob", now); err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var raw struct {
		Data []map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(raw.Data) == 0 {
		t.Fatal("expected at least one entry")
	}

	required := []string{
		"user_id", "username", "is_online",
		"last_message_at", "last_message_preview", "last_sender_id",
	}
	for i, entry := range raw.Data {
		for _, key := range required {
			if _, ok := entry[key]; !ok {
				t.Errorf("entry[%d] missing field %q", i, key)
			}
		}
		if len(entry) != len(required) {
			t.Errorf("entry[%d] has %d fields, want %d (extras: %v)",
				i, len(entry), len(required), entry)
		}
	}
}

// TestChatRoster_EmptyWhenNoOtherUsers verifies the API returns a non-nil
// empty array (`"data": []`) — never `null` — when the viewer is the only
// user. Frontend code typically expects an array; null would break .map().
func TestChatRoster_EmptyWhenNoOtherUsers(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	// Remove every other user (the seed `testuser` from setupTestDB and any
	// posts/comments that reference it via FK CASCADE).
	if _, err := sqlDB.ExecContext(ctx, `DELETE FROM users WHERE username <> ?`, "alice"); err != nil {
		t.Fatalf("clean other users: %v", err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	rec, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, body)
	}

	// Distinguish `[]` from `null` at the raw-bytes level — they parse to the
	// same Go nil slice but only `[]` is acceptable to the frontend.
	if !strings.Contains(string(body), `"data":[]`) {
		t.Errorf("expected empty array `\"data\":[]`, got: %s", string(body))
	}
}

// TestChatRoster_LatestSpansBothDirections verifies that the "last message"
// for a pair is determined by the most recent row in either direction — not
// just messages sent by the viewer.
func TestChatRoster_LatestSpansBothDirections(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}

	// alice → bob first, then bob → alice (newest). bob is the last sender.
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "from alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		bobID, aliceID, "from bob"); err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var resp struct {
		Data []struct {
			UserID             int64   `json:"user_id"`
			LastMessagePreview *string `json:"last_message_preview"`
			LastSenderID       *int64  `json:"last_sender_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, e := range resp.Data {
		if e.UserID != bobID {
			continue
		}
		if e.LastMessagePreview == nil || *e.LastMessagePreview != "from bob" {
			t.Errorf("expected last preview \"from bob\", got %v", e.LastMessagePreview)
		}
		if e.LastSenderID == nil || *e.LastSenderID != bobID {
			t.Errorf("expected last_sender_id=%d, got %v", bobID, e.LastSenderID)
		}
	}
}

// TestChatRoster_PreviewTruncated verifies that very long DM bodies do not
// flow through the roster verbatim — the server caps `last_message_preview`
// to keep the payload bounded.
func TestChatRoster_PreviewTruncated(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}

	longBody := strings.Repeat("a", 5000)
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, longBody); err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var resp struct {
		Data []struct {
			UserID             int64   `json:"user_id"`
			LastMessagePreview *string `json:"last_message_preview"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, e := range resp.Data {
		if e.UserID != bobID {
			continue
		}
		if e.LastMessagePreview == nil {
			t.Fatal("preview should be set")
		}
		if got := len(*e.LastMessagePreview); got > 1024 {
			// upper bound check — actual cap is 200 chars; this guards against a
			// regression where the cap is removed entirely.
			t.Errorf("preview not truncated: length=%d", got)
		}
		if got := len(*e.LastMessagePreview); got >= len(longBody) {
			t.Errorf("preview not truncated: length=%d, original=%d", got, len(longBody))
		}
	}
}

func TestChatRoster_LastMessageMetadata(t *testing.T) {
	h, sqlDB, _ := newTestAPIWithHub(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}
	// carol: no history
	carolID, _, err := createUserForTest(ctx, sqlDB, "carol", now)
	if err != nil {
		t.Fatal(err)
	}

	// bob → alice is the latest message; the roster entry for bob should
	// reflect bob as last_sender_id and surface his body as preview.
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "earlier"); err != nil {
		t.Fatal(err)
	}
	if _, err := sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		bobID, aliceID, "see you soon"); err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet, "/api/v1/chats", token, nil)

	var resp struct {
		Data []struct {
			UserID             int64   `json:"user_id"`
			LastMessageAt      *string `json:"last_message_at"`
			LastMessagePreview *string `json:"last_message_preview"`
			LastSenderID       *int64  `json:"last_sender_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, e := range resp.Data {
		switch e.UserID {
		case bobID:
			if e.LastMessagePreview == nil || *e.LastMessagePreview != "see you soon" {
				t.Errorf("bob preview mismatch: %+v", e.LastMessagePreview)
			}
			if e.LastSenderID == nil || *e.LastSenderID != bobID {
				t.Errorf("bob last_sender_id should be %d", bobID)
			}
			if e.LastMessageAt == nil || *e.LastMessageAt == "" {
				t.Errorf("bob last_message_at should be set")
			}
		case carolID:
			if e.LastMessageAt != nil {
				t.Errorf("carol last_message_at should be null, got %q", *e.LastMessageAt)
			}
			if e.LastMessagePreview != nil {
				t.Errorf("carol last_message_preview should be null")
			}
			if e.LastSenderID != nil {
				t.Errorf("carol last_sender_id should be null")
			}
		}
	}
}
