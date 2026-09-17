// internal/tests/users_profile_schema_test.go
package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	db "forum/internal/db"
)

func TestUserProfileSchema_FieldsPersisted(t *testing.T) {
	conn := setupTestDB(t)
	defer conn.Close()

	id, err := db.CreateUser(context.Background(), conn, db.CreateUserRequest{
		Username:  "profileuser",
		Email:     "profile@example.com",
		Password:  "password123",
		Age:       25,
		Gender:    "female",
		FirstName: "Profile",
		LastName:  "User",
	})
	if err != nil {
		t.Fatalf("CreateUser failed: %v", err)
	}

	user, err := db.GetUser(context.Background(), conn, id)
	if err != nil {
		t.Fatalf("GetUser failed: %v", err)
	}

	if user.Age != 25 {
		t.Errorf("expected age 25, got %d", user.Age)
	}
	if user.Gender != "female" {
		t.Errorf("expected gender %q, got %q", "female", user.Gender)
	}
	if user.FirstName != "Profile" {
		t.Errorf("expected first_name %q, got %q", "Profile", user.FirstName)
	}
	if user.LastName != "User" {
		t.Errorf("expected last_name %q, got %q", "User", user.LastName)
	}
}

func TestUserProfileSchema_ExistingReadIntact(t *testing.T) {
	conn := setupTestDB(t)
	defer conn.Close()

	// setupTestDB seeds "testuser" as the first user (id=1) with known profile fields.
	user, err := db.GetUser(context.Background(), conn, 1)
	if err != nil {
		t.Fatalf("GetUser for seeded user failed: %v", err)
	}
	if user.Username != "testuser" {
		t.Errorf("expected username %q, got %q", "testuser", user.Username)
	}
	if user.Email != "test@example.com" {
		t.Errorf("expected email %q, got %q", "test@example.com", user.Email)
	}
	if user.Age != 20 {
		t.Errorf("expected age 20 for seeded user, got %d", user.Age)
	}
	if user.Gender != "other" {
		t.Errorf("expected gender %q for seeded user, got %q", "other", user.Gender)
	}
	if user.FirstName != "Test" {
		t.Errorf("expected first_name %q for seeded user, got %q", "Test", user.FirstName)
	}
	if user.LastName != "User" {
		t.Errorf("expected last_name %q for seeded user, got %q", "User", user.LastName)
	}
}

func TestUserProfileSchema_APIResponseIncludesProfileFields(t *testing.T) {
	h, conn := newTestAPI(t)
	defer conn.Close()

	// Register a user with full profile data via the HTTP API.
	body := `{"username":"apiprofuser","email":"apiprof@example.com","password":"password123","age":28,"gender":"male","first_name":"Api","last_name":"Prof"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register failed: %d body=%s", rec.Code, rec.Body.String())
	}

	var regResp struct {
		Data struct {
			ID float64 `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&regResp); err != nil {
		t.Fatalf("decode register response: %v", err)
	}

	token := extractToken(t, rec)

	// GET /api/v1/users/me and verify profile fields are present in the JSON response.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req.Header.Set("Cookie", "session_token="+token)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /me failed: %d body=%s", rec.Code, rec.Body.String())
	}

	var meResp struct {
		Data struct {
			Age       int    `json:"age"`
			Gender    string `json:"gender"`
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&meResp); err != nil {
		t.Fatalf("decode /me response: %v", err)
	}

	if meResp.Data.Age != 28 {
		t.Errorf("expected age 28 in API response, got %d", meResp.Data.Age)
	}
	if meResp.Data.Gender != "male" {
		t.Errorf("expected gender %q in API response, got %q", "male", meResp.Data.Gender)
	}
	if meResp.Data.FirstName != "Api" {
		t.Errorf("expected first_name %q in API response, got %q", "Api", meResp.Data.FirstName)
	}
	if meResp.Data.LastName != "Prof" {
		t.Errorf("expected last_name %q in API response, got %q", "Prof", meResp.Data.LastName)
	}
}

func TestUserProfileSchema_MultipleUsers(t *testing.T) {
	conn := setupTestDB(t)
	defer conn.Close()

	users := []db.CreateUserRequest{
		{Username: "alice", Email: "alice@example.com", Password: "password123", Age: 30, Gender: "female", FirstName: "Alice", LastName: "Smith"},
		{Username: "bob", Email: "bob@example.com", Password: "password123", Age: 22, Gender: "male", FirstName: "Bob", LastName: "Jones"},
	}

	for _, req := range users {
		id, err := db.CreateUser(context.Background(), conn, req)
		if err != nil {
			t.Fatalf("CreateUser(%s) failed: %v", req.Username, err)
		}
		got, err := db.GetUser(context.Background(), conn, id)
		if err != nil {
			t.Fatalf("GetUser(%s) failed: %v", req.Username, err)
		}
		if got.Age != req.Age || got.Gender != req.Gender || got.FirstName != req.FirstName || got.LastName != req.LastName {
			t.Errorf("user %s: profile fields mismatch: got age=%d gender=%q first=%q last=%q",
				req.Username, got.Age, got.Gender, got.FirstName, got.LastName)
		}
	}
}
