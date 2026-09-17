// internal/tests/categories_test.go
package tests

import (
	"encoding/json"
	"net/http"
	"testing"
)

/* ------------
     DTOs
-------------*/

type categoryDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

/*--------------
	Helpers
--------------*/

func decodeEnvelope(t *testing.T, body []byte) apiEnvelope {
	t.Helper()

	var env apiEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("failed to decode envelope: %v", err)
	}

	if env.Error != nil {
		t.Fatalf("unexpected API error: %+v", env.Error)
	}

	return env
}

/*------------
    Tests
------------*/

func TestCategoriesList(t *testing.T) {
	h, db := newCategoryAPI(t)
	defer db.Close()

	rec := doReq(t, h, http.MethodGet, "/api/v1/categories", nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	env := decodeEnvelope(t, rec.Body.Bytes())

	var categories []categoryDTO
	if err := json.Unmarshal(env.Data, &categories); err != nil {
		t.Fatalf("failed to decode categories: %v", err)
	}

	if len(categories) == 0 {
		t.Fatalf("expected at least one category")
	}
}

func TestCategoriesGet(t *testing.T) {
	h, db := newCategoryAPI(t)
	defer db.Close()

	rec := doReq(t, h, "GET", "/api/v1/categories/1", nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var env apiEnvelope
	json.Unmarshal(rec.Body.Bytes(), &env)

	var cat map[string]any
	json.Unmarshal(env.Data, &cat)

	if cat["name"] != "Seed Category" {
		t.Fatalf("expected Seed Category, got %v", cat["name"])
	}
}
