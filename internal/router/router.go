// internal/router/router.go
package router

import (
	"database/sql"
	"net/http"
	"os"

	"forum/internal/handlers"
	"forum/internal/middleware"
	"forum/internal/ws"
)

const apiPrefix = "/api/v1"

func NewRouter(database *sql.DB, hub *ws.Hub) http.Handler {
	mux := http.NewServeMux()

	/*-----------
	  HANDLERS
	-----------*/
	health := handlers.NewHealthHandler()
	posts := handlers.NewPostsHandler(database)
	users := handlers.NewUsersHandler(database)
	categories := handlers.NewCategoriesHandler(database)
	wsHandler := handlers.NewWsHandler(database, hub)

	/*------------
	  MIDDLEWARE
	------------*/
	auth := middleware.Auth(database)

	frontendOrigin := os.Getenv("FRONTEND_URL")
	if frontendOrigin == "" {
		frontendOrigin = "http://localhost:3000"
	}

	/*--------
	  HEALTH
	--------*/
	mux.Handle(
		apiPrefix+"/health",
		middleware.AllowMethods(
			http.HandlerFunc(health.Health),
			http.MethodGet,
		),
	)

	/*-----------------------
	  CATEGORIES (AUTH ONLY)
	-----------------------*/
	mux.Handle(
		apiPrefix+"/categories",
		middleware.AllowMethods(
			auth(http.HandlerFunc(categories.HandleCategories)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/categories/",
		middleware.AllowMethods(
			auth(http.HandlerFunc(categories.HandleCategory)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/categories/view",
		middleware.AllowMethods(
			auth(http.HandlerFunc(categories.ListCategoriesWithPosts)),
			http.MethodGet,
		),
	)

	/*-------------
	  POSTS DRAFT
	-------------*/
	mux.Handle(
		apiPrefix+"/posts/draft",
		middleware.AllowMethods(
			auth(http.HandlerFunc(posts.HandleDraft)),
			http.MethodGet,
			http.MethodPost,
		),
	)

	mux.Handle(
		apiPrefix+"/posts/draft/",
		middleware.AllowMethods(
			auth(http.HandlerFunc(posts.HandleDraftByID)),
			http.MethodPut,
			http.MethodDelete,
		),
	)

	/*-------------------
	  POSTS COLLECTION
	-------------------*/
	mux.HandleFunc(apiPrefix+"/posts", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			auth(http.HandlerFunc(posts.HandlePosts)).ServeHTTP(w, r)
		case http.MethodPost:
			auth(http.HandlerFunc(posts.HandlePosts)).ServeHTTP(w, r)
		default:
			handlers.MethodNotAllowed(w, r)
		}
	})

	/*------------------------------------
	  POSTS ITEM + COMMENTS + REACTIONS
	------------------------------------*/
	mux.HandleFunc(apiPrefix+"/posts/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			auth(http.HandlerFunc(posts.HandlePost)).ServeHTTP(w, r)
		case http.MethodPost, http.MethodPatch, http.MethodDelete:
			auth(http.HandlerFunc(posts.HandlePost)).ServeHTTP(w, r)
		default:
			handlers.MethodNotAllowed(w, r)
		}
	})

	/*-------------
	  USER POSTS
	-------------*/
	mux.Handle(
		apiPrefix+"/posts/mine",
		middleware.AllowMethods(
			auth(http.HandlerFunc(posts.ListMyPosts)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/posts/liked",
		middleware.AllowMethods(
			auth(http.HandlerFunc(posts.ListLikedPosts)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/posts/disliked",
		middleware.AllowMethods(
			auth(http.HandlerFunc(posts.ListDislikedPosts)),
			http.MethodGet,
		),
	)

	/*---------
	   USERS
	---------*/
	mux.Handle(
		apiPrefix+"/users/register",
		middleware.AllowMethods(
			http.HandlerFunc(users.Register),
			http.MethodPost,
		),
	)

	mux.Handle(
		apiPrefix+"/users/login",
		middleware.AllowMethods(
			http.HandlerFunc(users.Login),
			http.MethodPost,
		),
	)

	mux.Handle(
		apiPrefix+"/users/logout",
		middleware.AllowMethods(
			auth(http.HandlerFunc(users.Logout)),
			http.MethodPost,
		),
	)

	mux.Handle(
		apiPrefix+"/users/me",
		middleware.AllowMethods(
			auth(http.HandlerFunc(users.Me)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/users/activity",
		middleware.AllowMethods(
			auth(http.HandlerFunc(users.GetUserActivity)),
			http.MethodGet,
		),
	)

	mux.Handle(
		apiPrefix+"/users/",
		middleware.AllowMethods(
			auth(http.HandlerFunc(users.HandleUser)),
			http.MethodGet,
		),
	)

	/*---------------------------
	  COMMENTS ITEM + REACTIONS
	---------------------------*/
	mux.HandleFunc(apiPrefix+"/comments/", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			auth(http.HandlerFunc(posts.HandleComment)).ServeHTTP(w, r)
		case http.MethodPost, http.MethodPatch, http.MethodDelete:
			auth(http.HandlerFunc(posts.HandleComment)).ServeHTTP(w, r)
		default:
			handlers.MethodNotAllowed(w, r)
		}
	})

	/*---------------
	  NOTIFICATIONS (AUTH REQUIRED)
	---------------*/
	notifications := handlers.NewNotificationsHandler(database)

	// GET collection
	mux.Handle(
		apiPrefix+"/notifications",
		middleware.AllowMethods(
			auth(http.HandlerFunc(notifications.HandleNotifications)),
			http.MethodGet,
		),
	)

	// PATCH item + read-all
	mux.Handle(
		apiPrefix+"/notifications/",
		middleware.AllowMethods(
			auth(http.HandlerFunc(notifications.HandleNotifications)),
			http.MethodPatch,
		),
	)

	/*-------------------------
	  CHATS
	-------------------------*/
	chats := handlers.NewChatsHandler(database, hub)
	mux.Handle(
		apiPrefix+"/chats",
		middleware.AllowMethods(
			auth(http.HandlerFunc(chats.HandleChatRoster)),
			http.MethodGet,
		),
	)
	// GET  /chats/{userID}/messages → history
	// POST /chats/{userID}/images   → DM image upload (C09)
	mux.Handle(
		apiPrefix+"/chats/",
		middleware.AllowMethods(
			auth(http.HandlerFunc(chats.HandleChatMessages)),
			http.MethodGet,
			http.MethodPost,
		),
	)

	/*-------------------------
	  WEBSOCKET
	-------------------------*/
	mux.HandleFunc("/ws", wsHandler.HandleWebSocket)

	/*-------------------------
	  API FALLBACK (JSON 404)
	-------------------------*/
	mux.HandleFunc("/api", notFoundJSON)
	mux.HandleFunc("/api/", notFoundJSON)

	/*-----------------------------
	  STATIC ERROR PAGES
	-----------------------------*/
	mux.Handle(
		"/errors/",
		http.StripPrefix(
			"/errors/",
			http.FileServer(http.Dir("./web/errors")),
		),
	)

	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./web/static/favicon.ico")
	})

	return addMiddlewares(mux, frontendOrigin)
}

func notFoundJSON(w http.ResponseWriter, r *http.Request) {
	handlers.WriteError(
		w,
		r,
		handlers.NewError("NOT_FOUND", "route not found", http.StatusNotFound),
	)
}

func addMiddlewares(handler http.Handler, frontendOrigin string) http.Handler {
	handler = middleware.EnableCORS(frontendOrigin)(handler)
	handler = middleware.Logger(handler)
	handler = middleware.Recoverer(handler)
	return handler
}
