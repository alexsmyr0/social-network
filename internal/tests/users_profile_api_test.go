package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestUserProfileEndpoint(t *testing.T) {
	h, db := newTestAPI(t)
	defer db.Close()

	// 1. Register a user
	regBody := `{"username":"profileuser","email":"profile@example.com","password":"password123","first_name":"Jane","last_name":"Doe","age":28,"gender":"female"}`
	rec, _ := doRequest(t, h, http.MethodPost, "/api/v1/users/register", []byte(regBody))

	if rec.Code != http.StatusCreated {
		t.Fatalf("registration failed: %d body=%s", rec.Code, rec.Body.String())
	}

	var regResp map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&regResp); err != nil {
		t.Fatalf("failed to decode registration response: %v", err)
	}

	data := regResp["data"].(map[string]any)
	userID := int64(data["id"].(float64))

	// 2. Extract session token
	token := extractToken(t, rec)

	// 3. Test GET /api/v1/users/{id}/profile (authenticated)
	rec3, _ := doRequestWithToken(t, h, http.MethodGet, fmt.Sprintf("/api/v1/users/%d/profile", userID), token, nil)

	if rec3.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d body=%s", rec3.Code, rec3.Body.String())
	}

	var profileResp map[string]any
	if err := json.NewDecoder(rec3.Body).Decode(&profileResp); err != nil {
		t.Fatalf("failed to decode profile response: %v", err)
	}

	profile := profileResp["data"].(map[string]any)
	if profile["username"] != "profileuser" {
		t.Errorf("expected username 'profileuser', got '%v'", profile["username"])
	}
	if profile["first_name"] != "Jane" {
		t.Errorf("expected first_name 'Jane', got '%v'", profile["first_name"])
	}
	if profile["last_name"] != "Doe" {
		t.Errorf("expected last_name 'Doe', got '%v'", profile["last_name"])
	}
	if profile["age"].(float64) != 28 {
		t.Errorf("expected age 28, got '%v'", profile["age"])
	}
	if profile["gender"] != "female" {
		t.Errorf("expected gender 'female', got '%v'", profile["gender"])
	}

	// 4. Test unauthenticated access (should be blocked by Auth middleware)
	rec4, _ := doRequest(t, h, http.MethodGet, fmt.Sprintf("/api/v1/users/%d/profile", userID), nil)

	if rec4.Code != http.StatusUnauthorized {
		t.Errorf("expected status 401 for unauthenticated profile access, got %d", rec4.Code)
	}
}
