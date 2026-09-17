// cmd/backend/server.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"forum/internal/db"
	"forum/internal/env"
	"forum/internal/router"
	"forum/internal/ws"
)

const addr = ":8080"

func Start() {
	/* ----------------------------
	   Load environment variables
	-----------------------------*/
	env.LoadEnv(".env")

	/* ------------------------------------
	   Resolve DB path (local & Docker)
	-------------------------------------*/
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./data/forum.db"
	}

	/* ----------------------------
	   Initialize database
	-----------------------------*/
	database, err := db.InitDB(context.Background(), dbPath)
	if err != nil {
		log.Fatal("DATABASE INIT ERROR:", err)
	}
	defer database.Close()

	log.Println("Database initialized at", dbPath)

	/* ----------------------------
	   Background session cleanup
	-----------------------------*/
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()

		for range ticker.C {
			if err := db.CleanupSessions(context.Background(), database); err != nil {
				log.Println("Session cleanup error:", err)
			}
		}
	}()

	/* ----------------------------
	   WebSocket Hub
	-----------------------------*/
	hub := ws.NewHub()

	// Push notifications down the socket the client already has open, so the
	// SPA does not have to poll GET /notifications every few seconds to find
	// out that nothing has happened.
	db.SetNotificationHook(hub.NotifyNotification)

	/* ----------------------------
	   HTTP server
	-----------------------------*/
	handler := router.NewRouter(database, hub)

	log.Println("Server running on http://localhost" + addr)

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal("SERVER ERROR:", err)
	}
}
