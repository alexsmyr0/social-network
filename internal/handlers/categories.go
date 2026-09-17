// internal/handlers/categories.go
package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	repository "forum/internal/db"
	"forum/internal/middleware"
)

type CategoriesHandler struct {
	conn *sql.DB
}

func NewCategoriesHandler(database *sql.DB) *CategoriesHandler {
	return &CategoriesHandler{conn: database}
}

/*--------------------------------------
  HandleCategories: /api/v1/categories
--------------------------------------*/

func (c *CategoriesHandler) HandleCategories(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		c.listCategories(w, r)
	case http.MethodPost:
		c.createCategory(w, r)
	default:
		MethodNotAllowed(w, r)
	}
}

/*------------------
  INTERNAL HELPERS
------------------*/

func resolveCategoryID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := parseID(r.URL.Path, "/api/v1/categories/")
	if err != nil || id <= 0 {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"invalid category ID",
			http.StatusBadRequest,
		))
		return 0, false
	}
	return id, true
}

/*-----------------
  LIST CATEGORIES
-----------------*/

func (c *CategoriesHandler) listCategories(w http.ResponseWriter, r *http.Request) {
	categories, err := repository.ListCategories(r.Context(), c.conn)
	if err != nil {
		log.Printf("failed to list categories: %v", err)
		writeHandlerError(w, r, err, "failed to list categories")
		return
	}

	WriteOK(w, categories, nil)
}

/*------------------
  CREATE CATEGORY
------------------*/

func (c *CategoriesHandler) createCategory(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		strings.TrimSpace(req.Name) == "" {

		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"name is required",
			http.StatusBadRequest,
		))
		return
	}

	id, err := repository.CreateCategory(
		r.Context(),
		c.conn,
		req.Name,
	)
	if err != nil {
		log.Printf("failed to create category: %v", err)
		if isUniqueConstraint(err) {
			WriteError(w, r, NewError(
				"CONFLICT",
				"category name already exists",
				http.StatusConflict,
			))
			return
		}

		writeHandlerError(w, r, err, "failed to create category")
		return
	}

	category, err := repository.GetCategory(r.Context(), c.conn, id)
	if writeHandlerError(w, r, err, "category created but failed to load") {
		return
	}

	WriteCreated(w, category)
}

/*-----------------------------------------
  HandleCategory: /api/v1/categories/{id}
-----------------------------------------*/

func (c *CategoriesHandler) HandleCategory(w http.ResponseWriter, r *http.Request) {
	id, ok := resolveCategoryID(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		c.getCategory(w, r, id)
	case http.MethodPatch:
		c.updateCategory(w, r, id)
	case http.MethodDelete:
		c.deleteCategory(w, r, id)
	default:
		MethodNotAllowed(w, r)
	}
}

/*--------------
  GET CATEGORY
--------------*/

func (c *CategoriesHandler) getCategory(w http.ResponseWriter, r *http.Request, id int64) {
	category, err := repository.GetCategory(r.Context(), c.conn, id)
	if err != nil {
		log.Printf("failed to load category: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}

		writeHandlerError(w, r, err, "failed to load category")
		return
	}

	WriteOK(w, category, nil)
}

/*------------------
  UPDATE CATEGORY
------------------*/

func (c *CategoriesHandler) updateCategory(w http.ResponseWriter, r *http.Request, id int64) {
	var req struct {
		Name *string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"invalid json",
			http.StatusBadRequest,
		))
		return
	}

	if req.Name == nil || strings.TrimSpace(*req.Name) == "" {
		WriteError(w, r, NewError(
			"BAD_REQUEST",
			"name is required",
			http.StatusBadRequest,
		))
		return
	}

	if err := repository.UpdateCategoryName(
		r.Context(),
		c.conn,
		id,
		*req.Name,
	); err != nil {
		log.Printf("failed to update category: %v", err)
		if isUniqueConstraint(err) {
			WriteError(w, r, NewError(
				"CONFLICT",
				"category name already exists",
				http.StatusConflict,
			))
			return
		}

		writeHandlerError(w, r, err, "failed to update category")
		return
	}

	category, err := repository.GetCategory(r.Context(), c.conn, id)
	if err != nil {
		log.Printf("failed to load updated category: %v", err)
		writeHandlerError(w, r, err, "category updated but failed to load")
		return
	}

	WriteOK(w, category, nil)
}

/*------------------
  DELETE CATEGORY
------------------*/

func (c *CategoriesHandler) deleteCategory(w http.ResponseWriter, r *http.Request, id int64) {
	if err := repository.DeleteCategory(r.Context(), c.conn, id); err != nil {
		log.Printf("failed to delete category: %v", err)
		if errors.Is(err, sql.ErrNoRows) {
			notFound(w, r)
			return
		}

		writeHandlerError(w, r, err, "failed to delete category")
		return
	}

	WriteNoContent(w)
}

/*--------------------------------------------
  LIST CATEGORIES WITH POSTS (SUBFORUM VIEW)
  GET /api/v1/categories/view
--------------------------------------------*/

// GET /api/v1/categories/view
func (c *CategoriesHandler) ListCategoriesWithPosts(
	w http.ResponseWriter,
	r *http.Request,
) {
	if r.Method != http.MethodGet {
		MethodNotAllowed(w, r)
		return
	}

	// Extract logged-in user ID (or 0 if guest)
	userID, _ := middleware.GetUserID(r.Context())

	result, err := repository.ListCategoriesWithPosts(
		r.Context(),
		c.conn,
		userID,
	)
	if err != nil {
		writeHandlerError(w, r, err, "failed to list categories with posts")
		log.Printf("failed to list categories with posts: %v", err)
		return
	}

	WriteOK(w, result, nil)
}
