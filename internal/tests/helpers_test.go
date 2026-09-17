// internal/tests/helpers_test.go
package tests

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	db "forum/internal/db"
	"forum/internal/handlers"
	"forum/internal/router"
	"forum/internal/ws"
)

/*------------------------------------------------------------
	setupTestDB — Creates full schema + seeds user/category/post
-------------------------------------------------------------*/

func setupTestDB(t *testing.T) *sql.DB {
	t.Helper()

	dbConn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open in-memory sqlite: %v", err)
	}

	dbConn.SetMaxOpenConns(1)
	dbConn.SetMaxIdleConns(1)

	// Load schema
	schemaPath := filepath.Join("..", "db", "forum_schema.sql")
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		dbConn.Close()
		t.Fatalf("failed to read schema file %s: %v", schemaPath, err)
	}

	if _, err := dbConn.Exec(string(schemaBytes)); err != nil {
		dbConn.Close()
		t.Fatalf("failed to exec schema: %v", err)
	}

	/* -------------------------
	  SEED USER (correct bcrypt)
	---------------------------*/
	_, err = db.CreateUser(context.Background(), dbConn, db.CreateUserRequest{
		Username:  "testuser",
		Email:     "test@example.com",
		Password:  "password123",
		FirstName: "Test",
		LastName:  "User",
		Age:       20,
		Gender:    "other",
	})
	if err != nil {
		t.Fatalf("failed to seed test user: %v", err)
	}

	/* -----------------
	   SEED CATEGORY
	------------------*/
	_, err = dbConn.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES (
			1,
			'Test Category',
			strftime('%Y-%m-%dT%H:%M:%SZ','now')
		)
	`)
	if err != nil {
		t.Fatalf("failed to seed category: %v", err)
	}

	/* --------------
	    SEED POST
	---------------*/
	_, err = dbConn.Exec(`
		INSERT INTO posts (id, author_id, title, body, status, created_at, updated_at)
		VALUES (
			1,
			1,
			'Seed Post',
			'Seed post body',
			'published',
			strftime('%Y-%m-%dT%H:%M:%SZ','now'),
			strftime('%Y-%m-%dT%H:%M:%SZ','now')
		)
	`)
	if err != nil {
		t.Fatalf("failed to seed post: %v", err)
	}

	return dbConn
}

// newTestAPI builds the HTTP handler (router + middleware) using an in-memory DB.
func newTestAPI(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()
	h, db, _ := newTestAPIWithHub(t)
	return h, db
}

// newTestAPIWithHub is the same as newTestAPI but also exposes the WebSocket Hub,
// so tests that exercise presence-aware endpoints (roster, etc.) can simulate
// online users via hub.Add without spinning up a real WebSocket.
func newTestAPIWithHub(t *testing.T) (http.Handler, *sql.DB, *ws.Hub) {
	t.Helper()
	db := setupTestDB(t)
	hub := ws.NewHub()
	h := router.NewRouter(db, hub)
	return h, db, hub
}

// small helper to perform a request and return recorder + body bytes.
func doRequest(t *testing.T, h http.Handler, method, path string, body []byte) (*httptest.ResponseRecorder, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req = req.WithContext(context.Background())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	respBody := w.Body.Bytes()
	return w, respBody
}

func doRequestWithToken(t *testing.T, h http.Handler, method, path, token string, body []byte) (*httptest.ResponseRecorder, []byte) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req = req.WithContext(context.Background())
	req.Header.Set("Cookie", "session_token="+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	respBody := w.Body.Bytes()
	return w, respBody
}

// generic envelope used by API
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type apiEnvelope struct {
	Data  json.RawMessage `json:"data"`
	Meta  json.RawMessage `json:"meta,omitempty"`
	Error *apiError       `json:"error,omitempty"`
}

/*---------------------------------------------
	  setupTestDBForCategories — schema + seed
----------------------------------------------*/

func setupTestDBForCategories(t *testing.T) *sql.DB {
	t.Helper()

	dbConn, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("failed to open sqlite: %v", err)
	}

	schemaPath := filepath.Join("..", "db", "forum_schema.sql")
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("failed to read schema: %v", err)
	}

	if _, err := dbConn.Exec(string(schemaBytes)); err != nil {
		t.Fatalf("failed to exec schema: %v", err)
	}

	_, err = dbConn.Exec(`
		INSERT INTO categories (id, name, created_at)
		VALUES (1, 'Seed Category', datetime('now'))
	`)
	if err != nil {
		t.Fatalf("failed to seed category: %v", err)
	}

	return dbConn
}

/*----------------------------------------------------
	  newCategoryAPI — CLEAN handler wiring (NO router)
-----------------------------------------------------*/

func newCategoryAPI(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()

	db := setupTestDBForCategories(t)

	categories := handlers.NewCategoriesHandler(db)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/categories", categories.HandleCategories)
	mux.HandleFunc("/api/v1/categories/", categories.HandleCategory)

	return mux, db
}

/*-----------------
	  doReq helper
------------------*/

func doReq(
	t *testing.T,
	h http.Handler,
	method, path string,
	body []byte,
) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req = req.WithContext(context.Background())

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	return rec
}

func extractToken(t *testing.T, rec *httptest.ResponseRecorder) string {
	setCookie := rec.Header().Get("Set-Cookie")
	if setCookie == "" {
		t.Fatal("expected Set-Cookie header")
	}
	return strings.Split(strings.Split(setCookie, ";")[0], "=")[1]
}

func loginTestUser(t *testing.T, h http.Handler, username string) string {
	body := []byte(`{"username":"` + username + `","password":"password123"}`)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d", rec.Code)
	}

	return extractToken(t, rec)
}

func loginTestUserByEmail(t *testing.T, h http.Handler, email string) string {
	body := []byte(`{"email":"` + email + `","password":"password123"}`)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/login", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d body=%s", rec.Code, rec.Body.String())
	}

	return extractToken(t, rec)
}
