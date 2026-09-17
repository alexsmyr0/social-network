// internal/tests/chat_history_test.go
package tests

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"forum/internal/db"
)

func TestChatHistory_Unauthorized(t *testing.T) {
	h, _ := newTestAPI(t)

	tests := []struct {
		name string
		path string
		want int
	}{
		{"no messages suffix", "/api/v1/chats/1", http.StatusUnauthorized},
		{"missing user id", "/api/v1/chats/messages", http.StatusUnauthorized},
		{"invalid user id", "/api/v1/chats/abc/messages", http.StatusUnauthorized},
		{"negative user id", "/api/v1/chats/-1/messages", http.StatusUnauthorized},
		{"zero user id", "/api/v1/chats/0/messages", http.StatusUnauthorized},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec, _ := doRequest(t, h, http.MethodGet, tt.path, nil)
			if rec.Code != tt.want {
				t.Errorf("expected %d, got %d body=%s", tt.want, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestChatHistory_AuthenticatedNoMessages(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  "alice",
		Email:     fmt.Sprintf("alice_%d@example.com", now),
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: "Alice",
		LastName:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}
	bobID, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  "bob",
		Email:     fmt.Sprintf("bob_%d@example.com", now),
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: "Bob",
		LastName:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, fmt.Sprintf("alice_%d@example.com", now))

	rec, body := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d body=%s", rec.Code, body)
	}

	var resp struct {
		Data struct {
			Messages []any `json:"messages"`
			HasMore  bool  `json:"has_more"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if len(resp.Data.Messages) != 0 {
		t.Errorf("expected 0 messages, got %d", len(resp.Data.Messages))
	}
	if resp.Data.HasMore != false {
		t.Errorf("expected has_more=false, got %v", resp.Data.HasMore)
	}
}

func TestChatHistory_WithMessages(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  "alice",
		Email:     fmt.Sprintf("alice_%d@example.com", now),
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: "Alice",
		LastName:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}
	bobID, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  "bob",
		Email:     fmt.Sprintf("bob_%d@example.com", now),
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: "Bob",
		LastName:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}
	charlieID, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  "charlie",
		Email:     fmt.Sprintf("charlie_%d@example.com", now),
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: "Charlie",
		LastName:  "Test",
	})
	if err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, fmt.Sprintf("alice_%d@example.com", now))

	// Alice sends messages to Bob
	for i := 0; i < 5; i++ {
		_, err := sqlDB.ExecContext(ctx, `INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
			aliceID, bobID, "hello from alice")
		if err != nil {
			t.Fatalf("insert message alice->bob: %v", err)
		}
	}
	// Bob sends messages to Alice
	for i := 0; i < 7; i++ {
		_, err := sqlDB.ExecContext(ctx, `INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
			bobID, aliceID, "hi from bob")
		if err != nil {
			t.Fatalf("insert message bob->alice: %v", err)
		}
	}

	// Charlie sends messages to Alice (shouldn't appear in alice-bob conversation)
	_, err = sqlDB.ExecContext(ctx, `INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		charlieID, aliceID, "charlie to alice")
	if err != nil {
		t.Fatalf("insert message charlie->alice: %v", err)
	}

	// Alice queries messages with Bob (userID = bobID)
	rec, body := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d body=%s", rec.Code, body)
	}

	var resp struct {
		Data struct {
			Messages []struct {
				ID             int64  `json:"id"`
				SenderID       int64  `json:"sender_id"`
				RecipientID    int64  `json:"recipient_id"`
				SenderUsername string `json:"sender_username"`
				Body           string `json:"body"`
				CreatedAt      string `json:"created_at"`
			} `json:"messages"`
			HasMore bool `json:"has_more"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	// Should return 10 messages (latest 10) - 5 from alice + 5 from bob = 10
	if len(resp.Data.Messages) != 10 {
		t.Errorf("expected 10 messages, got %d", len(resp.Data.Messages))
	}

	// Should be in chronological order (oldest first)
	for i := 1; i < len(resp.Data.Messages); i++ {
		if resp.Data.Messages[i].ID <= resp.Data.Messages[i-1].ID {
			t.Errorf("messages not in chronological order at index %d", i)
		}
	}

	// has_more should be true (5+7=12 total, we got 10, so more exists)
	if !resp.Data.HasMore {
		t.Errorf("expected has_more=true, got false")
	}
	_ = rec
}

func TestChatHistory_ResponseFormat(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	_, aliceEmail, err := createUserForTest(ctx, sqlDB, "alice2", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bob2", now)
	if err != nil {
		t.Fatal(err)
	}

	token := loginTestUserByEmail(t, h, aliceEmail)

	rec, body := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, body)
	}

	// Verify the response has the "data" wrapper as per SDS
	var resp map[string]any
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if _, ok := resp["data"]; !ok {
		t.Errorf("response missing 'data' wrapper")
	}
}

func TestChatHistory_SenderUsernameIncluded(t *testing.T) {
	h, sqlDB := newTestAPI(t)
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

	// Alice sends message to Bob
	_, err = sqlDB.ExecContext(ctx, `INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "test message")
	if err != nil {
		t.Fatal(err)
	}

	rec, body := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	var resp struct {
		Data struct {
			Messages []struct {
				SenderID       int64  `json:"sender_id"`
				SenderUsername string `json:"sender_username"`
			} `json:"messages"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatal(err)
	}

	if len(resp.Data.Messages) == 0 {
		t.Fatal("expected at least one message")
	}

	if resp.Data.Messages[0].SenderUsername == "" {
		t.Error("sender_username should not be empty")
	}
	_ = rec
}

func TestChatHistory_InvalidBeforeID(t *testing.T) {
	h, sqlDB := newTestAPI(t)
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

	token := loginTestUserByEmail(t, h, aliceEmail)

	tests := []struct {
		name       string
		beforeID   string
		wantStatus int
	}{
		{"negative", "-1", http.StatusBadRequest},
		{"zero", "0", http.StatusBadRequest},
		{"invalid", "abc", http.StatusBadRequest},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := fmt.Sprintf("/api/v1/chats/%d/messages?before_id=%s", bobID, tt.beforeID)
			rec, _ := doRequestWithToken(t, h, http.MethodGet, path, token, nil)
			if rec.Code != tt.wantStatus {
				t.Errorf("expected %d, got %d", tt.wantStatus, rec.Code)
			}
		})
	}
}

// Helper to create a user and return ID + email
func createUserForTest(ctx context.Context, sqlDB *sql.DB, username string, now int64) (int64, string, error) {
	email := fmt.Sprintf("%s_%d@example.com", username, now)
	id, err := db.CreateUser(ctx, sqlDB, db.CreateUserRequest{
		Username:  username,
		Email:     email,
		Password:  "password123",
		Age:       20,
		Gender:    "other",
		FirstName: username,
		LastName:  "Test",
	})
	return id, email, err
}

/*---------------------------------------------------------
  REGRESSION TESTS — expose known bugs in current C03 impl
----------------------------------------------------------*/

// TestChatHistory_HasMoreFalse_ExactlyTen exposes the false-positive in the
// has_more calculation. The handler uses `len(messages) == 10` as a proxy, which
// incorrectly returns true when the conversation has exactly 10 messages and there
// is nothing left to paginate.
//
// EXPECTED: has_more = false (no older messages exist)
// ACTUAL (buggy): has_more = true
func TestChatHistory_HasMoreFalse_ExactlyTen(t *testing.T) {
	h, sqlDB := newTestAPI(t)
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

	// Insert exactly 10 messages — the page limit, nothing more.
	for i := 0; i < 10; i++ {
		_, err := sqlDB.ExecContext(ctx,
			`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
			aliceID, bobID, fmt.Sprintf("msg %d", i+1),
		)
		if err != nil {
			t.Fatalf("insert message: %v", err)
		}
	}

	token := loginTestUserByEmail(t, h, aliceEmail)
	rec, body := doRequestWithToken(t, h, http.MethodGet,
		fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, body)
	}

	var resp struct {
		Data struct {
			Messages []any `json:"messages"`
			HasMore  bool  `json:"has_more"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(resp.Data.Messages) != 10 {
		t.Fatalf("expected 10 messages, got %d", len(resp.Data.Messages))
	}
	if resp.Data.HasMore {
		t.Error("has_more should be false when the conversation has exactly 10 messages (nothing left to paginate)")
	}
}

// TestChatHistory_HasMoreFalse_LastPage exposes the same false-positive on the
// last page of a paginated conversation. With 20 total messages, the second page
// (before_id = first message on page 1) returns exactly 10 older messages and
// has_more should be false — but the handler returns true.
//
// EXPECTED: has_more = false on the final page
// ACTUAL (buggy): has_more = true
func TestChatHistory_HasMoreFalse_LastPage(t *testing.T) {
	h, sqlDB := newTestAPI(t)
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

	// Insert exactly 20 messages — two full pages of 10.
	for i := 0; i < 20; i++ {
		_, err := sqlDB.ExecContext(ctx,
			`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
			aliceID, bobID, fmt.Sprintf("msg %d", i+1),
		)
		if err != nil {
			t.Fatalf("insert message: %v", err)
		}
	}

	token := loginTestUserByEmail(t, h, aliceEmail)

	// Page 1: latest 10 (msgs 11-20). has_more should be true — there are 10 older.
	_, body := doRequestWithToken(t, h, http.MethodGet,
		fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	var page1 struct {
		Data struct {
			Messages []struct {
				ID int64 `json:"id"`
			} `json:"messages"`
			HasMore bool `json:"has_more"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &page1); err != nil {
		t.Fatalf("unmarshal page1: %v", err)
	}
	if len(page1.Data.Messages) != 10 {
		t.Fatalf("page1: expected 10 messages, got %d", len(page1.Data.Messages))
	}
	if !page1.Data.HasMore {
		t.Error("page1: has_more should be true (10 older messages exist)")
	}

	// Page 2: 10 messages older than the oldest on page 1. Nothing left after that.
	oldestOnPage1 := page1.Data.Messages[0].ID
	_, body = doRequestWithToken(t, h, http.MethodGet,
		fmt.Sprintf("/api/v1/chats/%d/messages?before_id=%d", bobID, oldestOnPage1), token, nil)

	var page2 struct {
		Data struct {
			Messages []any `json:"messages"`
			HasMore  bool  `json:"has_more"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &page2); err != nil {
		t.Fatalf("unmarshal page2: %v", err)
	}
	if len(page2.Data.Messages) != 10 {
		t.Fatalf("page2: expected 10 messages, got %d", len(page2.Data.Messages))
	}
	if page2.Data.HasMore {
		t.Error("page2: has_more should be false — this is the last page, no older messages exist")
	}
}

// TestChatHistory_SenderUsername_ExactMatch verifies that sender_username in the
// response matches the actual registered username precisely, not just any non-empty
// string. The current test only checks != "" which would pass even if the handler
// returned "unknown" due to a DB error fallback.
func TestChatHistory_SenderUsername_ExactMatch(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, aliceEmail, err := createUserForTest(ctx, sqlDB, "aliceexact", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, _, err := createUserForTest(ctx, sqlDB, "bobexact", now)
	if err != nil {
		t.Fatal(err)
	}

	// Alice sends to bob; bob sends to alice.
	_, err = sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "from alice",
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		bobID, aliceID, "from bob",
	)
	if err != nil {
		t.Fatal(err)
	}

	// Query as alice — both messages should appear.
	token := loginTestUserByEmail(t, h, aliceEmail)
	_, body := doRequestWithToken(t, h, http.MethodGet,
		fmt.Sprintf("/api/v1/chats/%d/messages", bobID), token, nil)

	var resp struct {
		Data struct {
			Messages []struct {
				SenderID       int64  `json:"sender_id"`
				SenderUsername string `json:"sender_username"`
			} `json:"messages"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Data.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(resp.Data.Messages))
	}

	for _, msg := range resp.Data.Messages {
		var wantUsername string
		if msg.SenderID == aliceID {
			wantUsername = "aliceexact"
		} else if msg.SenderID == bobID {
			wantUsername = "bobexact"
		} else {
			t.Errorf("unexpected sender_id %d", msg.SenderID)
			continue
		}
		if msg.SenderUsername != wantUsername {
			t.Errorf("sender_id=%d: expected sender_username=%q, got %q",
				msg.SenderID, wantUsername, msg.SenderUsername)
		}
	}
}

// TestChatHistory_SenderUsername_OrphanedSender verifies that the handler handles
// a message whose sender no longer exists in the users table. The test DB has foreign
// keys disabled, so we can insert such an orphaned message directly.
//
// The handler currently silently returns sender_username="" for missing users in
// the non-error path (GetUsersByIDs returns empty results, not an error). The
// "unknown" fallback only fires on DB errors, not on missing rows.
//
// EXPECTED: a deterministic non-empty fallback (e.g. "unknown" or a 500)
// ACTUAL (buggy): sender_username = "" — an empty string leaks to the client
func TestChatHistory_SenderUsername_OrphanedSender(t *testing.T) {
	h, sqlDB := newTestAPI(t)
	defer sqlDB.Close()

	ctx := context.Background()
	now := time.Now().UnixNano()

	aliceID, _, err := createUserForTest(ctx, sqlDB, "alice", now)
	if err != nil {
		t.Fatal(err)
	}
	bobID, bobEmail, err := createUserForTest(ctx, sqlDB, "bob", now)
	if err != nil {
		t.Fatal(err)
	}

	// Log in as bob before deleting alice.
	token := loginTestUserByEmail(t, h, bobEmail)

	// Insert a message from alice to bob.
	_, err = sqlDB.ExecContext(ctx,
		`INSERT INTO private_messages (sender_id, recipient_id, body) VALUES (?, ?, ?)`,
		aliceID, bobID, "ghost message",
	)
	if err != nil {
		t.Fatal(err)
	}

	// Delete alice — her user row is gone but the message row survives because
	// foreign keys are off in the test DB (plain :memory: without _foreign_keys=on).
	if _, err := sqlDB.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, aliceID); err != nil {
		t.Fatalf("delete alice: %v", err)
	}

	// Bob queries his conversation with alice. The message still exists but
	// GetUsersByIDs returns no rows for alice's ID (no error, just empty result).
	// The handler should not silently return sender_username="" to the client.
	_, body := doRequestWithToken(t, h, http.MethodGet,
		fmt.Sprintf("/api/v1/chats/%d/messages", aliceID), token, nil)

	var resp struct {
		Data struct {
			Messages []struct {
				SenderUsername string `json:"sender_username"`
			} `json:"messages"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Data.Messages) == 0 {
		t.Skip("message was cascade-deleted with the user — foreign keys may be on in this environment")
	}

	for _, msg := range resp.Data.Messages {
		if msg.SenderUsername == "" {
			t.Error("sender_username must not be empty when sender no longer exists in users table")
		}
	}

	_ = bobID
}
