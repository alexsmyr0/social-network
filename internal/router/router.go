// internal/router/router.go
package router

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"strings"

	"forum/internal/db"
	"forum/internal/handlers"
	"forum/internal/middleware"
	"forum/internal/ws"
)

const apiPrefix = "/api/v1"

func NewRouter(database *sql.DB, hub *ws.Hub) http.Handler {
	mux := http.NewServeMux()
	socialSchema, _ := db.IsSocialSchema(context.Background(), database)

	/*-----------
	  HANDLERS
	-----------*/
	health := handlers.NewHealthHandler()
	posts := handlers.NewPostsHandler(database)
	users := handlers.NewUsersHandler(database, hub)
	categories := handlers.NewCategoriesHandler(database)
	wsHandler := handlers.NewWsHandler(database, hub, socialSchema)

	/*------------
	  MIDDLEWARE
	------------*/
	auth := middleware.Auth(database, hub)

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

	if socialSchema {
		socialRoute := func(path string, fn http.HandlerFunc, method string) {
			mux.Handle(apiPrefix+path, middleware.AllowMethods(auth(fn), method))
		}
		socialRoute("/users", users.People, http.MethodGet)
		socialRoute("/users/me/privacy", users.Privacy, http.MethodPatch)
		socialRoute("/users/me/follow-requests", users.IncomingFollowRequests, http.MethodGet)
		socialRoute("/follows", users.Follow, http.MethodPost)
		socialRoute("/follows/", users.RemoveFollow, http.MethodDelete)
		socialRoute("/follow-requests/", users.DecideFollow, http.MethodPatch)

		groups := handlers.NewGroupsHandler(database)
		groupRoute := func(path string, fn http.HandlerFunc, methods ...string) {
			mux.Handle(apiPrefix+path, middleware.AllowMethods(auth(fn), methods...))
		}
		groupRoute("/groups", groups.Groups, http.MethodGet, http.MethodPost)
		groupRoute("/groups/", groups.GroupItem, http.MethodGet, http.MethodPost)
		groupRoute("/group-invitations/", groups.DecideInvitation, http.MethodPatch)
		groupRoute("/group-join-requests/", groups.DecideJoinRequest, http.MethodPatch)
		groupRoute("/group-memberships/", groups.RemoveMembership, http.MethodDelete)
		groupRoute("/users/me/group-invitations", groups.MyInvitations, http.MethodGet)
	}

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

	logoutHandler := http.Handler(http.HandlerFunc(users.Logout))
	if !socialSchema {
		logoutHandler = auth(logoutHandler)
	}
	mux.Handle(
		apiPrefix+"/users/logout",
		middleware.AllowMethods(
			logoutHandler,
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
	notifications := handlers.NewNotificationsHandler(database, socialSchema)

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

	var routes http.Handler = mux
	if socialSchema {
		protected := auth(handlers.MediaHandler(database))
		routes = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if db.IsMediaRequestPath(r.URL.EscapedPath()) {
				protected.ServeHTTP(w, r)
				return
			}
			mux.ServeHTTP(w, r)
		})
	}
	return addMiddlewares(routes, frontendOrigin, socialSchema)
}

func notFoundJSON(w http.ResponseWriter, r *http.Request) {
	handlers.WriteError(
		w,
		r,
		handlers.NewError("NOT_FOUND", "route not found", http.StatusNotFound),
	)
}

func addMiddlewares(handler http.Handler, frontendOrigin string, socialSchema bool) http.Handler {
	if socialSchema {
		next := handler
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, apiPrefix+"/") || db.IsMediaRequestPath(r.URL.EscapedPath()) || strings.HasPrefix(r.URL.Path, apiPrefix+"/users/") || r.URL.Path == apiPrefix+"/users" || strings.HasPrefix(r.URL.Path, apiPrefix+"/notifications") || strings.HasPrefix(r.URL.Path, apiPrefix+"/follows") || strings.HasPrefix(r.URL.Path, apiPrefix+"/follow-requests/") {
				w.Header().Set("Cache-Control", "no-store")
			}
			methods := handlers.DiscussionMethods(r.URL.Path)
			if methods == "" {
				methods = handlers.PublishingMethods(r.URL.Path)
			}
			if methods == "" {
				methods = handlers.GroupMethods(r.URL.Path)
			}
			if methods != "" && !strings.Contains(", "+methods+", ", ", "+r.Method+", ") {
				w.Header().Set("Allow", methods)
				handlers.WriteError(w, r, handlers.NewError("METHOD_NOT_ALLOWED", "method not allowed", 405))
				return
			}
			if method := socialContractMethod(r.URL.Path); method != "" && r.Method != method {
				w.Header().Set("Allow", method)
				handlers.WriteError(w, r, handlers.NewError("METHOD_NOT_ALLOWED", "method not allowed", http.StatusMethodNotAllowed))
				return
			}

			if strings.HasPrefix(r.URL.Path, apiPrefix+"/") &&
				(r.Method == http.MethodPost || r.Method == http.MethodPut ||
					r.Method == http.MethodPatch || r.Method == http.MethodDelete) {
				if !middleware.BrowserOriginAllowed(r, frontendOrigin, true) {
					handlers.WriteError(w, r, handlers.NewError("ORIGIN_FORBIDDEN", "forbidden origin", http.StatusForbidden))
					return
				}
				if values := r.Header.Values("X-Requested-With"); len(values) != 1 || values[0] != "XMLHttpRequest" {
					handlers.WriteError(w, r, handlers.NewError("CSRF_CHECK_FAILED", "missing request header", http.StatusForbidden))
					return
				}
			}
			next.ServeHTTP(w, r)
		})
	}
	handler = middleware.EnableCORS(frontendOrigin)(handler)
	handler = middleware.Logger(handler)
	handler = middleware.Recoverer(handler)
	return handler
}

// The contract validates methods before Origin/header checks on its new routes.
func socialContractMethod(path string) string {
	switch path {
	case apiPrefix + "/users", apiPrefix + "/users/me/follow-requests", apiPrefix + "/notifications":
		return http.MethodGet
	case apiPrefix + "/users/me/privacy":
		return http.MethodPatch
	case apiPrefix + "/follows":
		return http.MethodPost
	}
	if strings.HasPrefix(path, apiPrefix+"/notifications/") {
		return http.MethodPatch
	}
	if strings.HasPrefix(path, apiPrefix+"/follows/") {
		return http.MethodDelete
	}
	if strings.HasPrefix(path, apiPrefix+"/follow-requests/") {
		return http.MethodPatch
	}
	if strings.HasPrefix(path, apiPrefix+"/users/") {
		parts := strings.Split(strings.TrimPrefix(path, apiPrefix+"/users/"), "/")
		if len(parts) == 2 && (parts[1] == "profile" || parts[1] == "followers" || parts[1] == "following" || parts[1] == "avatar") {
			return http.MethodGet
		}
	}
	return ""
}
